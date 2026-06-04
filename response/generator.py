"""AI 回复生成 — 调用生产 ai-cs 后端 (复用最新知识库 + 护栏 + DeepSeek 兜底)

[2026-06-04] 从"本地 ChromaDB + 直连 Anthropic 旧模型"改为调用生产
`/api/kakao/desktop-reply` 端点。这样桌面 RPA 复用与网页/官方 chatbot
完全一致的最新 AI(向量 RAG + 实时机器可用性 OpContext + 价格/包月/版本/
准确性护栏修复 + ZenMux/Opus 主力 + DeepSeek 兜底)。

client / kb_results / model 参数保留以兼容现有调用方(engine.py),
但不再使用 —— 知识检索与回复生成现在都在生产端完成。
"""

import os
import logging

import requests

logger = logging.getLogger("ai_cs.response.generator")

# 生产 AI 后端 (rpc3 ai-cs 容器, /api/kakao/desktop-reply). 可用环境变量覆盖.
#   生产环境建议改成走 HTTPS 反代域名而非直连 IP:3001。
AI_BACKEND_URL = os.environ.get(
    "PRODUCTION_AI_URL",
    "http://3.38.65.100:3001/api/kakao/desktop-reply",
)
AI_BACKEND_SECRET = os.environ.get("DESKTOP_REPLY_SECRET", "deeplink-desktop-kakao-2026")
AI_BACKEND_TIMEOUT = float(os.environ.get("PRODUCTION_AI_TIMEOUT", "15"))


def generate_reply(client=None,
                   user_message: str = "",
                   kb_results=None,
                   history=None,
                   model: str = None) -> str:
    """调用生产 AI 生成客服回复。

    Args:
        client: 兼容旧签名, 忽略 (生产端用 ZenMux/DeepSeek)
        user_message: 用户最新消息
        kb_results: 兼容旧签名, 忽略 (知识检索在生产端)
        history: list[ChatMessage] — 从屏幕 Vision 读到的对话历史
        model: 兼容旧签名, 忽略

    Returns:
        回复文本; 后端不可达 / 无合适回复时返回 "" (引擎据此跳过 → 转人工)。
    """
    if not user_message:
        return ""

    # history: list[ChatMessage] → [{sender, text}] 最新在前 (与生产端 ChatMessage sort:-1 一致)
    hist = []
    try:
        for m in reversed(list(history or [])[-15:]):
            is_user = getattr(m, "is_user", True)
            text = getattr(m, "text", "")
            if text:
                hist.append({"sender": "user" if is_user else "admin", "text": text})
    except Exception as e:
        logger.debug(f"history convert error: {e}")
        hist = []

    try:
        resp = requests.post(
            AI_BACKEND_URL,
            json={"message": user_message, "language": "ko", "history": hist},
            headers={
                "X-Internal-Secret": AI_BACKEND_SECRET,
                "Content-Type": "application/json",
            },
            timeout=AI_BACKEND_TIMEOUT,
        )
        if resp.status_code != 200:
            logger.error(f"AI backend HTTP {resp.status_code}: {resp.text[:150]}")
            return ""
        data = resp.json()
        reply = (data.get("reply") or "").strip()
        if reply:
            logger.info(f"Generated reply (prod AI): {reply[:80]}...")
        else:
            logger.warning("AI backend returned empty reply (转人工)")
        return reply
    except Exception as e:
        logger.error(f"AI backend call failed: {e}")
        return ""
