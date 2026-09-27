"""mem0 OSS 2.x, run fully local/pi-bridged, fed exactly what the book provider gets.

  LLM       OpenAI-compatible endpoint: MEM0_LLM_BASE_URL + MEM0_LLM_MODEL
            (llama-server for qwen35, or pi-bridge.mjs for OpenCode Go models)
  embedder  EmbeddingGemma on llama-embed (MEM0_EMBED_URL), 768 dims
  store     embedded Qdrant under the run's store dir
  input     one message per turn, "Speaker: text", after a "Session date: YYYY-MM-DD"
            line — the same lines and date book.py gives pi-book
  k         AMB's mem0 default: 20 memories
"""
import os
import uuid
from pathlib import Path

from ..models import Document
from .base import MemoryProvider
from .book import _lines

os.environ.setdefault("MEM0_TELEMETRY", "False")


class Mem0LocalMemoryProvider(MemoryProvider):
    name = "mem0-local"
    description = "mem0 OSS 2.x (additive extraction) with a local/pi-bridged LLM, EmbeddingGemma and embedded Qdrant."
    kind = "local"
    concurrency = 1

    def __init__(self, k: int = 20):
        self.k = int(os.environ.get("MEM0_K") or k)
        self._memory = None

    def prepare(self, store_dir: Path, unit_ids: set[str] | None = None, reset: bool = True) -> None:
        from mem0 import Memory

        qdrant = store_dir / "qdrant"
        if reset and qdrant.exists():
            import shutil

            shutil.rmtree(qdrant)
        qdrant.mkdir(parents=True, exist_ok=True)
        self._memory = Memory.from_config({
            "llm": {
                "provider": "openai",
                "config": {
                    "model": os.environ.get("MEM0_LLM_MODEL", "qwen35"),
                    "openai_base_url": os.environ.get("MEM0_LLM_BASE_URL", "http://127.0.0.1:8081/v1"),
                    "api_key": "local",
                    "temperature": 0.0,
                },
            },
            "embedder": {
                "provider": "openai",
                "config": {
                    "model": "embeddinggemma",
                    "openai_base_url": os.environ.get("MEM0_EMBED_URL", "http://127.0.0.1:8090/v1"),
                    "api_key": "local",
                    "embedding_dims": 768,
                },
            },
            "vector_store": {
                "provider": "qdrant",
                "config": {"collection_name": "bench", "path": str(qdrant), "embedding_model_dims": 768, "on_disk": True},
            },
            "history_db_path": str(store_dir / "history.db"),
        })

    def ingest(self, documents: list[Document]) -> None:
        import sys, time

        for doc in sorted(documents, key=lambda d: (d.user_id or "", d.timestamp or "", d.id)):
            date = (doc.timestamp or "")[:10]
            messages = [{"role": "user", "content": f"Session date: {date}"}] + [
                {"role": "user", "content": line} for line in _lines(doc.content)
            ]
            t0 = time.time()
            r = self._memory.add(messages, user_id=doc.user_id or "default", metadata={"doc_id": doc.id, "session_date": date})
            n = len(r.get("results", [])) if isinstance(r, dict) else "?"
            print(f"[mem0-local] {doc.id}: {n} memory events ({(time.time() - t0) * 1000:.0f} ms)", file=sys.stderr, flush=True)

    def retrieve(self, query: str, k: int = 10, user_id: str | None = None, query_timestamp: str | None = None):
        res = self._memory.search(query, top_k=self.k, filters={"user_id": user_id or "default"})
        entries = res.get("results", []) if isinstance(res, dict) else res
        docs = []
        for r in entries:
            meta = r.get("metadata") or {}
            date = meta.get("session_date")
            docs.append(Document(id=r.get("id") or uuid.uuid4().hex, content=f"{r['memory']}" + (f"\n(session date: {date})" if date else "")))
        # No raw response: LoCoMo's prompt would show json.dumps(raw) instead of the context.
        return docs, None
