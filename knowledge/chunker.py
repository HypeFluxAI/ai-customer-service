"""文本分块 — 将长文档切分为适合向量存储的块"""

import re
import logging

logger = logging.getLogger("ai_cs.knowledge.chunker")


def chunk_text(text: str, chunk_size: int = 500, overlap: int = 50) -> list[str]:
    """将文本分割为重叠块

    优先在段落/句子边界处分割，避免在韩语/中文词汇中间断开
    """
    if len(text) <= chunk_size:
        return [text]

    # 段落分割
    paragraphs = re.split(r'\n\s*\n', text)

    chunks = []
    current = ""

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue

        # 段落本身就超过 chunk_size，需要按句子分割
        if len(para) > chunk_size:
            if current:
                chunks.append(current.strip())
                current = current[-overlap:] if overlap else ""

            sentences = _split_sentences(para)
            for sent in sentences:
                if len(current) + len(sent) + 1 <= chunk_size:
                    current = (current + " " + sent).strip()
                else:
                    if current:
                        chunks.append(current.strip())
                        current = current[-overlap:] if overlap else ""
                    current = (current + " " + sent).strip()
        else:
            if len(current) + len(para) + 2 <= chunk_size:
                current = (current + "\n\n" + para).strip()
            else:
                if current:
                    chunks.append(current.strip())
                    current = current[-overlap:] if overlap else ""
                current = (current + "\n\n" + para).strip()

    if current.strip():
        chunks.append(current.strip())

    return [c for c in chunks if c]


def _split_sentences(text: str) -> list[str]:
    """韩语/中文友好的句子分割"""
    # 匹配中文、韩文、英文句号和换行
    parts = re.split(r'(?<=[.!?。！？\n])\s*', text)
    return [p.strip() for p in parts if p.strip()]
