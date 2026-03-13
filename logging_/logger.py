import logging
import json
import os
from datetime import datetime
from pathlib import Path


def setup_logger(config: dict) -> logging.Logger:
    level = getattr(logging, config.get("logging", {}).get("level", "INFO"))
    logger = logging.getLogger("ai_cs")
    logger.setLevel(level)

    if not logger.handlers:
        fmt = logging.Formatter("[%(asctime)s] %(levelname)s %(name)s: %(message)s",
                                datefmt="%Y-%m-%d %H:%M:%S")
        ch = logging.StreamHandler()
        ch.setFormatter(fmt)
        logger.addHandler(ch)

    return logger


class ConversationLogger:
    """记录对话历史到 JSONL 文件，每天一个文件"""

    def __init__(self, log_dir: str):
        self.log_dir = Path(log_dir)
        self.log_dir.mkdir(parents=True, exist_ok=True)

    def _get_file(self) -> Path:
        return self.log_dir / f"{datetime.now():%Y-%m-%d}.jsonl"

    def log(self, event_type: str, data: dict):
        entry = {
            "ts": datetime.now().isoformat(),
            "event": event_type,
            **data,
        }
        with open(self._get_file(), "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def log_user_message(self, sender: str, text: str, room: str):
        self.log("user_message", {"sender": sender, "text": text, "room": room})

    def log_bot_reply(self, text: str, room: str, kb_sources: list = None):
        self.log("bot_reply", {"text": text, "room": room, "kb_sources": kb_sources or []})

    def log_skip(self, reason: str, text: str = ""):
        self.log("skip", {"reason": reason, "text": text})

    def log_error(self, error: str, context: str = ""):
        self.log("error", {"error": error, "context": context})

    def cleanup_old(self, max_days: int = 30):
        cutoff = datetime.now().timestamp() - max_days * 86400
        for f in self.log_dir.glob("*.jsonl"):
            if f.stat().st_mtime < cutoff:
                f.unlink()
