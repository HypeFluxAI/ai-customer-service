#!/usr/bin/env python3
"""客服聊天 API Server — 为 Web/Telegram/外部客户端提供 HTTP 接口

架构:
  训练人员 → Gemini CLI (本地)  → MCP → ChromaDB
  客户用户 → Web/Telegram/API   → 本服务 → ChromaDB + Gemini API

启动:
  python api/chat_server.py
  python api/chat_server.py --port 8080

API:
  POST /chat          — 客户对话（自动搜索 KB + 生成回复）
  POST /teach         — [管理员] 教学
  POST /correct       — [管理员] 纠正
  GET  /search?q=     — [管理员] 搜索知识库
  GET  /stats         — 知识库统计
  GET  /health        — 健康检查
"""

import os
import sys
import json
import logging
import hashlib
import hmac
from datetime import datetime
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

# 项目根目录
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import yaml
from dotenv import load_dotenv

load_dotenv(ROOT / ".env")

# 加载配置
with open(ROOT / "config.yaml", "r", encoding="utf-8") as f:
    CONFIG = yaml.safe_load(f)

logger = logging.getLogger("ai_cs.api")

# ── 全局单例 ─────────────────────────────────────────────────

_store = None
_client = None
_safety = None


def get_store():
    global _store
    if _store is None:
        from knowledge.store import KnowledgeStore
        kb_cfg = CONFIG["knowledge"]
        _store = KnowledgeStore(
            persist_dir=str(ROOT / kb_cfg["chromadb_path"]),
            embedding_model=kb_cfg.get("embedding_model"),
        )
    return _store


def get_client():
    global _client
    if _client is None:
        import anthropic
        api_key = os.getenv("ANTHROPIC_API_KEY", "")
        if not api_key:
            # 如果没有 Anthropic key，尝试用 Gemini
            import google.generativeai as genai
            gemini_key = os.getenv("GEMINI_API_KEY", "")
            if gemini_key:
                genai.configure(api_key=gemini_key)
                _client = ("gemini", genai)
                return _client
            raise ValueError("No API key found (ANTHROPIC_API_KEY or GEMINI_API_KEY)")
        _client = ("anthropic", anthropic.Anthropic(api_key=api_key))
    return _client


def get_safety():
    global _safety
    if _safety is None:
        from response.safety import SafetyGuard
        _safety = SafetyGuard(CONFIG)
    return _safety


# ── 管理员认证 ─────────────────────────────────────────────────

ADMIN_TOKEN = os.getenv("ADMIN_API_TOKEN", "")


def is_admin(headers) -> bool:
    """检查请求是否有管理员权限"""
    if not ADMIN_TOKEN:
        return True  # 未配置 token 时默认允许（开发模式）
    auth = headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return hmac.compare_digest(auth[7:], ADMIN_TOKEN)
    return False


# ── 核心处理函数 ─────────────────────────────────────────────────

def handle_chat(body: dict) -> dict:
    """客户对话 — 搜索 KB + 生成回复"""
    message = body.get("message", "").strip()
    session_id = body.get("session_id", "default")

    if not message:
        return {"error": "message is required"}, 400

    store = get_store()
    safety = get_safety()

    # 1. 搜索知识库
    kb_results = store.search(message, n_results=5)

    # 2. 安全检查（用户消息）
    # 检查是否需要人工升级
    for kw in CONFIG.get("safety", {}).get("escalation_keywords", []):
        if kw in message:
            return {
                "reply": "담당자에게 연결해 드리겠습니다. 잠시만 기다려 주세요.",
                "escalated": True,
                "keyword": kw,
            }, 200

    # 3. 构建 KB 上下文
    if kb_results:
        kb_texts = []
        for r in kb_results[:5]:
            src = r.get("metadata", {}).get("source_file", "")
            kb_texts.append(f"[{src}] {r['text'][:300]}")
        kb_context = "\n---\n".join(kb_texts)
    else:
        kb_context = "(관련 지식 없음)"

    # 4. 生成回复
    provider, client = get_client()

    system_prompt = f"""당신은 DeepLink 고객 지원 AI 어시스턴트입니다.
친절하고 전문적인 태도로 한국어로 응답합니다.
간결하게 답변하세요 (최대 3-4문장).
확실하지 않은 정보는 추측하지 마세요.
환불, 결제 분쟁은 "담당자에게 전달하겠습니다"로 안내하세요.

참고 지식:
{kb_context}"""

    try:
        if provider == "anthropic":
            response = client.messages.create(
                model=CONFIG["analysis"]["text_model"],
                max_tokens=300,
                temperature=0.3,
                system=system_prompt,
                messages=[{"role": "user", "content": message}],
            )
            reply = response.content[0].text.strip()
        else:
            # Gemini
            model = client.GenerativeModel("gemini-2.5-pro")
            response = model.generate_content(
                f"{system_prompt}\n\n고객: {message}",
                generation_config={"temperature": 0.3, "max_output_tokens": 300},
            )
            reply = response.text.strip()
    except Exception as e:
        logger.error(f"Generation failed: {e}")
        return {"error": "generation failed"}, 500

    # 5. 安全检查（回复内容）
    allowed, reason = safety.check(reply, message)
    if not allowed:
        return {
            "reply": "죄송합니다. 담당자에게 연결해 드리겠습니다.",
            "blocked": True,
            "reason": reason,
        }, 200

    safety.record_send()

    return {
        "reply": reply,
        "kb_hits": len(kb_results),
        "session_id": session_id,
    }, 200


def handle_teach(body: dict) -> dict:
    """管理员教学"""
    q = body.get("question", "").strip()
    a = body.get("answer", "").strip()

    if not q or not a:
        return {"error": "question and answer are required"}, 400

    store = get_store()
    store.add_learned(
        question=q, answer=a,
        metadata={
            "source": "api_training",
            "trained_at": datetime.now().isoformat(),
        }
    )
    return {"status": "ok", "message": f"learned: {q[:50]}..."}, 200


def handle_correct(body: dict) -> dict:
    """管理员纠正"""
    q = body.get("question", "").strip()
    correct_a = body.get("correct_answer", "").strip()
    wrong_a = body.get("wrong_answer", "")

    if not q or not correct_a:
        return {"error": "question and correct_answer are required"}, 400

    store = get_store()
    store.add_learned(
        question=q, answer=correct_a,
        metadata={
            "source": "api_correction",
            "original_answer": wrong_a,
            "corrected_at": datetime.now().isoformat(),
        }
    )
    return {"status": "ok", "message": "corrected"}, 200


def handle_search(query: str) -> dict:
    """搜索知识库"""
    if not query:
        return {"error": "q parameter is required"}, 400

    store = get_store()
    results = store.search(query, n_results=10)

    output = []
    for r in results:
        output.append({
            "text": r["text"][:200],
            "source": r.get("metadata", {}).get("source_file", r["source"]),
            "distance": round(r["distance"], 4),
        })
    return {"results": output, "count": len(output)}, 200


def handle_stats() -> dict:
    """知识库统计"""
    store = get_store()
    return {
        "kb_count": store.kb_count,
        "learned_count": store.learned_count,
        "total": store.kb_count + store.learned_count,
    }, 200


# ── HTTP Server ─────────────────────────────────────────────────

class ChatHandler(BaseHTTPRequestHandler):
    """HTTP 请求处理"""

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        if path == "/health":
            self._json_response({"status": "ok"}, 200)

        elif path == "/stats":
            result, code = handle_stats()
            self._json_response(result, code)

        elif path == "/search":
            if not is_admin(self.headers):
                self._json_response({"error": "unauthorized"}, 401)
                return
            q = params.get("q", [""])[0]
            result, code = handle_search(q)
            self._json_response(result, code)

        else:
            self._json_response({"error": "not found"}, 404)

    def do_POST(self):
        content_len = int(self.headers.get("Content-Length", 0))
        body_raw = self.rfile.read(content_len)

        try:
            body = json.loads(body_raw) if body_raw else {}
        except json.JSONDecodeError:
            self._json_response({"error": "invalid JSON"}, 400)
            return

        path = urlparse(self.path).path

        if path == "/chat":
            result, code = handle_chat(body)
            self._json_response(result, code)

        elif path == "/teach":
            if not is_admin(self.headers):
                self._json_response({"error": "unauthorized"}, 401)
                return
            result, code = handle_teach(body)
            self._json_response(result, code)

        elif path == "/correct":
            if not is_admin(self.headers):
                self._json_response({"error": "unauthorized"}, 401)
                return
            result, code = handle_correct(body)
            self._json_response(result, code)

        else:
            self._json_response({"error": "not found"}, 404)

    def do_OPTIONS(self):
        """CORS preflight"""
        self.send_response(200)
        self._set_cors_headers()
        self.end_headers()

    def _json_response(self, data, code=200):
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._set_cors_headers()
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))

    def _set_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def log_message(self, format, *args):
        logger.info(f"{self.address_string()} {format % args}")


def main():
    import argparse
    parser = argparse.ArgumentParser(description="AI Customer Service Chat API")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(message)s",
    )

    server = HTTPServer((args.host, args.port), ChatHandler)
    print(f"Chat API server started on http://{args.host}:{args.port}")
    print(f"  POST /chat    — 客户对话")
    print(f"  POST /teach   — 管理员教学")
    print(f"  POST /correct — 管理员纠正")
    print(f"  GET  /search  — 搜索知识库")
    print(f"  GET  /stats   — 统计信息")
    print(f"  Admin token:  {'configured' if ADMIN_TOKEN else 'NOT SET (dev mode)'}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.server_close()


if __name__ == "__main__":
    main()
