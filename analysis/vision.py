"""聊天截图分析 — 调用生产 Vision 端点 (ZenMux/Claude Vision) 提取结构化消息

[2026-06-04] 从"本地直连 Anthropic + 旧 Vision 模型(claude-opus-4-20250514)"
改为调用生产 `/api/kakao/desktop-vision` 端点。桌面端因此彻底变瘦客户端 ——
不再需要本地 Anthropic key, Vision 与回复生成都在生产端用 ZenMux/Opus 完成。
VISION_PROMPT 已移到后端 (routes/kakaoWebhook.js)。
"""

import os
import json
import logging
from dataclasses import dataclass, field

import requests

from capture.screenshot import image_to_base64

logger = logging.getLogger("ai_cs.analysis.vision")

# 生产 Vision 端点 (rpc3 ai-cs, 走 HTTPS 反代). 可用环境变量覆盖.
VISION_BACKEND_URL = os.environ.get(
    "PRODUCTION_VISION_URL",
    "https://deeplinkgame.com/aiapi/kakao/desktop-vision",
)
VISION_BACKEND_SECRET = os.environ.get("DESKTOP_REPLY_SECRET", "deeplink-desktop-kakao-2026")
VISION_BACKEND_TIMEOUT = float(os.environ.get("PRODUCTION_VISION_TIMEOUT", "30"))


@dataclass
class ChatMessage:
    sender: str        # "user" | "self" | "system"
    sender_name: str
    text: str
    timestamp: str = ""
    position: str = ""  # "bottom" | "middle" | "top"

    @property
    def is_user(self) -> bool:
        return self.sender == "user"

    @property
    def is_self(self) -> bool:
        return self.sender == "self"

    def __hash__(self):
        return hash((self.sender_name, self.text, self.timestamp))


@dataclass
class AnalysisResult:
    chat_room_name: str = ""
    messages: list[ChatMessage] = field(default_factory=list)
    has_new_user_message: bool = False
    confidence: float = 0.0
    raw_response: str = ""

    @property
    def new_user_messages(self) -> list[ChatMessage]:
        return [m for m in self.messages
                if m.is_user and m.position in ("bottom", "")]


def analyze_screenshot(client=None,
                       image=None,
                       bot_name: str = "",
                       model: str = None) -> AnalysisResult:
    """发送截图到生产 Vision 端点进行分析。

    Args:
        client: 兼容旧签名, 忽略 (生产端用 ZenMux/Claude Vision)
        image: PIL.Image 截图
        bot_name: 我方客服账号名 (用于区分 self/user)
        model: 兼容旧签名, 忽略

    Returns:
        AnalysisResult; 后端不可达 / 解析失败时返回空结果 (引擎跳过该次)。
    """
    try:
        b64 = image_to_base64(image)
    except Exception as e:
        logger.error(f"image_to_base64 failed: {e}")
        return AnalysisResult()

    try:
        resp = requests.post(
            VISION_BACKEND_URL,
            json={"image": b64, "bot_name": bot_name},
            headers={
                "X-Internal-Secret": VISION_BACKEND_SECRET,
                "Content-Type": "application/json",
            },
            timeout=VISION_BACKEND_TIMEOUT,
        )
        if resp.status_code != 200:
            logger.error(f"Vision backend HTTP {resp.status_code}: {resp.text[:150]}")
            return AnalysisResult()
        data = resp.json()

        messages = []
        for m in data.get("messages", []):
            messages.append(ChatMessage(
                sender=m.get("sender", "user"),
                sender_name=m.get("sender_name", ""),
                text=m.get("text", ""),
                timestamp=m.get("timestamp", ""),
                position=m.get("position", ""),
            ))

        result = AnalysisResult(
            chat_room_name=data.get("chat_room_name", ""),
            messages=messages,
            has_new_user_message=data.get("has_new_user_message", False),
            confidence=data.get("confidence", 0.0),
            raw_response=json.dumps(data, ensure_ascii=False),
        )
        logger.info(f"Vision analysis: {len(messages)} messages, "
                     f"new_user={result.has_new_user_message}, "
                     f"confidence={result.confidence:.2f}")
        return result

    except Exception as e:
        logger.error(f"Vision backend error: {e}")
        return AnalysisResult()
