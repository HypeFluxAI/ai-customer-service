"""自学习模块 — 从成功的对话中积累知识"""

import re
import json
import logging
from datetime import datetime
from pathlib import Path
from dataclasses import dataclass

logger = logging.getLogger("ai_cs.knowledge.learner")

# 不应学习的内容模式（敏感信息）
SKIP_PATTERNS = [
    r'0x[0-9a-fA-F]{40}',           # 钱包地址
    r'[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z]+',  # Email
    r'\b\d{10,20}\b',               # 银行账号类
    r'sk-[a-zA-Z0-9]+',             # API key
    r'-----BEGIN\s+\w+\s+KEY-----', # 私钥
]


@dataclass
class PendingLearn:
    question: str
    answer: str
    room: str
    timestamp: float
    validated: bool = False


class Learner:
    """管理自学习流程"""

    def __init__(self, store, validation_delay_min: int = 5,
                 log_dir: str = "data/conversations"):
        self.store = store
        self.validation_delay = validation_delay_min * 60
        self.pending: list[PendingLearn] = []
        self.log_path = Path(log_dir) / "learned.jsonl"
        self.log_path.parent.mkdir(parents=True, exist_ok=True)

    def submit(self, question: str, answer: str, room: str):
        """提交一个 Q&A 对等待验证"""
        if self._should_skip(question) or self._should_skip(answer):
            logger.debug(f"Skipping sensitive content: {question[:30]}...")
            return

        self.pending.append(PendingLearn(
            question=question,
            answer=answer,
            room=room,
            timestamp=datetime.now().timestamp(),
        ))

    def tick(self):
        """定时调用，检查是否有待验证的 Q&A 对已过验证期"""
        now = datetime.now().timestamp()
        validated = []
        remaining = []

        for p in self.pending:
            if now - p.timestamp >= self.validation_delay:
                if not p.validated:
                    p.validated = True
                    validated.append(p)
            else:
                remaining.append(p)

        self.pending = remaining

        for p in validated:
            self._learn(p)

    def cancel_recent(self, room: str):
        """用户投诉时取消该聊天室最近的待学习项"""
        self.pending = [p for p in self.pending if p.room != room]

    def _learn(self, item: PendingLearn):
        """将验证通过的 Q&A 存入知识库"""
        try:
            self.store.add_learned(
                question=item.question,
                answer=item.answer,
                metadata={
                    "room": item.room,
                    "learned_at": datetime.now().isoformat(),
                }
            )
            # 记录到审计日志
            self._log_learned(item)
            logger.info(f"Learned: {item.question[:50]}...")
        except Exception as e:
            logger.error(f"Learning failed: {e}")

    def _log_learned(self, item: PendingLearn):
        entry = {
            "ts": datetime.now().isoformat(),
            "question": item.question,
            "answer": item.answer,
            "room": item.room,
        }
        with open(self.log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def _should_skip(self, text: str) -> bool:
        for pattern in SKIP_PATTERNS:
            if re.search(pattern, text):
                return True
        return False
