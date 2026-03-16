"""截图模块 — 使用 mss 快速截取指定窗口区域"""

import logging
from io import BytesIO
from PIL import Image

try:
    import mss
except ImportError:
    mss = None

logger = logging.getLogger("ai_cs.capture.screenshot")


def capture_region(left: int, top: int, width: int, height: int) -> Image.Image | None:
    """截取屏幕指定区域"""
    if not mss:
        logger.error("mss not installed")
        return None

    try:
        with mss.mss() as sct:
            region = {"left": left, "top": top, "width": width, "height": height}
            img = sct.grab(region)
            return Image.frombytes("RGB", img.size, img.bgra, "raw", "BGRX")
    except Exception as e:
        logger.error(f"Screenshot failed: {e}")
        return None


def capture_window(hwnd_rect: tuple) -> Image.Image | None:
    """截取窗口区域 (left, top, right, bottom)"""
    left, top, right, bottom = hwnd_rect
    width = right - left
    height = bottom - top
    if width <= 0 or height <= 0:
        return None
    return capture_region(left, top, width, height)


def image_to_base64(img: Image.Image, fmt: str = "PNG") -> str:
    """将 PIL Image 转为 base64 字符串（用于 Claude Vision API）"""
    import base64
    buf = BytesIO()
    img.save(buf, format=fmt)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def save_screenshot(img: Image.Image, path: str):
    """保存截图到文件"""
    img.save(path, format="PNG")
