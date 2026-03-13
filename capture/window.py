"""KakaoTalk 窗口检测 — 使用 win32gui 查找和定位聊天窗口"""

import logging
import re

try:
    import win32gui
    import win32con
    import win32process
except ImportError:
    win32gui = None

logger = logging.getLogger("ai_cs.capture.window")


class WindowInfo:
    def __init__(self, hwnd: int, title: str, rect: tuple):
        self.hwnd = hwnd
        self.title = title
        self.left, self.top, self.right, self.bottom = rect

    @property
    def width(self):
        return self.right - self.left

    @property
    def height(self):
        return self.bottom - self.top

    @property
    def rect(self):
        return (self.left, self.top, self.right, self.bottom)

    def __repr__(self):
        return f"Window(hwnd={self.hwnd}, title='{self.title}', {self.width}x{self.height})"


def find_kakao_windows() -> list[WindowInfo]:
    """查找所有 KakaoTalk 窗口"""
    if not win32gui:
        logger.error("pywin32 not installed")
        return []

    windows = []

    def callback(hwnd, _):
        if not win32gui.IsWindowVisible(hwnd):
            return True
        title = win32gui.GetWindowText(hwnd)
        cls = win32gui.GetClassName(hwnd)
        # KakaoTalk 聊天窗口类名
        if cls in ("EVA_Window_Dblclk", "#32770", "EVA_Window"):
            rect = win32gui.GetWindowRect(hwnd)
            windows.append(WindowInfo(hwnd, title, rect))
        return True

    win32gui.EnumWindows(callback, None)
    return windows


def find_chat_window(title_pattern: str) -> WindowInfo | None:
    """根据标题模式查找特定聊天窗口"""
    pattern = re.compile(re.escape(title_pattern), re.IGNORECASE)
    for w in find_kakao_windows():
        if pattern.search(w.title):
            logger.debug(f"Found chat window: {w}")
            return w

    # 回退：搜索所有可见窗口
    result = None

    def callback(hwnd, _):
        nonlocal result
        if not win32gui.IsWindowVisible(hwnd):
            return True
        title = win32gui.GetWindowText(hwnd)
        if pattern.search(title):
            rect = win32gui.GetWindowRect(hwnd)
            result = WindowInfo(hwnd, title, rect)
            return False  # 找到，停止
        return True

    if win32gui:
        try:
            win32gui.EnumWindows(callback, None)
        except Exception:
            pass  # EnumWindows 在回调返回 False 时会抛异常

    return result


def verify_window(hwnd: int, expected_title_part: str = "") -> bool:
    """验证窗口仍然有效且是目标窗口"""
    if not win32gui:
        return False
    try:
        if not win32gui.IsWindow(hwnd):
            return False
        if not win32gui.IsWindowVisible(hwnd):
            return False
        if expected_title_part:
            title = win32gui.GetWindowText(hwnd)
            if expected_title_part.lower() not in title.lower():
                return False
        return True
    except Exception:
        return False


def bring_to_front(hwnd: int) -> bool:
    """将窗口置顶"""
    if not win32gui:
        return False
    try:
        if win32gui.IsIconic(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        win32gui.SetForegroundWindow(hwnd)
        return True
    except Exception as e:
        logger.warning(f"Failed to bring window to front: {e}")
        return False


def get_window_rect(hwnd: int) -> tuple | None:
    """获取窗口最新坐标"""
    if not win32gui:
        return None
    try:
        return win32gui.GetWindowRect(hwnd)
    except Exception:
        return None
