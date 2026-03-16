#!/usr/bin/env python3
"""AI 客服自动化系统 — 入口

用法:
  python run.py                    # 启动服务
  python run.py --train            # 交互式训练模式
  python run.py --import FILE      # 导入知识库文件
  python run.py --import-dir DIR   # 批量导入目录下所有文件
  python run.py --test-capture     # 测试截图功能
  python run.py --test-vision FILE # 测试 Vision 分析（指定截图文件）
"""

import os
import sys
import argparse
import logging

import yaml
from dotenv import load_dotenv

# 将项目根目录加入 path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from logging_.logger import setup_logger


def load_config(path: str = "config.yaml") -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def cmd_start(config: dict, api_key: str):
    """启动 AI 客服服务 (需要 Windows 桌面环境)"""
    from desktop.engine import Engine

    engine = Engine(config, api_key)
    print("AI Customer Service Engine started.")
    print(f"  Monitoring: {config['kakao']['window_title_pattern']}")
    print(f"  Interval: {config['capture']['interval_seconds']}s")
    print(f"  KB docs: {engine.kb_store.kb_count}")
    print(f"  Kill switch: {config['safety']['kill_switch_hotkey']}")
    print()
    print("Press Ctrl+C or kill switch to stop.")

    try:
        engine.start()
    except KeyboardInterrupt:
        print("\nStopping...")
        engine.stop()


def cmd_import(config: dict, api_key: str, file_path: str):
    """导入单个知识库文件"""
    from desktop.engine import Engine

    engine = Engine(config, api_key)
    count = engine.import_knowledge(file_path)
    print(f"Imported {count} chunks from {file_path}")
    print(f"Total KB docs: {engine.kb_store.kb_count}")


def cmd_import_dir(config: dict, api_key: str, dir_path: str):
    """批量导入目录"""
    from desktop.engine import Engine
    from pathlib import Path

    engine = Engine(config, api_key)
    supported = {".pdf", ".docx", ".txt", ".md", ".csv", ".xlsx", ".xls", ".json"}
    total = 0

    for f in sorted(Path(dir_path).iterdir()):
        if f.suffix.lower() in supported:
            count = engine.import_knowledge(str(f))
            print(f"  {f.name}: {count} chunks")
            total += count

    print(f"\nTotal: {total} chunks imported")
    print(f"KB docs: {engine.kb_store.kb_count}")


def cmd_test_capture(config: dict):
    """测试截图功能"""
    from desktop.capture.window import find_chat_window, find_kakao_windows
    from desktop.capture.screenshot import capture_window, save_screenshot

    title = config["kakao"]["window_title_pattern"]

    print("Looking for KakaoTalk windows...")
    windows = find_kakao_windows()
    for w in windows:
        print(f"  Found: {w}")

    print(f"\nSearching for: {title}")
    window = find_chat_window(title)
    if not window:
        print("Chat window not found. Listing all visible windows...")
        import win32gui
        def cb(hwnd, _):
            if win32gui.IsWindowVisible(hwnd):
                t = win32gui.GetWindowText(hwnd)
                if t:
                    print(f"  hwnd={hwnd} title='{t}'")
            return True
        win32gui.EnumWindows(cb, None)
        return

    print(f"Found: {window}")

    from desktop.capture.window import get_window_rect
    rect = get_window_rect(window.hwnd)
    img = capture_window(rect)
    if img:
        out = "data/screenshots/test_capture.png"
        save_screenshot(img, out)
        print(f"Screenshot saved to {out} ({img.size[0]}x{img.size[1]})")
    else:
        print("Screenshot failed")


def cmd_test_vision(config: dict, api_key: str, image_path: str):
    """测试 Vision 分析"""
    from PIL import Image
    from analysis.vision import analyze_screenshot
    import anthropic

    client = anthropic.Anthropic(api_key=api_key)
    img = Image.open(image_path)
    bot_name = config["kakao"]["bot_account_name"]
    model = config["analysis"]["vision_model"]

    print(f"Analyzing {image_path} with {model}...")
    result = analyze_screenshot(client, img, bot_name, model)

    print(f"\nChat room: {result.chat_room_name}")
    print(f"Confidence: {result.confidence:.2f}")
    print(f"Has new user message: {result.has_new_user_message}")
    print(f"\nMessages ({len(result.messages)}):")
    for m in result.messages:
        icon = "👤" if m.is_user else ("🤖" if m.is_self else "📢")
        print(f"  {icon} [{m.sender_name}] {m.text}")


def main():
    parser = argparse.ArgumentParser(description="AI Customer Service Automation")
    parser.add_argument("--config", default="config.yaml", help="Config file path")
    parser.add_argument("--train", action="store_true", help="Interactive training mode")
    parser.add_argument("--import", dest="import_file", help="Import knowledge base file")
    parser.add_argument("--import-dir", help="Import all files in directory")
    parser.add_argument("--test-capture", action="store_true", help="Test screenshot capture")
    parser.add_argument("--test-vision", help="Test vision analysis on image file")
    args = parser.parse_args()

    load_dotenv()
    config = load_config(args.config)
    setup_logger(config)

    api_key = os.getenv("ANTHROPIC_API_KEY", "")

    if args.train:
        if not api_key:
            print("Error: ANTHROPIC_API_KEY not set in .env")
            sys.exit(1)
        from training.cli import TrainingSession
        session = TrainingSession(config, api_key)
        session.run()
    elif args.test_capture:
        cmd_test_capture(config)
    elif args.test_vision:
        if not api_key:
            print("Error: ANTHROPIC_API_KEY not set in .env")
            sys.exit(1)
        cmd_test_vision(config, api_key, args.test_vision)
    elif args.import_file:
        if not api_key:
            print("Error: ANTHROPIC_API_KEY not set in .env")
            sys.exit(1)
        cmd_import(config, api_key, args.import_file)
    elif args.import_dir:
        if not api_key:
            print("Error: ANTHROPIC_API_KEY not set in .env")
            sys.exit(1)
        cmd_import_dir(config, api_key, args.import_dir)
    else:
        if not api_key:
            print("Error: ANTHROPIC_API_KEY not set in .env")
            print("Copy .env.example to .env and fill in your API key")
            sys.exit(1)
        cmd_start(config, api_key)


if __name__ == "__main__":
    main()
