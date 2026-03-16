"""交互式训练 CLI — 像聊天一样与客服系统对话，训练提升其能力

功能:
  1. 直接对话: 输入问题，客服系统回复（使用相同的 KB 检索 + AI 生成流程）
  2. 反馈训练: 对回复评分，纠正错误回复
  3. 即时教学: 直接告诉系统新知识，立即写入知识库
  4. 批量训练: 从 Q&A JSON 文件批量训练
  5. 知识库查看: 搜索和浏览当前知识库内容
"""

import os
import sys
import json
import logging
from datetime import datetime
from pathlib import Path

import anthropic
import yaml
from dotenv import load_dotenv

# 将项目根目录加入 path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from knowledge.store import KnowledgeStore
from knowledge.chunker import TextChunker
from response.generator import generate_reply
from analysis.vision import ChatMessage

logger = logging.getLogger("ai_cs.training")

# 训练日志路径
TRAIN_LOG_DIR = Path("data/training")

# 颜色输出
class C:
    CYAN = "\033[96m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    RED = "\033[91m"
    GRAY = "\033[90m"
    BOLD = "\033[1m"
    RESET = "\033[0m"


def print_banner():
    print(f"""
{C.CYAN}{C.BOLD}╔══════════════════════════════════════════════════════╗
║       AI 客服训练模式 — Interactive Training         ║
╚══════════════════════════════════════════════════════╝{C.RESET}

{C.GRAY}像和客服聊天一样对话，训练提升它的回复能力。{C.RESET}

{C.YELLOW}命令:{C.RESET}
  直接输入文字      → 模拟客户提问，查看客服回复
  {C.GREEN}/teach{C.RESET}  Q ||| A    → 直接教学（问题 ||| 答案）
  {C.GREEN}/correct{C.RESET}           → 纠正上一条回复
  {C.GREEN}/search{C.RESET}  关键词     → 搜索知识库
  {C.GREEN}/stats{C.RESET}             → 查看知识库统计
  {C.GREEN}/history{C.RESET}           → 查看对话历史
  {C.GREEN}/export{C.RESET}            → 导出训练记录
  {C.GREEN}/import{C.RESET}  FILE      → 从 Q&A JSON 文件批量训练
  {C.GREEN}/clear{C.RESET}             → 清空当前对话历史
  {C.GREEN}/help{C.RESET}              → 显示此帮助
  {C.GREEN}/quit{C.RESET}              → 退出
""")


class TrainingSession:
    """交互式训练会话"""

    def __init__(self, config: dict, api_key: str):
        self.config = config
        self.client = anthropic.Anthropic(api_key=api_key)
        self.model = config["analysis"]["text_model"]

        # 初始化知识库
        kb_cfg = config["knowledge"]
        self.store = KnowledgeStore(
            persist_dir=kb_cfg["chromadb_path"],
            embedding_model=kb_cfg.get("embedding_model"),
        )

        # 对话历史（模拟 ChatMessage 格式）
        self.history: list[ChatMessage] = []

        # 训练日志
        TRAIN_LOG_DIR.mkdir(parents=True, exist_ok=True)
        self.log_path = TRAIN_LOG_DIR / f"train_{datetime.now():%Y%m%d_%H%M%S}.jsonl"

        # 上一轮状态（用于 /correct）
        self.last_question = ""
        self.last_answer = ""
        self.last_kb_results = []

    def run(self):
        """主循环"""
        print_banner()
        print(f"{C.GRAY}知识库: {self.store.kb_count} 条主知识, {self.store.learned_count} 条自学习{C.RESET}")
        print(f"{C.GRAY}模型: {self.model}{C.RESET}")
        print()

        while True:
            try:
                user_input = input(f"{C.CYAN}고객>{C.RESET} ").strip()
            except (EOFError, KeyboardInterrupt):
                print(f"\n{C.GRAY}退出训练模式{C.RESET}")
                break

            if not user_input:
                continue

            # 命令处理
            if user_input.startswith("/"):
                if not self._handle_command(user_input):
                    break
                continue

            # 正常对话
            self._chat(user_input)

    def _chat(self, user_message: str):
        """处理一轮对话"""
        # 1. 搜索知识库
        kb_results = self.store.search(user_message, n_results=5)

        # 显示检索结果
        if kb_results:
            print(f"\n  {C.GRAY}[KB 检索到 {len(kb_results)} 条相关知识, 最近距离: {kb_results[0]['distance']:.3f}]{C.RESET}")
        else:
            print(f"\n  {C.GRAY}[KB 无相关知识]{C.RESET}")

        # 2. 生成回复
        reply = generate_reply(
            client=self.client,
            user_message=user_message,
            kb_results=kb_results,
            history=self.history,
            model=self.model,
        )

        if not reply:
            print(f"  {C.RED}[生成失败]{C.RESET}\n")
            return

        # 3. 显示回复
        print(f"{C.GREEN}상담원>{C.RESET} {reply}")
        print(f"  {C.GRAY}[/correct 纠正 | /teach 教学 | 继续对话...]{C.RESET}\n")

        # 4. 更新历史
        self.history.append(ChatMessage(
            sender="user", sender_name="고객",
            text=user_message, position="bottom",
        ))
        self.history.append(ChatMessage(
            sender="self", sender_name="상담원",
            text=reply, position="bottom",
        ))

        # 保留最近的历史
        max_history = self.config["analysis"].get("max_history_messages", 10)
        if len(self.history) > max_history:
            self.history = self.history[-max_history:]

        # 5. 记录状态
        self.last_question = user_message
        self.last_answer = reply
        self.last_kb_results = kb_results

        # 6. 写训练日志
        self._log("chat", {
            "question": user_message,
            "answer": reply,
            "kb_hits": len(kb_results),
            "kb_top_distance": kb_results[0]["distance"] if kb_results else None,
        })

    def _handle_command(self, cmd: str) -> bool:
        """处理命令，返回 False 表示退出"""
        parts = cmd.split(maxsplit=1)
        command = parts[0].lower()
        arg = parts[1] if len(parts) > 1 else ""

        if command in ("/quit", "/exit", "/q"):
            print(f"{C.GRAY}训练日志已保存到: {self.log_path}{C.RESET}")
            return False

        elif command == "/help":
            print_banner()

        elif command == "/teach":
            self._cmd_teach(arg)

        elif command == "/correct":
            self._cmd_correct()

        elif command == "/search":
            self._cmd_search(arg)

        elif command == "/stats":
            self._cmd_stats()

        elif command == "/history":
            self._cmd_history()

        elif command == "/export":
            self._cmd_export()

        elif command == "/import":
            self._cmd_import(arg)

        elif command == "/clear":
            self.history.clear()
            print(f"{C.GRAY}对话历史已清空{C.RESET}\n")

        else:
            print(f"{C.RED}未知命令: {command}  输入 /help 查看帮助{C.RESET}\n")

        return True

    def _cmd_teach(self, arg: str):
        """直接教学: /teach 问题 ||| 答案"""
        if "|||" not in arg:
            # 交互模式
            print(f"{C.YELLOW}直接教学模式 — 输入问题和标准答案{C.RESET}")
            try:
                q = input(f"  问题: ").strip()
                a = input(f"  答案: ").strip()
            except (EOFError, KeyboardInterrupt):
                print()
                return

            if not q or not a:
                print(f"{C.RED}问题和答案都不能为空{C.RESET}\n")
                return
        else:
            parts = arg.split("|||", 1)
            q = parts[0].strip()
            a = parts[1].strip()

        self.store.add_learned(
            question=q,
            answer=a,
            metadata={
                "source": "training_cli",
                "trained_at": datetime.now().isoformat(),
            }
        )
        print(f"{C.GREEN}✓ 已学习: {q[:50]}...{C.RESET}\n")
        self._log("teach", {"question": q, "answer": a})

    def _cmd_correct(self):
        """纠正上一条回复"""
        if not self.last_question:
            print(f"{C.RED}没有可纠正的回复{C.RESET}\n")
            return

        print(f"{C.YELLOW}纠正模式{C.RESET}")
        print(f"  原问题: {self.last_question}")
        print(f"  原回复: {self.last_answer}")

        try:
            correct_answer = input(f"  正确答案: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return

        if not correct_answer:
            print(f"{C.RED}取消纠正{C.RESET}\n")
            return

        # 将正确的 Q&A 写入知识库
        self.store.add_learned(
            question=self.last_question,
            answer=correct_answer,
            metadata={
                "source": "training_correction",
                "original_answer": self.last_answer,
                "corrected_at": datetime.now().isoformat(),
            }
        )

        # 更新对话历史中的最后一条回复
        if self.history and self.history[-1].is_self:
            self.history[-1] = ChatMessage(
                sender="self", sender_name="상담원",
                text=correct_answer, position="bottom",
            )

        print(f"{C.GREEN}✓ 已纠正并学习{C.RESET}\n")
        self._log("correct", {
            "question": self.last_question,
            "original_answer": self.last_answer,
            "corrected_answer": correct_answer,
        })

    def _cmd_search(self, query: str):
        """搜索知识库"""
        if not query:
            try:
                query = input(f"  搜索关键词: ").strip()
            except (EOFError, KeyboardInterrupt):
                print()
                return

        results = self.store.search(query, n_results=10)
        if not results:
            print(f"{C.GRAY}未找到相关知识{C.RESET}\n")
            return

        print(f"\n{C.YELLOW}搜索结果 ({len(results)} 条):{C.RESET}")
        for i, r in enumerate(results, 1):
            src = r.get("metadata", {}).get("source_file", r["source"])
            dist = r["distance"]
            text = r["text"][:120].replace("\n", " ")
            print(f"  {i}. [{C.GRAY}{src}{C.RESET}] (距离: {dist:.3f})")
            print(f"     {text}")
        print()

    def _cmd_stats(self):
        """知识库统计"""
        print(f"\n{C.YELLOW}知识库统计:{C.RESET}")
        print(f"  主知识库:   {self.store.kb_count} 条")
        print(f"  自学习:     {self.store.learned_count} 条")

        # 训练日志统计
        if self.log_path.exists():
            count = sum(1 for _ in open(self.log_path, "r", encoding="utf-8"))
            print(f"  本次训练:   {count} 条记录")

        print(f"  对话历史:   {len(self.history)} 条消息")
        print()

    def _cmd_history(self):
        """显示对话历史"""
        if not self.history:
            print(f"{C.GRAY}无对话历史{C.RESET}\n")
            return

        print(f"\n{C.YELLOW}对话历史:{C.RESET}")
        for m in self.history:
            if m.is_user:
                print(f"  {C.CYAN}고객>{C.RESET} {m.text}")
            else:
                print(f"  {C.GREEN}상담원>{C.RESET} {m.text}")
        print()

    def _cmd_export(self):
        """导出训练记录为 Q&A JSON 文件"""
        if not self.log_path.exists():
            print(f"{C.RED}无训练记录可导出{C.RESET}\n")
            return

        export_path = TRAIN_LOG_DIR / f"export_{datetime.now():%Y%m%d_%H%M%S}.json"
        qa_pairs = []

        with open(self.log_path, "r", encoding="utf-8") as f:
            for line in f:
                entry = json.loads(line)
                if entry["event"] in ("teach", "correct"):
                    qa_pairs.append({
                        "question": entry["data"].get("question", ""),
                        "answer": entry["data"].get("corrected_answer",
                                                     entry["data"].get("answer", "")),
                    })

        with open(export_path, "w", encoding="utf-8") as f:
            json.dump(qa_pairs, f, ensure_ascii=False, indent=2)

        print(f"{C.GREEN}导出 {len(qa_pairs)} 条 Q&A 到: {export_path}{C.RESET}\n")

    def _cmd_import(self, file_path: str):
        """从 Q&A JSON 文件批量导入"""
        if not file_path:
            try:
                file_path = input(f"  JSON 文件路径: ").strip()
            except (EOFError, KeyboardInterrupt):
                print()
                return

        path = Path(file_path)
        if not path.exists():
            print(f"{C.RED}文件不存在: {file_path}{C.RESET}\n")
            return

        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)

        if not isinstance(data, list):
            print(f"{C.RED}JSON 格式错误，需要 [{'{'}\"question\":..., \"answer\":...{'}'}] 数组{C.RESET}\n")
            return

        count = 0
        for item in data:
            q = item.get("question", "").strip()
            a = item.get("answer", "").strip()
            if q and a:
                self.store.add_learned(
                    question=q,
                    answer=a,
                    metadata={
                        "source": f"training_import:{path.name}",
                        "imported_at": datetime.now().isoformat(),
                    }
                )
                count += 1

        print(f"{C.GREEN}✓ 导入 {count} 条 Q&A{C.RESET}\n")
        self._log("import", {"file": str(path), "count": count})

    def _log(self, event: str, data: dict):
        """写训练日志"""
        entry = {
            "ts": datetime.now().isoformat(),
            "event": event,
            "data": data,
        }
        with open(self.log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def main():
    load_dotenv()

    config_path = "config.yaml"
    if len(sys.argv) > 1 and sys.argv[1] == "--config":
        config_path = sys.argv[2]

    with open(config_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f)

    api_key = os.getenv("ANTHROPIC_API_KEY", "")
    if not api_key:
        print("Error: ANTHROPIC_API_KEY not set in .env")
        sys.exit(1)

    # 配置基本日志
    logging.basicConfig(level=logging.WARNING, format="%(message)s")

    session = TrainingSession(config, api_key)
    session.run()


if __name__ == "__main__":
    main()
