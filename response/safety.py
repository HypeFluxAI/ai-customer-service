"""安全防护 — 速率限制、内容过滤、人工升级"""

import re
import time
import logging
from collections import deque

logger = logging.getLogger("ai_cs.response.safety")


class SafetyGuard:
    def __init__(self, config: dict):
        safety = config.get("safety", {})
        self.rate_limit_10s = safety.get("rate_limit_per_10s", 1)
        self.rate_limit_hour = safety.get("rate_limit_per_hour", 20)
        self.max_consecutive = safety.get("max_consecutive_bot_replies", 5)
        self.escalation_keywords = safety.get("escalation_keywords", [])

        self._send_times: deque = deque()
        self._consecutive_count = 0
        self._paused = False

    def check(self, reply_text: str, user_text: str) -> tuple[bool, str]:
        """检查是否允许发送回复

        Returns: (allowed, reason)
        """
        if self._paused:
            return False, "system_paused"

        # 速率限制 - 10秒内
        now = time.time()
        recent_10s = sum(1 for t in self._send_times if now - t < 10)
        if recent_10s >= self.rate_limit_10s:
            return False, "rate_limit_10s"

        # 速率限制 - 1小时内
        recent_hour = sum(1 for t in self._send_times if now - t < 3600)
        if recent_hour >= self.rate_limit_hour:
            return False, "rate_limit_hour"

        # 连续回复上限
        if self._consecutive_count >= self.max_consecutive:
            return False, "max_consecutive"

        # 人工升级关键词
        for kw in self.escalation_keywords:
            if kw in user_text:
                return False, f"escalation:{kw}"

        # 内容安全检查
        if self._has_sensitive_content(reply_text):
            return False, "sensitive_content"

        return True, "ok"

    def record_send(self):
        """记录一次发送"""
        self._send_times.append(time.time())
        self._consecutive_count += 1
        # 清理超过 1 小时的记录
        cutoff = time.time() - 3600
        while self._send_times and self._send_times[0] < cutoff:
            self._send_times.popleft()

    def record_human_message(self):
        """人工客服发了消息，重置连续计数"""
        self._consecutive_count = 0

    def pause(self):
        self._paused = True

    def resume(self):
        self._paused = False
        self._consecutive_count = 0

    @property
    def is_paused(self) -> bool:
        return self._paused

    def _has_sensitive_content(self, text: str) -> bool:
        patterns = [
            r'0x[0-9a-fA-F]{40}',           # 钱包地址
            r'sk-[a-zA-Z0-9]{20,}',          # API key
            r'-----BEGIN',                     # 私钥
            r'password\s*[:=]',               # 密码
        ]
        for p in patterns:
            if re.search(p, text, re.IGNORECASE):
                return True
        return False
