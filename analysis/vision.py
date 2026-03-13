"""Claude Vision 分析 — 从聊天截图中提取结构化消息"""

import json
import logging
from dataclasses import dataclass, field
from PIL import Image

import anthropic

from capture.screenshot import image_to_base64

logger = logging.getLogger("ai_cs.analysis.vision")

VISION_PROMPT = """你是一个聊天截图分析系统。分析这张 KakaoTalk 聊天窗口截图，提取所有可见的聊天消息。

规则：
1. KakaoTalk 中，对方发的消息在左侧（有头像），自己发的消息在右侧（无头像，黄色气泡）
2. 系统消息（如"xxx 加入了聊天室"）居中显示
3. 发送者名字显示在消息气泡上方
4. 重点提取最底部的新消息
5. 准确提取韩语文本

我方客服账号名: {bot_name}

请返回 JSON 格式（不要包含 markdown 代码块标记）：
{{
  "chat_room_name": "聊天室名称",
  "messages": [
    {{
      "sender": "user 或 self 或 system",
      "sender_name": "发送者昵称",
      "text": "消息文本内容",
      "timestamp": "HH:MM 或空字符串",
      "position": "bottom 或 middle 或 top"
    }}
  ],
  "has_new_user_message": true/false,
  "confidence": 0.0-1.0
}}

sender 判断规则：
- "self": 右侧黄色气泡 或 发送者名为 "{bot_name}"
- "system": 居中的系统通知
- "user": 其他所有消息（左侧气泡）

只返回 JSON，不要其他文字。"""


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


def analyze_screenshot(client: anthropic.Anthropic,
                       image: Image.Image,
                       bot_name: str,
                       model: str = "claude-opus-4-20250514") -> AnalysisResult:
    """发送截图到 Claude Vision API 进行分析"""
    b64 = image_to_base64(image)
    prompt = VISION_PROMPT.format(bot_name=bot_name)

    try:
        response = client.messages.create(
            model=model,
            max_tokens=2000,
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            "data": b64,
                        }
                    },
                    {
                        "type": "text",
                        "text": prompt,
                    }
                ]
            }]
        )

        raw = response.content[0].text.strip()
        # 清理可能的 markdown 代码块
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
        if raw.endswith("```"):
            raw = raw[:-3]
        raw = raw.strip()

        data = json.loads(raw)

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
            raw_response=raw,
        )

        logger.info(f"Vision analysis: {len(messages)} messages, "
                     f"new_user={result.has_new_user_message}, "
                     f"confidence={result.confidence:.2f}")
        return result

    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse vision response: {e}")
        return AnalysisResult(raw_response=raw if 'raw' in dir() else "")
    except Exception as e:
        logger.error(f"Vision API error: {e}")
        return AnalysisResult()
