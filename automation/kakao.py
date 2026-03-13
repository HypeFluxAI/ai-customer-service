"""KakaoTalk 桌面自动化 — 鼠标点击 + 剪贴板粘贴发送消息"""

import time
import logging

import pyperclip
import pyautogui

from capture.window import verify_window, get_window_rect, bring_to_front

logger = logging.getLogger("ai_cs.automation.kakao")

# 安全设置
pyautogui.FAILSAFE = True   # 鼠标移到左上角触发 FailSafe
pyautogui.PAUSE = 0.1       # 每个动作之间暂停


def send_message(hwnd: int, text: str, title_pattern: str = "",
                 input_offset_y: int = -40) -> bool:
    """在 KakaoTalk 聊天窗口中发送消息

    流程：
    1. 验证窗口有效
    2. 置顶窗口
    3. 点击输入框（窗口底部）
    4. 通过剪贴板粘贴韩语文本
    5. 按 Enter 发送

    Args:
        hwnd: 窗口句柄
        text: 要发送的消息文本
        title_pattern: 窗口标题匹配模式（用于验证）
        input_offset_y: 输入框相对于窗口底部的偏移（负值）

    Returns:
        True if sent successfully
    """
    # 1. 验证窗口
    if not verify_window(hwnd, title_pattern):
        logger.error(f"Window verification failed: hwnd={hwnd}")
        return False

    # 2. 获取最新窗口坐标
    rect = get_window_rect(hwnd)
    if not rect:
        logger.error("Failed to get window rect")
        return False

    left, top, right, bottom = rect
    width = right - left
    height = bottom - top

    # 3. 置顶窗口
    if not bring_to_front(hwnd):
        logger.warning("Failed to bring window to front, trying anyway")

    time.sleep(0.3)

    # 4. 再次验证（窗口可能在置顶过程中被切换）
    if not verify_window(hwnd, title_pattern):
        logger.error("Window changed during automation, aborting")
        return False

    # 5. 点击输入框区域（窗口底部偏上）
    input_x = left + width // 2
    input_y = bottom + input_offset_y
    logger.debug(f"Clicking input field at ({input_x}, {input_y})")
    pyautogui.click(input_x, input_y)
    time.sleep(0.2)

    # 6. 清空输入框
    pyautogui.hotkey("ctrl", "a")
    time.sleep(0.05)
    pyautogui.press("delete")
    time.sleep(0.1)

    # 7. 通过剪贴板粘贴文本（韩语必须用这种方式）
    old_clipboard = ""
    try:
        old_clipboard = pyperclip.paste()
    except Exception:
        pass

    pyperclip.copy(text)
    time.sleep(0.05)
    pyautogui.hotkey("ctrl", "v")
    time.sleep(0.3)

    # 8. 按 Enter 发送
    pyautogui.press("enter")
    time.sleep(0.2)

    # 9. 恢复剪贴板
    try:
        pyperclip.copy(old_clipboard)
    except Exception:
        pass

    logger.info(f"Message sent: {text[:50]}...")
    return True


def click_chat_input(hwnd: int, input_offset_y: int = -40) -> bool:
    """仅点击输入框，不发送（用于测试）"""
    if not verify_window(hwnd):
        return False

    rect = get_window_rect(hwnd)
    if not rect:
        return False

    left, top, right, bottom = rect
    width = right - left
    input_x = left + width // 2
    input_y = bottom + input_offset_y

    bring_to_front(hwnd)
    time.sleep(0.3)
    pyautogui.click(input_x, input_y)
    return True
