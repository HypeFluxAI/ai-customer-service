"""知识库向量存储 — ChromaDB + 多语言 embedding"""

import logging
from pathlib import Path

logger = logging.getLogger("ai_cs.knowledge.store")


class KnowledgeStore:
    """基于 ChromaDB 的知识库存储和检索"""

    def __init__(self, persist_dir: str, embedding_model: str = None):
        self.persist_dir = Path(persist_dir)
        self.persist_dir.mkdir(parents=True, exist_ok=True)

        import chromadb
        self.client = chromadb.PersistentClient(path=str(self.persist_dir))

        # 使用 sentence-transformers embedding
        ef = None
        if embedding_model:
            try:
                from chromadb.utils.embedding_functions import SentenceTransformerEmbeddingFunction
                ef = SentenceTransformerEmbeddingFunction(model_name=embedding_model)
                logger.info(f"Loaded embedding model: {embedding_model}")
            except Exception as e:
                logger.warning(f"Failed to load embedding model: {e}, using default")

        self.kb_collection = self.client.get_or_create_collection(
            name="knowledge_base",
            embedding_function=ef,
        )
        self.learned_collection = self.client.get_or_create_collection(
            name="learned_qa",
            embedding_function=ef,
        )

    def add_documents(self, texts: list[str], metadatas: list[dict] = None,
                      ids: list[str] = None):
        """添加文档到知识库"""
        if not ids:
            import hashlib
            ids = [hashlib.md5(t.encode()).hexdigest()[:12] for t in texts]

        # ChromaDB 不允许重复 ID，先删除已有的
        existing = self.kb_collection.get(ids=ids)
        if existing["ids"]:
            self.kb_collection.delete(ids=existing["ids"])

        self.kb_collection.add(
            documents=texts,
            metadatas=metadatas or [{}] * len(texts),
            ids=ids,
        )
        logger.info(f"Added {len(texts)} documents to knowledge base")

    def search(self, query: str, n_results: int = 5) -> list[dict]:
        """语义搜索知识库"""
        results = []

        # 搜索主知识库
        try:
            kb_results = self.kb_collection.query(
                query_texts=[query],
                n_results=min(n_results, self.kb_collection.count() or 1),
            )
            for i, doc in enumerate(kb_results["documents"][0]):
                meta = kb_results["metadatas"][0][i] if kb_results["metadatas"] else {}
                dist = kb_results["distances"][0][i] if kb_results["distances"] else 1.0
                results.append({
                    "text": doc,
                    "source": "kb",
                    "metadata": meta,
                    "distance": dist,
                    "priority": 1,  # 主 KB 优先级高
                })
        except Exception as e:
            logger.warning(f"KB search error: {e}")

        # 搜索自学习知识库
        try:
            if self.learned_collection.count() > 0:
                learned_results = self.learned_collection.query(
                    query_texts=[query],
                    n_results=min(3, self.learned_collection.count()),
                )
                for i, doc in enumerate(learned_results["documents"][0]):
                    meta = learned_results["metadatas"][0][i] if learned_results["metadatas"] else {}
                    dist = learned_results["distances"][0][i] if learned_results["distances"] else 1.0
                    results.append({
                        "text": doc,
                        "source": "learned",
                        "metadata": meta,
                        "distance": dist,
                        "priority": 2,  # 自学习优先级低
                    })
        except Exception as e:
            logger.debug(f"Learned search error: {e}")

        # 按距离排序，主 KB 优先
        results.sort(key=lambda r: (r["priority"], r["distance"]))
        return results[:n_results]

    def add_learned(self, question: str, answer: str, metadata: dict = None):
        """添加自学习 Q&A 对"""
        import hashlib
        doc_id = hashlib.md5(f"{question}|{answer}".encode()).hexdigest()[:12]
        text = f"Q: {question}\nA: {answer}"

        meta = metadata or {}
        meta["type"] = "learned_qa"

        try:
            self.learned_collection.add(
                documents=[text],
                metadatas=[meta],
                ids=[f"learn_{doc_id}"],
            )
            logger.info(f"Added learned Q&A: {question[:50]}...")
        except Exception as e:
            logger.error(f"Failed to add learned Q&A: {e}")

    def delete_by_source(self, source_file: str):
        """删除指定来源文件的所有文档"""
        try:
            results = self.kb_collection.get(
                where={"source_file": source_file}
            )
            if results["ids"]:
                self.kb_collection.delete(ids=results["ids"])
                logger.info(f"Deleted {len(results['ids'])} documents from {source_file}")
        except Exception as e:
            logger.error(f"Delete by source error: {e}")

    @property
    def kb_count(self) -> int:
        return self.kb_collection.count()

    @property
    def learned_count(self) -> int:
        return self.learned_collection.count()
