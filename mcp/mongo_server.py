#!/usr/bin/env python3
"""MongoDB MCP Server — 为 Gemini CLI 提供 MongoDB 数据库查询/管理能力

通过 Model Context Protocol (MCP) 暴露 MongoDB 操作，
让 Gemini CLI 的 AI Agent 能够直接查询聊天记录、管理知识库、分析质量。

启动方式:
  python mcp/mongo_server.py
  或在 Gemini CLI settings.json 中配置
"""

import json
import sys
import os
import logging
from datetime import datetime, timedelta
from pathlib import Path
from collections import Counter

# 项目根目录
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# 加载 .env
from dotenv import load_dotenv
load_dotenv(ROOT / ".env")

import pymongo
from bson import ObjectId
from bson.json_util import default as bson_default


# ── MongoDB 连接 ──────────────────────────────────────────────

def get_db():
    """懒加载 MongoDB 连接"""
    if not hasattr(get_db, "_db"):
        uri = os.getenv("MONGO_URI", "mongodb://localhost:27017/ai-customer-service")
        client = pymongo.MongoClient(uri)
        # 从 URI 提取数据库名，若无则用默认
        db_name = pymongo.uri_parser.parse_uri(uri).get("database") or "ai-customer-service"
        get_db._db = client[db_name]
    return get_db._db


def json_serialize(obj):
    """JSON 序列化，处理 ObjectId / datetime 等 BSON 类型"""
    if isinstance(obj, ObjectId):
        return str(obj)
    if isinstance(obj, datetime):
        return obj.isoformat()
    return bson_default(obj)


def to_json(data) -> str:
    return json.dumps(data, default=json_serialize, ensure_ascii=False)


# ── MCP Tool 定义 ──────────────────────────────────────────────

TOOLS = [
    {
        "name": "chat_logs_query",
        "description": "查询最近的聊天消息记录。可按天数范围和关键词过滤。用于了解客户常见问题和客服对话情况。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "days": {
                    "type": "integer",
                    "description": "查询最近几天的记录，默认 7",
                    "default": 7
                },
                "limit": {
                    "type": "integer",
                    "description": "最多返回条数，默认 100",
                    "default": 100
                },
                "keyword": {
                    "type": "string",
                    "description": "按关键词过滤消息内容（可选）"
                }
            }
        }
    },
    {
        "name": "chat_stats",
        "description": "分析聊天统计数据：会话数、消息数、热门问题、未回复率、高峰时段等。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "days": {
                    "type": "integer",
                    "description": "统计最近几天，默认 7",
                    "default": 7
                }
            }
        }
    },
    {
        "name": "kb_list",
        "description": "列出 MongoDB 知识库条目，支持按语言、来源过滤。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "language": {
                    "type": "string",
                    "description": "语言筛选，默认 ko",
                    "default": "ko"
                },
                "active_only": {
                    "type": "boolean",
                    "description": "仅显示启用的条目，默认 true",
                    "default": True
                },
                "source": {
                    "type": "string",
                    "description": "按来源过滤（可选）"
                }
            }
        }
    },
    {
        "name": "kb_add",
        "description": "向 MongoDB 知识库添加一条知识条目。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "知识条目标题"
                },
                "keywords": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "关键词列表"
                },
                "content": {
                    "type": "string",
                    "description": "知识内容（HTML 或纯文本）"
                },
                "language": {
                    "type": "string",
                    "description": "语言代码，默认 ko",
                    "default": "ko"
                }
            },
            "required": ["title", "keywords", "content"]
        }
    },
    {
        "name": "kb_update",
        "description": "更新已有的 MongoDB 知识库条目。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {
                    "type": "string",
                    "description": "知识条目 ID（MongoDB ObjectId）"
                },
                "title": {
                    "type": "string",
                    "description": "新标题（可选）"
                },
                "content": {
                    "type": "string",
                    "description": "新内容（可选）"
                },
                "keywords": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "新关键词列表（可选）"
                }
            },
            "required": ["id"]
        }
    },
    {
        "name": "kb_delete",
        "description": "删除（停用）一条 MongoDB 知识库条目。设置 isActive=false 进行软删除。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {
                    "type": "string",
                    "description": "知识条目 ID（MongoDB ObjectId）"
                }
            },
            "required": ["id"]
        }
    },
    {
        "name": "qna_list",
        "description": "列出多语言 Q&A 对。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "language": {
                    "type": "string",
                    "description": "显示语言，默认 ko",
                    "default": "ko"
                }
            }
        }
    },
    {
        "name": "qna_add",
        "description": "添加一组多语言 Q&A 对。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "question": {
                    "type": "object",
                    "description": "问题 {ko, zh, en}",
                    "properties": {
                        "ko": {"type": "string"},
                        "zh": {"type": "string"},
                        "en": {"type": "string"}
                    }
                },
                "answer": {
                    "type": "object",
                    "description": "回答 {ko, zh, en}",
                    "properties": {
                        "ko": {"type": "string"},
                        "zh": {"type": "string"},
                        "en": {"type": "string"}
                    }
                }
            },
            "required": ["question", "answer"]
        }
    },
    {
        "name": "ai_quality_report",
        "description": "生成 AI 回复质量分析报告：建议数、平均相似度、质量分布、改进方向。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "days": {
                    "type": "integer",
                    "description": "分析最近几天，默认 7",
                    "default": 7
                }
            }
        }
    },
    {
        "name": "frequent_questions",
        "description": "查找知识库未覆盖的高频问题。分析聊天记录，分组相似问题，检查知识库覆盖率。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "days": {
                    "type": "integer",
                    "description": "分析最近几天，默认 7",
                    "default": 7
                },
                "limit": {
                    "type": "integer",
                    "description": "返回数量，默认 20",
                    "default": 20
                }
            }
        }
    },
    {
        "name": "training_log",
        "description": "查看训练历史记录（teach/correct/chat 等类型）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "days": {
                    "type": "integer",
                    "description": "查看最近几天，默认 7",
                    "default": 7
                },
                "type": {
                    "type": "string",
                    "description": "训练类型过滤：teach, correct, chat（可选）"
                }
            }
        }
    },
]


# ── MCP Tool 处理函数 ──────────────────────────────────────────

def handle_chat_logs_query(args: dict) -> str:
    db = get_db()
    days = args.get("days", 7)
    limit = args.get("limit", 100)
    keyword = args.get("keyword")

    since = datetime.utcnow() - timedelta(days=days)
    query = {"timestamp": {"$gte": since}}

    if keyword:
        query["text"] = {"$regex": keyword, "$options": "i"}

    messages = list(
        db.chat_messages
        .find(query)
        .sort("timestamp", -1)
        .limit(limit)
    )

    # 收集关联的 sessionId
    session_ids = list({m.get("sessionId") for m in messages if m.get("sessionId")})
    sessions = {}
    if session_ids:
        for s in db.chat_sessions.find({"_id": {"$in": session_ids}}):
            sessions[str(s["_id"])] = {
                "channel": s.get("channel"),
                "status": s.get("status"),
                "visitorToken": s.get("visitorToken"),
            }

    results = []
    for m in messages:
        entry = {
            "id": str(m["_id"]),
            "sessionId": str(m.get("sessionId", "")),
            "sender": m.get("sender"),
            "text": m.get("text", ""),
            "timestamp": m.get("timestamp"),
        }
        if m.get("imageUrl"):
            entry["imageUrl"] = m["imageUrl"]
        sid = str(m.get("sessionId", ""))
        if sid in sessions:
            entry["session"] = sessions[sid]
        results.append(entry)

    return to_json({
        "count": len(results),
        "days": days,
        "results": results,
    })


def handle_chat_stats(args: dict) -> str:
    db = get_db()
    days = args.get("days", 7)
    since = datetime.utcnow() - timedelta(days=days)

    # 总消息数
    total_messages = db.chat_messages.count_documents({"timestamp": {"$gte": since}})

    # 总会话数
    total_sessions = db.chat_sessions.count_documents({"lastMessageTime": {"$gte": since}})

    # 发送者分布
    sender_pipeline = [
        {"$match": {"timestamp": {"$gte": since}}},
        {"$group": {"_id": "$sender", "count": {"$sum": 1}}},
    ]
    sender_stats = {r["_id"]: r["count"] for r in db.chat_messages.aggregate(sender_pipeline)}

    # 高峰时段
    hour_pipeline = [
        {"$match": {"timestamp": {"$gte": since}}},
        {"$group": {
            "_id": {"$hour": "$timestamp"},
            "count": {"$sum": 1}
        }},
        {"$sort": {"count": -1}},
        {"$limit": 5},
    ]
    peak_hours = [
        {"hour": r["_id"], "count": r["count"]}
        for r in db.chat_messages.aggregate(hour_pipeline)
    ]

    # 访客消息中的高频词（简易版：取访客消息文本）
    visitor_msgs_cursor = db.chat_messages.find(
        {"timestamp": {"$gte": since}, "sender": "visitor"},
        {"text": 1}
    ).limit(500)
    visitor_texts = [m.get("text", "") for m in visitor_msgs_cursor]

    # 简单词频统计（按整条消息统计，AI 端可进一步分析）
    question_counter = Counter()
    for t in visitor_texts:
        if t and len(t) > 3:
            question_counter[t.strip()] += 1
    top_questions = [{"question": q, "count": c} for q, c in question_counter.most_common(10)]

    # 未回复率：有访客消息但无 admin/ai 回复的会话
    unanswered_sessions = db.chat_sessions.count_documents({
        "lastMessageTime": {"$gte": since},
        "status": "waiting",
    })
    unanswered_rate = round(unanswered_sessions / max(total_sessions, 1) * 100, 1)

    return to_json({
        "days": days,
        "total_sessions": total_sessions,
        "total_messages": total_messages,
        "sender_distribution": sender_stats,
        "peak_hours": peak_hours,
        "top_questions": top_questions,
        "unanswered_sessions": unanswered_sessions,
        "unanswered_rate_pct": unanswered_rate,
    })


def handle_kb_list(args: dict) -> str:
    db = get_db()
    language = args.get("language", "ko")
    active_only = args.get("active_only", True)
    source = args.get("source")

    query = {"language": language}
    if active_only:
        query["isActive"] = True
    if source:
        query["source"] = source

    entries = list(
        db.knowledge_bases
        .find(query)
        .sort("updatedAt", -1)
        .limit(200)
    )

    results = []
    for e in entries:
        content_preview = (e.get("contentHtml") or "")[:200]
        results.append({
            "id": str(e["_id"]),
            "title": e.get("title", ""),
            "keywords": e.get("keywords", []),
            "content_preview": content_preview,
            "source": e.get("source"),
            "reviewStatus": e.get("reviewStatus"),
            "qualityScore": e.get("qualityScore"),
            "referenceCount": e.get("referenceCount", 0),
            "isActive": e.get("isActive"),
            "createdAt": e.get("createdAt"),
            "updatedAt": e.get("updatedAt"),
        })

    return to_json({"count": len(results), "language": language, "entries": results})


def handle_kb_add(args: dict) -> str:
    db = get_db()
    now = datetime.utcnow()

    doc = {
        "title": args["title"],
        "keywords": args.get("keywords", []),
        "contentHtml": args["content"],
        "language": args.get("language", "ko"),
        "isActive": True,
        "source": "gemini_cli",
        "reviewStatus": "approved",
        "referenceCount": 0,
        "qualityScore": None,
        "createdAt": now,
        "updatedAt": now,
    }

    result = db.knowledge_bases.insert_one(doc)
    return to_json({
        "status": "ok",
        "id": str(result.inserted_id),
        "message": f"已添加知识条目: {args['title']}",
    })


def handle_kb_update(args: dict) -> str:
    db = get_db()
    entry_id = args["id"]
    update_fields = {}

    if "title" in args:
        update_fields["title"] = args["title"]
    if "content" in args:
        update_fields["contentHtml"] = args["content"]
    if "keywords" in args:
        update_fields["keywords"] = args["keywords"]

    if not update_fields:
        return to_json({"status": "error", "message": "未提供要更新的字段"})

    update_fields["updatedAt"] = datetime.utcnow()

    result = db.knowledge_bases.update_one(
        {"_id": ObjectId(entry_id)},
        {"$set": update_fields}
    )

    if result.matched_count == 0:
        return to_json({"status": "error", "message": f"未找到条目: {entry_id}"})

    return to_json({
        "status": "ok",
        "message": f"已更新条目: {entry_id}",
        "modified": result.modified_count,
    })


def handle_kb_delete(args: dict) -> str:
    db = get_db()
    entry_id = args["id"]

    result = db.knowledge_bases.update_one(
        {"_id": ObjectId(entry_id)},
        {"$set": {"isActive": False, "updatedAt": datetime.utcnow()}}
    )

    if result.matched_count == 0:
        return to_json({"status": "error", "message": f"未找到条目: {entry_id}"})

    return to_json({
        "status": "ok",
        "message": f"已停用条目: {entry_id}",
    })


def handle_qna_list(args: dict) -> str:
    db = get_db()
    language = args.get("language", "ko")

    entries = list(
        db.qnas
        .find({"isActive": {"$ne": False}})
        .sort("order", 1)
    )

    results = []
    for e in entries:
        q = e.get("question", {})
        a = e.get("answer", {})
        results.append({
            "id": str(e["_id"]),
            "question": q.get(language, q.get("ko", "")),
            "answer": a.get(language, a.get("ko", "")),
            "question_all": q,
            "answer_all": a,
            "order": e.get("order"),
        })

    return to_json({"count": len(results), "language": language, "entries": results})


def handle_qna_add(args: dict) -> str:
    db = get_db()

    # 获取当前最大 order
    last = db.qnas.find_one(sort=[("order", -1)])
    next_order = (last.get("order", 0) + 1) if last else 1

    doc = {
        "question": args["question"],
        "answer": args["answer"],
        "isActive": True,
        "order": next_order,
    }

    result = db.qnas.insert_one(doc)
    return to_json({
        "status": "ok",
        "id": str(result.inserted_id),
        "order": next_order,
        "message": "已添加 Q&A 对",
    })


def handle_ai_quality_report(args: dict) -> str:
    db = get_db()
    days = args.get("days", 7)
    since = datetime.utcnow() - timedelta(days=days)

    suggestions = list(
        db.ai_suggestions.find({"createdAt": {"$gte": since}})
    )

    total = len(suggestions)
    if total == 0:
        return to_json({
            "days": days,
            "total_suggestions": 0,
            "message": "该时间段内无 AI 建议记录",
        })

    # 平均相似度
    similarities = [s.get("similarity", 0) for s in suggestions if s.get("similarity") is not None]
    avg_similarity = round(sum(similarities) / max(len(similarities), 1), 4)

    # 质量分布
    quality_scores = [s.get("qualityScore", 0) for s in suggestions if s.get("qualityScore") is not None]
    quality_breakdown = {"high": 0, "medium": 0, "low": 0}
    for qs in quality_scores:
        if qs >= 0.8:
            quality_breakdown["high"] += 1
        elif qs >= 0.5:
            quality_breakdown["medium"] += 1
        else:
            quality_breakdown["low"] += 1

    # 分类统计
    category_counter = Counter()
    for s in suggestions:
        cat = s.get("category", "unknown")
        category_counter[cat] += 1

    # 采纳率（有 adminReply 的算被参考）
    adopted = sum(1 for s in suggestions if s.get("adminReply"))
    adoption_rate = round(adopted / total * 100, 1)

    # 低质量的改进方向
    low_quality = [s for s in suggestions if (s.get("qualityScore") or 0) < 0.5]
    improvement_categories = Counter()
    for s in low_quality:
        improvement_categories[s.get("category", "unknown")] += 1

    return to_json({
        "days": days,
        "total_suggestions": total,
        "avg_similarity": avg_similarity,
        "quality_breakdown": quality_breakdown,
        "category_distribution": dict(category_counter.most_common()),
        "adoption_rate_pct": adoption_rate,
        "improvement_areas": [
            {"category": cat, "low_quality_count": cnt}
            for cat, cnt in improvement_categories.most_common(5)
        ],
    })


def handle_frequent_questions(args: dict) -> str:
    db = get_db()
    days = args.get("days", 7)
    limit = args.get("limit", 20)
    since = datetime.utcnow() - timedelta(days=days)

    # 获取访客消息
    visitor_msgs = list(
        db.chat_messages.find(
            {"timestamp": {"$gte": since}, "sender": "visitor", "text": {"$exists": True}},
            {"text": 1}
        ).limit(2000)
    )

    # 按消息文本分组计数
    question_counter = Counter()
    for m in visitor_msgs:
        text = (m.get("text") or "").strip()
        if len(text) > 3:  # 跳过过短消息
            question_counter[text] += 1

    # 获取已有知识库关键词用于覆盖检查
    kb_entries = list(db.knowledge_bases.find(
        {"isActive": True},
        {"keywords": 1, "title": 1}
    ))
    kb_keywords = set()
    for e in kb_entries:
        for kw in e.get("keywords", []):
            kb_keywords.add(kw.lower())
        kb_keywords.add(e.get("title", "").lower())

    # 检查覆盖率
    results = []
    for question, count in question_counter.most_common(limit):
        q_lower = question.lower()
        covered = any(kw in q_lower for kw in kb_keywords if kw)
        results.append({
            "question": question,
            "count": count,
            "kb_covered": covered,
        })

    uncovered = sum(1 for r in results if not r["kb_covered"])

    return to_json({
        "days": days,
        "total_unique_questions": len(question_counter),
        "showing": len(results),
        "uncovered_count": uncovered,
        "questions": results,
    })


def handle_training_log(args: dict) -> str:
    days = args.get("days", 7)
    event_type = args.get("type")

    log_dir = ROOT / "data" / "training"
    if not log_dir.exists():
        return to_json({"entries": [], "message": "训练日志目录不存在"})

    since = datetime.utcnow() - timedelta(days=days)
    entries = []

    for log_file in sorted(log_dir.glob("gemini_train_*.jsonl"), reverse=True):
        # 从文件名提取日期检查范围
        try:
            date_str = log_file.stem.replace("gemini_train_", "")
            file_date = datetime.strptime(date_str, "%Y%m%d")
            if file_date < since - timedelta(days=1):
                continue
        except ValueError:
            continue

        with open(log_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue

                # 时间过滤
                ts = entry.get("ts", "")
                try:
                    entry_time = datetime.fromisoformat(ts)
                    if entry_time < since:
                        continue
                except (ValueError, TypeError):
                    pass

                # 类型过滤
                if event_type and entry.get("event") != event_type:
                    continue

                entries.append(entry)

    # 按时间倒序
    entries.sort(key=lambda e: e.get("ts", ""), reverse=True)

    return to_json({
        "days": days,
        "type_filter": event_type,
        "count": len(entries),
        "entries": entries[:200],
    })


# ── Tool 处理路由 ──────────────────────────────────────────────

TOOL_HANDLERS = {
    "chat_logs_query": handle_chat_logs_query,
    "chat_stats": handle_chat_stats,
    "kb_list": handle_kb_list,
    "kb_add": handle_kb_add,
    "kb_update": handle_kb_update,
    "kb_delete": handle_kb_delete,
    "qna_list": handle_qna_list,
    "qna_add": handle_qna_add,
    "ai_quality_report": handle_ai_quality_report,
    "frequent_questions": handle_frequent_questions,
    "training_log": handle_training_log,
}


# ── MCP stdio 协议实现 ──────────────────────────────────────────

def send_response(response: dict):
    """发送 JSON-RPC 响应到 stdout"""
    msg = json.dumps(response, default=json_serialize, ensure_ascii=False)
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
                    "name": "deeplink-mongo",
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
