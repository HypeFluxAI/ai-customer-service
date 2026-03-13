"""截图差异检测 — 只在聊天区域有变化时触发分析"""

import logging
from PIL import Image, ImageChops
import numpy as np

logger = logging.getLogger("ai_cs.capture.diff")


def compute_diff_ratio(img1: Image.Image, img2: Image.Image,
                       region: str = "bottom_half") -> float:
    """计算两张截图的差异比例 (0.0 ~ 1.0)

    region: "full" | "bottom_half" | "bottom_third"
    新消息通常出现在聊天窗口底部，只比较底部区域可减少误触发
    """
    if img1.size != img2.size:
        img2 = img2.resize(img1.size)

    # 裁剪到目标区域
    w, h = img1.size
    if region == "bottom_half":
        box = (0, h // 2, w, h)
    elif region == "bottom_third":
        box = (0, h * 2 // 3, w, h)
    else:
        box = (0, 0, w, h)

    crop1 = img1.crop(box)
    crop2 = img2.crop(box)

    # 像素级差异
    diff = ImageChops.difference(crop1.convert("L"), crop2.convert("L"))
    arr = np.array(diff)

    # 超过阈值的像素占比（阈值 30 过滤渲染噪声）
    changed_pixels = np.sum(arr > 30)
    total_pixels = arr.size

    ratio = changed_pixels / total_pixels if total_pixels > 0 else 0.0
    return ratio


class DiffDetector:
    """维护上一帧截图，检测是否有新消息"""

    def __init__(self, threshold: float = 0.05):
        self.threshold = threshold
        self.last_image: Image.Image | None = None

    def has_changes(self, current: Image.Image) -> bool:
        if self.last_image is None:
            self.last_image = current.copy()
            return True  # 首帧总是分析

        ratio = compute_diff_ratio(self.last_image, current)
        self.last_image = current.copy()

        if ratio > self.threshold:
            logger.info(f"Change detected: {ratio:.2%} (threshold: {self.threshold:.2%})")
            return True

        logger.debug(f"No significant change: {ratio:.2%}")
        return False

    def reset(self):
        self.last_image = None
