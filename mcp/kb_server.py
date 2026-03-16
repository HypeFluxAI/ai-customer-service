#!/usr/bin/env python3
"""知识库 MCP Server — 为 Gemini CLI 提供知识库检索/写入能力

通过 Model Context Protocol (MCP) 暴露知识库操作，
让 Gemini CLI 的 AI Agent 能够直接搜索和管理客服知识库。

启动方式:
  python mcp/kb_server.py
  或在 Gemini CLI settings.json 中配置
"""

import json
import sys
import os
import hashlib
from datetime import datetime
from pathlib import Path

# 项目根目录
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import yaml

# 加载配置
with open(ROOT / "config.yaml", "r", encoding="utf-8") as f:
    CONFIG = yaml.safe_load(f)

KB_CFG = CONFIG["knowledge"]

# MCP 协议: 使用 stdio 通信，JSON-RPC 2.0
# 参考: https://modelcontextprotocol.io/specification


def get_store():
    """懒加载知识库（避免启动时就加载模型）"""
    if not hasattr(get_store, "_instance"):
        from knowledge.store import KnowledgeStore
        get_store._instance = KnowledgeStore(
            persist_dir=str(ROOT / KB_CFG["chromadb_path"]),
            embedding_model=KB_CFG.get("embedding_model"),
        )
    return get_store._instance


def get_chunker():
    """懒加载分块器"""
    if not hasattr(get_chunker, "_instance"):
        from knowledge.chunker import TextChunker
        get_chunker._instance = TextChunker(
            chunk_size=KB_CFG.get("chunk_size", 500),
            chunk_overlap=KB_CFG.get("chunk_overlap", 50),
        )
    return get_chunker._instance


# ── MCP Tool 定义 ──────────────────────────────────────────────

TOOLS = [
    {
        "name": "kb_search",
        "description": "搜索客服知识库。输入用户问题或关键词，返回最相关的知识条目。用于回答客户咨询时检索参考信息。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "搜索查询（客户问题或关键词）"
                },
                "n_results": {
                    "type": "integer",
                    "description": "返回结果数量，默认 5",
                    "default": 5
                }
            },
            "required": ["query"]
        }
    },
    {
        "name": "kb_teach",
        "description": "向知识库添加一条 Q&A 知识。用于训练客服系统，教会它如何回答特定问题。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "客户可能会问的问题"
                },
                "answer": {
                    "type": "string",
                    "description": "标准回答"
                }
            },
            "required": ["question", "answer"]
        }
    },
    {
        "name": "kb_correct",
        "description": "纠正知识库中的错误回答。提供原始问题和正确答案，系统会学习正确的回复。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "客户问题"
                },
                "wrong_answer": {
                    "type": "string",
                    "description": "之前的错误回答"
                },
                "correct_answer": {
                    "type": "string",
                    "description": "正确的回答"
                }
            },
            "required": ["question", "correct_answer"]
        }
    },
    {
        "name": "kb_add_document",
        "description": "向知识库添加一段文档内容。系统会自动分块并建立索引。用于批量添加产品文档、FAQ 等。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": "文档内容文本"
                },
                "source": {
                    "type": "string",
                    "description": "来源标识（如文件名或 URL）",
                    "default": "manual_input"
                }
            },
            "required": ["content"]
        }
    },
    {
        "name": "kb_stats",
        "description": "查看知识库统计信息：主知识库条目数、自学习条目数等。",
        "inputSchema": {
            "type": "object",
            "properties": {}
        }
    },
    {
        "name": "kb_delete_source",
        "description": "删除指定来源的所有知识条目。用于清理过时或错误的批量导入内容。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "source_file": {
                    "type": "string",
                    "description": "要删除的来源标识"
                }
            },
            "required": ["source_file"]
        }
    },
    {
        "name": "kb_import_file",
        "description": "从文件导入知识库内容。支持 PDF, DOCX, TXT, Markdown, CSV, Excel, JSON 格式。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "文件路径（绝对路径或相对于项目根目录）"
                }
            },
            "required": ["file_path"]
        }
    },
]

# ── MCP Tool 处理 ──────────────────────────────────────────────

def handle_kb_search(args: dict) -> str:
    store = get_store()
    query = args["query"]
    n = args.get("n_results", 5)
    results = store.search(query, n_results=n)

    if not results:
        return json.dumps({"results": [], "message": "未找到相关知识"}, ensure_ascii=False)

    output = []
    for r in results:
        output.append({
            "text": r["text"],
            "source": r.get("metadata", {}).get("source_file", r["source"]),
            "distance": round(r["distance"], 4),
            "priority": r["priority"],
        })
    return json.dumps({"results": output, "count": len(output)}, ensure_ascii=False)


def handle_kb_teach(args: dict) -> str:
    store = get_store()
    q = args["question"]
    a = args["answer"]

    store.add_learned(
        question=q,
        answer=a,
        metadata={
            "source": "gemini_cli_training",
            "trained_at": datetime.now().isoformat(),
        }
    )

    # 记录训练日志
    log_training("teach", {"question": q, "answer": a})
    return json.dumps({"status": "ok", "message": f"已学习: {q[:50]}..."}, ensure_ascii=False)


def handle_kb_correct(args: dict) -> str:
    store = get_store()
    q = args["question"]
    correct_a = args["correct_answer"]
    wrong_a = args.get("wrong_answer", "")

    store.add_learned(
        question=q,
        answer=correct_a,
        metadata={
            "source": "gemini_cli_correction",
            "original_answer": wrong_a,
            "corrected_at": datetime.now().isoformat(),
        }
    )

    log_training("correct", {
        "question": q,
        "wrong_answer": wrong_a,
        "correct_answer": correct_a,
    })
    return json.dumps({"status": "ok", "message": "已纠正并学习"}, ensure_ascii=False)


def handle_kb_add_document(args: dict) -> str:
    store = get_store()
    chunker = get_chunker()
    content = args["content"]
    source = args.get("source", "manual_input")

    chunks = chunker.split(content)
    metadatas = [{"source_file": source, "chunk_index": i} for i in range(len(chunks))]
    store.add_documents(chunks, metadatas)

    return json.dumps({
        "status": "ok",
        "chunks_added": len(chunks),
        "source": source,
    }, ensure_ascii=False)


def handle_kb_stats(args: dict) -> str:
    store = get_store()
    return json.dumps({
        "kb_count": store.kb_count,
        "learned_count": store.learned_count,
        "total": store.kb_count + store.learned_count,
    }, ensure_ascii=False)


def handle_kb_delete_source(args: dict) -> str:
    store = get_store()
    source = args["source_file"]
    store.delete_by_source(source)
    return json.dumps({"status": "ok", "message": f"已删除来源: {source}"}, ensure_ascii=False)


def handle_kb_import_file(args: dict) -> str:
    store = get_store()
    chunker = get_chunker()
    file_path = args["file_path"]

    # 处理相对路径
    p = Path(file_path)
    if not p.is_absolute():
        p = ROOT / p

    if not p.exists():
        return json.dumps({"status": "error", "message": f"文件不存在: {p}"}, ensure_ascii=False)

    from knowledge.importer import import_file
    items = import_file(str(p))

    all_chunks = []
    all_metas = []
    for text, meta in items:
        chunks = chunker.split(text)
        for i, chunk in enumerate(chunks):
            all_chunks.append(chunk)
            m = dict(meta)
            m["chunk_index"] = i
            all_metas.append(m)

    if all_chunks:
        store.add_documents(all_chunks, all_metas)

    return json.dumps({
        "status": "ok",
        "file": str(p.name),
        "chunks_added": len(all_chunks),
    }, ensure_ascii=False)


TOOL_HANDLERS = {
    "kb_search": handle_kb_search,
    "kb_teach": handle_kb_teach,
    "kb_correct": handle_kb_correct,
    "kb_add_document": handle_kb_add_document,
    "kb_stats": handle_kb_stats,
    "kb_delete_source": handle_kb_delete_source,
    "kb_import_file": handle_kb_import_file,
}


def log_training(event: str, data: dict):
    """记录训练日志"""
    log_dir = ROOT / "data" / "training"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"gemini_train_{datetime.now():%Y%m%d}.jsonl"

    entry = {
        "ts": datetime.now().isoformat(),
        "event": event,
        "data": data,
    }
    with open(log_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


# ── MCP stdio 协议实现 ──────────────────────────────────────────

def send_response(response: dict):
    """发送 JSON-RPC 响应到 stdout"""
    msg = json.dumps(response, ensure_ascii=False)
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def handle_request(request: dict) -> dict:
    """处理 JSON-RPC 请求"""
    method = request.get("method", "")
    req_id = request.get("id")
    params = request.get("params", {})

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {"listChanged": False},
                },
                "serverInfo": {
                    "name": "deeplink-kb",
                    "version": "1.0.0",
                },
            }
        }

    elif method == "notifications/initialized":
        return None  # 通知无需响应

    elif method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "tools": TOOLS,
            }
        }

    elif method == "tools/call":
        tool_name = params.get("name", "")
        tool_args = params.get("arguments", {})

        handler = TOOL_HANDLERS.get(tool_name)
        if not handler:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": f"Unknown tool: {tool_name}"}],
                    "isError": True,
                }
            }

        try:
            result_text = handler(tool_args)
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": result_text}],
                    "isError": False,
                }
            }
        except Exception as e:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": f"Error: {e}"}],
                    "isError": True,
                }
            }

    elif method == "ping":
        return {"jsonrpc": "2.0", "id": req_id, "result": {}}

    else:
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {
                "code": -32601,
                "message": f"Method not found: {method}",
            }
        }


def main():
    """MCP Server 主循环 — 读取 stdin，处理请求，写入 stdout"""
    # 禁止 Python 库在 stdout 输出无关内容
    import logging
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue

        response = handle_request(request)
        if response is not None:
            send_response(response)


if __name__ == "__main__":
    main()
