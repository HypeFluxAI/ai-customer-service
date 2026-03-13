"""主引擎 — 截图→分析→回复→发送 完整流水线"""

import time
import logging
import threading

import anthropic

from core.state import EngineState, StateManager
from capture.window import find_chat_window, get_window_rect
from capture.screenshot import capture_window, save_screenshot
from capture.diff import DiffDetector
from analysis.vision import analyze_screenshot, ChatMessage
from analysis.dedup import MessageDedup
from knowledge.store import KnowledgeStore
from knowledge.learner import Learner
from response.generator import generate_reply
from response.safety import SafetyGuard
from automation.kakao import send_message
from logging_.logger import ConversationLogger

logger = logging.getLogger("ai_cs.engine")


class Engine:
    """AI 客服自动化主引擎"""

    def __init__(self, config: dict, api_key: str):
        self.config = config
        self.client = anthropic.Anthropic(api_key=api_key)
        self.state = StateManager()

        # 子模块初始化
        cap_cfg = config.get("capture", {})
        self.interval = cap_cfg.get("interval_seconds", 5)
        self.diff_detector = DiffDetector(threshold=cap_cfg.get("diff_threshold", 0.05))

        kakao_cfg = config.get("kakao", {})
        self.window_title = kakao_cfg.get("window_title_pattern", "")
        self.bot_name = kakao_cfg.get("bot_account_name", "")
        self.input_offset_y = kakao_cfg.get("input_field_offset_y", -40)

        analysis_cfg = config.get("analysis", {})
        self.vision_model = analysis_cfg.get("vision_model", "claude-opus-4-20250514")
        self.text_model = analysis_cfg.get("text_model", "claude-sonnet-4-20250514")

        kb_cfg = config.get("knowledge", {})
        self.kb_store = KnowledgeStore(
            persist_dir=kb_cfg.get("chromadb_path", "data/chromadb"),
            embedding_model=kb_cfg.get("embedding_model"),
        )

        self.dedup = MessageDedup(persist_path="data/conversations/dedup.json")
        self.safety = SafetyGuard(config)
        self.learner = Learner(
            store=self.kb_store,
            validation_delay_min=config.get("learning", {}).get("validation_delay_minutes", 5),
        )
        self.conv_logger = ConversationLogger(
            config.get("logging", {}).get("conversation_log_dir", "data/conversations")
        )

        # 对话历史缓存
        self.message_history: list[ChatMessage] = []
        self.max_history = analysis_cfg.get("max_history_messages", 10)

        # kill switch
        self._stop_event = threading.Event()

    def start(self):
        """启动主循环"""
        logger.info("Engine starting...")
        logger.info(f"  Window pattern: {self.window_title}")
        logger.info(f"  Bot name: {self.bot_name}")
        logger.info(f"  Interval: {self.interval}s")
        logger.info(f"  KB documents: {self.kb_store.kb_count}")
        logger.info(f"  Learned Q&A: {self.kb_store.learned_count}")

        # 启动 kill switch 监听
        self._start_kill_switch()

        self.state.set(EngineState.IDLE)

        while not self._stop_event.is_set():
            try:
                self._tick()
            except Exception as e:
                logger.error(f"Engine tick error: {e}", exc_info=True)
                self.conv_logger.log_error(str(e), "engine_tick")

            # 自学习定时检查
            self.learner.tick()

            self._stop_event.wait(timeout=self.interval)

        self.state.set(EngineState.STOPPED)
        self.dedup.save()
        logger.info("Engine stopped")

    def stop(self):
        """停止引擎"""
        self._stop_event.set()

    def _tick(self):
        """一次完整的 截图→分析→回复 循环"""
        # 1. 查找聊天窗口
        self.state.set(EngineState.CAPTURING)
        window = find_chat_window(self.window_title)
        if not window:
            logger.debug(f"Chat window not found: {self.window_title}")
            self.state.set(EngineState.IDLE)
            return

        # 2. 截图
        rect = get_window_rect(window.hwnd)
        if not rect:
            self.state.set(EngineState.IDLE)
            return

        img = capture_window(rect)
        if not img:
            self.state.set(EngineState.IDLE)
            return

        # 3. 差异检测
        if not self.diff_detector.has_changes(img):
            self.state.set(EngineState.IDLE)
            return

        # 4. Vision 分析
        self.state.set(EngineState.ANALYZING)
        analysis = analyze_screenshot(
            self.client, img, self.bot_name, model=self.vision_model
        )

        if not analysis.has_new_user_message:
            logger.debug("No new user messages detected")
            self.state.set(EngineState.IDLE)
            return

        confidence = analysis.confidence
        min_confidence = self.config.get("learning", {}).get("min_confidence", 0.7)
        if confidence < min_confidence:
            logger.warning(f"Low confidence ({confidence:.2f}), skipping")
            self.conv_logger.log_skip("low_confidence", f"confidence={confidence:.2f}")
            self.state.set(EngineState.IDLE)
            return

        # 更新对话历史
        for m in analysis.messages:
            self.message_history.append(m)
        self.message_history = self.message_history[-self.max_history:]

        # 5. 过滤新消息
        new_messages = self.dedup.filter_new(analysis.new_user_messages)
        if not new_messages:
            logger.debug("All messages already processed")
            self.state.set(EngineState.IDLE)
            return

        # 6. 对每条新消息生成回复
        for msg in new_messages:
            self._handle_message(window.hwnd, msg)

        self.state.set(EngineState.COOLDOWN)

    def _handle_message(self, hwnd: int, msg: ChatMessage):
        """处理单条用户消息"""
        self.conv_logger.log_user_message(msg.sender_name, msg.text,
                                          self.window_title)
        logger.info(f"Processing: [{msg.sender_name}] {msg.text[:60]}...")

        # 搜索知识库
        self.state.set(EngineState.RESPONDING)
        kb_results = self.kb_store.search(msg.text)
        kb_sources = [r.get("metadata", {}).get("source_file", "") for r in kb_results]

        # 生成回复
        reply = generate_reply(
            self.client,
            user_message=msg.text,
            kb_results=kb_results,
            history=self.message_history,
            model=self.text_model,
        )

        if not reply:
            self.conv_logger.log_skip("empty_reply", msg.text)
            return

        # 安全检查
        allowed, reason = self.safety.check(reply, msg.text)
        if not allowed:
            logger.warning(f"Reply blocked: {reason}")
            self.conv_logger.log_skip(f"safety:{reason}", msg.text)
            if reason.startswith("escalation:"):
                logger.info("Escalation triggered — human agent needed")
            return

        # 发送
        self.state.set(EngineState.SENDING)
        success = send_message(
            hwnd=hwnd,
            text=reply,
            title_pattern=self.window_title,
            input_offset_y=self.input_offset_y,
        )

        if success:
            self.safety.record_send()
            self.conv_logger.log_bot_reply(reply, self.window_title, kb_sources)

            # 提交自学习
            if self.config.get("learning", {}).get("enabled", True):
                self.learner.submit(msg.text, reply, self.window_title)
        else:
            self.conv_logger.log_error("send_failed", reply[:50])

    def _start_kill_switch(self):
        """全局热键监听 (Ctrl+Shift+Q)"""
        hotkey = self.config.get("safety", {}).get("kill_switch_hotkey", "ctrl+shift+q")

        def listen():
            try:
                from pynput import keyboard

                keys = set()
                target = {keyboard.Key.ctrl_l, keyboard.Key.shift, keyboard.KeyCode.from_char('q')}

                def on_press(key):
                    keys.add(key)
                    if target.issubset(keys):
                        logger.warning("Kill switch activated!")
                        self.stop()
                        return False

                def on_release(key):
                    keys.discard(key)

                with keyboard.Listener(on_press=on_press, on_release=on_release) as listener:
                    listener.join()
            except ImportError:
                logger.warning("pynput not available, kill switch disabled")
            except Exception as e:
                logger.debug(f"Kill switch listener error: {e}")

        thread = threading.Thread(target=listen, daemon=True)
        thread.start()

    def import_knowledge(self, file_path: str):
        """导入知识库文件"""
        from knowledge.importer import import_file
        from knowledge.chunker import chunk_text

        kb_cfg = self.config.get("knowledge", {})
        chunk_size = kb_cfg.get("chunk_size", 500)
        chunk_overlap = kb_cfg.get("chunk_overlap", 50)

        docs = import_file(file_path)
        if not docs:
            logger.warning(f"No content imported from {file_path}")
            return 0

        all_chunks = []
        all_metas = []
        for text, meta in docs:
            chunks = chunk_text(text, chunk_size, chunk_overlap)
            for chunk in chunks:
                all_chunks.append(chunk)
                all_metas.append(meta)

        if all_chunks:
            self.kb_store.add_documents(all_chunks, all_metas)
            logger.info(f"Imported {len(all_chunks)} chunks from {file_path}")

        return len(all_chunks)
