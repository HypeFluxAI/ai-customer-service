"""多格式文件导入器 — 支持 PDF/DOCX/TXT/MD/CSV/Excel"""

import logging
from pathlib import Path

logger = logging.getLogger("ai_cs.knowledge.importer")


def import_file(file_path: str) -> list[tuple[str, dict]]:
    """导入文件，返回 (text, metadata) 列表"""
    path = Path(file_path)
    if not path.exists():
        logger.error(f"File not found: {file_path}")
        return []

    ext = path.suffix.lower()
    source_meta = {"source_file": path.name, "file_type": ext}

    try:
        if ext == ".pdf":
            return _import_pdf(path, source_meta)
        elif ext == ".docx":
            return _import_docx(path, source_meta)
        elif ext in (".txt", ".md"):
            return _import_text(path, source_meta)
        elif ext == ".csv":
            return _import_csv(path, source_meta)
        elif ext in (".xlsx", ".xls"):
            return _import_excel(path, source_meta)
        elif ext == ".json":
            return _import_json(path, source_meta)
        else:
            logger.warning(f"Unsupported file type: {ext}")
            return []
    except Exception as e:
        logger.error(f"Import error for {file_path}: {e}")
        return []


def _import_pdf(path: Path, meta: dict) -> list[tuple[str, dict]]:
    from PyPDF2 import PdfReader
    reader = PdfReader(str(path))
    results = []
    for i, page in enumerate(reader.pages):
        text = page.extract_text()
        if text and text.strip():
            m = {**meta, "page": i + 1}
            results.append((text.strip(), m))
    logger.info(f"Imported PDF: {path.name}, {len(results)} pages")
    return results


def _import_docx(path: Path, meta: dict) -> list[tuple[str, dict]]:
    from docx import Document
    doc = Document(str(path))
    paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
    # 合并短段落
    text = "\n\n".join(paragraphs)
    if text:
        logger.info(f"Imported DOCX: {path.name}, {len(paragraphs)} paragraphs")
        return [(text, meta)]
    return []


def _import_text(path: Path, meta: dict) -> list[tuple[str, dict]]:
    import chardet
    raw = path.read_bytes()
    encoding = chardet.detect(raw)["encoding"] or "utf-8"
    text = raw.decode(encoding, errors="replace")
    if text.strip():
        logger.info(f"Imported text: {path.name}, {len(text)} chars")
        return [(text.strip(), meta)]
    return []


def _import_csv(path: Path, meta: dict) -> list[tuple[str, dict]]:
    import pandas as pd
    df = pd.read_csv(str(path))
    results = []
    for _, row in df.iterrows():
        text = " | ".join(f"{col}: {val}" for col, val in row.items()
                          if pd.notna(val) and str(val).strip())
        if text:
            results.append((text, meta))
    logger.info(f"Imported CSV: {path.name}, {len(results)} rows")
    return results


def _import_excel(path: Path, meta: dict) -> list[tuple[str, dict]]:
    import pandas as pd
    df = pd.read_excel(str(path))
    results = []
    for _, row in df.iterrows():
        text = " | ".join(f"{col}: {val}" for col, val in row.items()
                          if pd.notna(val) and str(val).strip())
        if text:
            results.append((text, meta))
    logger.info(f"Imported Excel: {path.name}, {len(results)} rows")
    return results


def _import_json(path: Path, meta: dict) -> list[tuple[str, dict]]:
    import json
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    results = []
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict):
                # Q&A 格式: {"question": ..., "answer": ...}
                if "question" in item and "answer" in item:
                    text = f"Q: {item['question']}\nA: {item['answer']}"
                    m = {**meta, "category": item.get("category", "")}
                    results.append((text, m))
                else:
                    text = json.dumps(item, ensure_ascii=False)
                    results.append((text, meta))
            elif isinstance(item, str):
                results.append((item, meta))
    elif isinstance(data, dict):
        for key, val in data.items():
            results.append((f"{key}: {val}", meta))

    logger.info(f"Imported JSON: {path.name}, {len(results)} entries")
    return results
