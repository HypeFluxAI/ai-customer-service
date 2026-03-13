"""消息去重 — 防止重复回答已处理的消息"""

import hashlib
import json
import logging
from collections import OrderedDict
from pathlib import Path
from datetime import datetime

from analysis.vision import ChatMessage

logger = logging.getLogger("ai_cs.analysis.dedup")


class MessageDedup:
    """基于消息内容哈希的滑动窗口去重"""

    def __init__(self, max_size: int = 200, persist_path: str = None):
        self.max_size = max_size
        self.persist_path = Path(persist_path) if persist_path else None
        self._seen: OrderedDict[str, float] = OrderedDict()
        self._load()

    def _hash(self, msg: ChatMessage) -> str:
        key = f"{msg.sender_name}|{msg.text}".strip()
        return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]

    def is_new(self, msg: ChatMessage) -> bool:
        h = self._hash(msg)
        if h in self._seen:
            return False
        # 添加到已处理集合
        self._seen[h] = datetime.now().timestamp()
        # 超过上限时移除最旧的
        while len(self._seen) > self.max_size:
            self._seen.popitem(last=False)
        return True

    def filter_new(self, messages: list[ChatMessage]) -> list[ChatMessage]:
        return [m for m in messages if m.is_user and self.is_new(m)]

    def save(self):
        if self.persist_path:
            self.persist_path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.persist_path, "w") as f:
                json.dump(dict(self._seen), f)

    def _load(self):
        if self.persist_path and self.persist_path.exists():
            try:
                with open(self.persist_path) as f:
                    self._seen = OrderedDict(json.load(f))
                logger.info(f"Loaded {len(self._seen)} dedup entries")
            except Exception as e:
                logger.warning(f"Failed to load dedup state: {e}")

    def clear(self):
        self._seen.clear()
