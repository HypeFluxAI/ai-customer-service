"""KakaoTalk 桌面自动化 — 三种模式：Win32 API 后台 / 前台剪贴板 / pywinauto

推荐模式 (mode="win32"):
  通过 Win32 SendMessage 直接向 KakaoTalk 输入框发送文本和按键
  不需要窗口前台，不干扰用户操作

回退模式 (mode="foreground"):
  置顶窗口 → 点击输入框 → 剪贴板粘贴 → Enter 发送
  需要窗口前台，会干扰用户

KakaoTalk PC 版窗口结构:
  EVA_Window_Dblclk (聊天窗口)
    ├── EVA_ChildWindow (消息区)
    ├── RICHEDIT50W    (输入框) ← 目标控件
    └── EVA_ChildWindow (按钮区)
       └── Button (전송/发送)
"""

import time
import ctypes
import logging

logger = logging.getLogger("ai_cs.automation.kakao")

try:
    import win32gui
    import win32con
    import win32api
    import win32clipboard
    HAS_WIN32 = True
except ImportError:
    HAS_WIN32 = False
    logger.warning("pywin32 not installed, win32 mode unavailable")

# Win32 常量
WM_CHAR = 0x0102
WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
WM_PASTE = 0x0302
WM_SETTEXT = 0x000C
WM_SETFOCUS = 0x0007
EM_SETSEL = 0x00B1
EM_REPLACESEL = 0x00C2
VK_RETURN = 0x0D
VK_CONTROL = 0x11

# KakaoTalk 输入框的已知类名（按优先级）
EDIT_CLASS_NAMES = [
    "RICHEDIT50W",      # KakaoTalk PC 主要使用
    "RichEdit20W",
    "RichEditD2DPT",
    "Edit",
]


def find_edit_control(chat_hwnd: int) -> int | None:
    """在 KakaoTalk 聊天窗口中查找输入框控件

    遍历子窗口，按已知类名匹配，返回 hwnd
    """
    if not HAS_WIN32:
        return None

    found = []

    def callback(hwnd, _):
        cls = win32gui.GetClassName(hwnd)
        if cls in EDIT_CLASS_NAMES:
            rect = win32gui.GetWindowRect(hwnd)
            found.append((hwnd, cls, rect))
        return True

    try:
        win32gui.EnumChildWindows(chat_hwnd, callback, None)
    except Exception as e:
        logger.error(f"EnumChildWindows failed: {e}")
        return None

    if not found:
        logger.warning("No edit control found in chat window")
        return None

    # 如果有多个匹配，选择最靠下的（输入框通常在窗口底部）
    if len(found) > 1:
        found.sort(key=lambda x: x[2][3], reverse=True)  # 按 bottom 坐标降序
        logger.debug(f"Multiple edit controls found, using bottom-most: {found[0]}")

    hwnd, cls, rect = found[0]
    logger.debug(f"Edit control: hwnd={hwnd}, class={cls}, rect={rect}")
    return hwnd


def find_send_button(chat_hwnd: int) -> int | None:
    """查找发送按钮（전송）"""
    if not HAS_WIN32:
        return None

    buttons = []

    def callback(hwnd, _):
        cls = win32gui.GetClassName(hwnd)
        if "button" in cls.lower():
            text = win32gui.GetWindowText(hwnd)
            rect = win32gui.GetWindowRect(hwnd)
            buttons.append((hwnd, text, rect))
        return True

    try:
        win32gui.EnumChildWindows(chat_hwnd, callback, None)
    except Exception:
        pass

    # 查找 "전송" (发送) 按钮
    for hwnd, text, rect in buttons:
        if "전송" in text or "send" in text.lower():
            return hwnd

    return None


def send_message_win32(chat_hwnd: int, text: str) -> bool:
    """通过 Win32 API 后台发送消息（推荐方式）

    流程：
    1. 找到聊天窗口的 RICHEDIT50W 输入框
    2. 通过剪贴板 + WM_PASTE 写入韩语文本
    3. 发送 VK_RETURN 按键发送消息
    """
    if not HAS_WIN32:
        logger.error("pywin32 not available")
        return False

    # 验证窗口
    if not win32gui.IsWindow(chat_hwnd):
        logger.error(f"Invalid window handle: {chat_hwnd}")
        return False

    # 查找输入框
    edit_hwnd = find_edit_control(chat_hwnd)
    if not edit_hwnd:
        logger.error("Cannot find edit control in chat window")
        return False

    try:
        # 清空输入框：全选 + 删除
        text_len = win32gui.SendMessage(edit_hwnd, win32con.WM_GETTEXTLENGTH, 0, 0)
        if text_len > 0:
            win32gui.SendMessage(edit_hwnd, EM_SETSEL, 0, -1)  # 全选
            win32gui.SendMessage(edit_hwnd, EM_REPLACESEL, True, "")  # 替换为空

        # 通过剪贴板写入文本（韩语需要剪贴板方式）
        _clipboard_set(text)
        time.sleep(0.05)

        # 发送 WM_PASTE
        win32gui.SendMessage(edit_hwnd, WM_PASTE, 0, 0)
        time.sleep(0.1)

        # 验证文本已写入
        current_len = win32gui.SendMessage(edit_hwnd, win32con.WM_GETTEXTLENGTH, 0, 0)
        if current_len == 0:
            logger.warning("Text not pasted, retrying with WM_CHAR")
            # 回退：逐字符发送（仅限 ASCII，韩语不行）
            for ch in text:
                win32gui.SendMessage(edit_hwnd, WM_CHAR, ord(ch), 0)
            time.sleep(0.1)

        # 发送 Enter 键
        win32gui.SendMessage(edit_hwnd, WM_KEYDOWN, VK_RETURN, 0)
        time.sleep(0.05)
        win32gui.SendMessage(edit_hwnd, WM_KEYUP, VK_RETURN, 0)

        logger.info(f"[win32] Message sent: {text[:50]}...")
        return True

    except Exception as e:
        logger.error(f"Win32 send failed: {e}")
        return False


def send_message_foreground(chat_hwnd: int, text: str,
                            input_offset_y: int = -40) -> bool:
    """前台模式发送消息（回退方式）

    需要窗口前台，通过鼠标点击+剪贴板粘贴
    """
    import pyautogui
    pyautogui.FAILSAFE = True
    pyautogui.PAUSE = 0.1

    if not HAS_WIN32:
        logger.error("pywin32 not available")
        return False

    if not win32gui.IsWindow(chat_hwnd):
        logger.error(f"Invalid window handle: {chat_hwnd}")
        return False

    try:
        # 置顶窗口
        if win32gui.IsIconic(chat_hwnd):
            win32gui.ShowWindow(chat_hwnd, win32con.SW_RESTORE)
        win32gui.SetForegroundWindow(chat_hwnd)
        time.sleep(0.3)

        # 获取窗口坐标
        rect = win32gui.GetWindowRect(chat_hwnd)
        left, top, right, bottom = rect
        width = right - left

        # 点击输入框
        input_x = left + width // 2
        input_y = bottom + input_offset_y
        pyautogui.click(input_x, input_y)
        time.sleep(0.2)

        # 清空
        pyautogui.hotkey("ctrl", "a")
        time.sleep(0.05)
        pyautogui.press("delete")
        time.sleep(0.1)

        # 剪贴板粘贴
        _clipboard_set(text)
        time.sleep(0.05)
        pyautogui.hotkey("ctrl", "v")
        time.sleep(0.3)

        # 发送
        pyautogui.press("enter")
        time.sleep(0.2)

        logger.info(f"[foreground] Message sent: {text[:50]}...")
        return True

    except Exception as e:
        logger.error(f"Foreground send failed: {e}")
        return False


def send_message(hwnd: int, text: str, title_pattern: str = "",
                 input_offset_y: int = -40, mode: str = "auto") -> bool:
    """发送消息的统一入口

    Args:
        hwnd: KakaoTalk 聊天窗口句柄
        text: 要发送的消息
        title_pattern: 窗口标题模式（用于验证，可选）
        input_offset_y: 前台模式下输入框偏移
        mode: "win32" | "foreground" | "auto"
              auto = 先尝试 win32，失败则回退 foreground
    """
    # 标题验证
    if HAS_WIN32 and title_pattern:
        try:
            title = win32gui.GetWindowText(hwnd)
            if title_pattern.lower() not in title.lower():
                logger.error(f"Window title mismatch: '{title}' vs '{title_pattern}'")
                return False
        except Exception:
            pass

    if mode == "win32":
        return send_message_win32(hwnd, text)
    elif mode == "foreground":
        return send_message_foreground(hwnd, text, input_offset_y)
    else:  # auto
        if send_message_win32(hwnd, text):
            return True
        logger.info("Win32 mode failed, falling back to foreground mode")
        return send_message_foreground(hwnd, text, input_offset_y)


def get_chat_text(chat_hwnd: int) -> str | None:
    """读取聊天窗口的输入框当前文本（用于验证）"""
    if not HAS_WIN32:
        return None

    edit_hwnd = find_edit_control(chat_hwnd)
    if not edit_hwnd:
        return None

    try:
        length = win32gui.SendMessage(edit_hwnd, win32con.WM_GETTEXTLENGTH, 0, 0)
        if length == 0:
            return ""

        buf = ctypes.create_unicode_buffer(length + 1)
        win32gui.SendMessage(edit_hwnd, win32con.WM_GETTEXT, length + 1, buf)
        return buf.value
    except Exception as e:
        logger.error(f"GetText failed: {e}")
        return None


def _clipboard_set(text: str):
    """设置剪贴板内容（Win32 原生方式，比 pyperclip 更可靠）"""
    if HAS_WIN32:
        try:
            win32clipboard.OpenClipboard()
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardText(text, win32clipboard.CF_UNICODETEXT)
            win32clipboard.CloseClipboard()
            return
        except Exception as e:
            logger.debug(f"Win32 clipboard failed: {e}, trying pyperclip")

    # 回退到 pyperclip
    try:
        import pyperclip
        pyperclip.copy(text)
    except Exception as e:
        logger.error(f"Clipboard set failed: {e}")
