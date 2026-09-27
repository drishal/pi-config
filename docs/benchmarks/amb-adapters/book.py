"""pi pi-book provider: drives `node cli.ts serve` over JSON lines.

Variants
  book          raw sessions as Markdown sections, BM25 + EmbeddingGemma, RRF
  book-kw       the same, keyword (BM25) only — the embedding ablation
  book-extract  each session goes through pi-book's capture model first
                (the "conversation" profile); only the extracted notes are searched
  book-tiered   book-extract plus the medium tier: a journal digest per session
                (no expiry here), searched together with the notes

Env
  BOOK_CLI        path to cli.ts (default ~/.pi/agent/extensions/pi-book/cli.ts)
  BOOK_LLM        JSON for memory.llm (default: raw local llama-server on :8081)
  BOOK_EMBED_URL  embeddings endpoint (default http://127.0.0.1:8090/v1)
  BOOK_K          override the k the mode asks for (token-parity runs)
  BOOK_BUDGET     budgeted read instead of top-k: token budget (e.g. 1000 = mem0's size)
  BOOK_UNIT       budgeted read unit: bullet (default) | section
  BOOK_NEIGHBORS  budgeted bullet reads: bullets of context on each side (default 0)
"""
import json
import os
import subprocess
import sys
import threading
from pathlib import Path

from ..models import Document
from .base import MemoryProvider

_CLI = os.environ.get("BOOK_CLI", str(Path.home() / ".pi/agent/extensions/pi-book/cli.ts"))
_DEFAULT_LLM = {
    "mode": "raw",
    "baseUrl": "http://127.0.0.1:8081/v1",
    "model": "qwen35",
    "extraBody": {"chat_template_kwargs": {"enable_thinking": False}},
    "timeoutMs": 300000,
}


def _lines(content: str) -> list[str]:
    """LoCoMo sessions are JSON turn lists; anything else is split on newlines."""
    try:
        turns = json.loads(content)
    except (ValueError, TypeError):
        turns = None
    if isinstance(turns, list) and turns and isinstance(turns[0], dict):
        out = []
        for t in turns:
            who = t.get("speaker") or t.get("role") or "?"
            text = (t.get("text") or t.get("content") or "").strip()
            if t.get("blip_caption"):
                text += f" [shares a photo: {t['blip_caption']}]"
            if text:
                out.append(f"{who}: {text}")
        return out
    return [l for l in content.splitlines() if l.strip()]


class BookMemoryProvider(MemoryProvider):
    name = "book"
    description = "pi pi-book: Markdown sections searched with BM25 + EmbeddingGemma (RRF)."
    kind = "local"
    concurrency = 1
    extract = False
    embed = True
    tiered = False

    def __init__(self):
        self._proc: subprocess.Popen | None = None
        self._lock = threading.Lock()

    def prepare(self, store_dir: Path, unit_ids: set[str] | None = None, reset: bool = True) -> None:
        store_dir.mkdir(parents=True, exist_ok=True)
        llm = json.loads(os.environ["BOOK_LLM"]) if os.environ.get("BOOK_LLM") else _DEFAULT_LLM
        embed_url = os.environ.get("BOOK_EMBED_URL", "http://127.0.0.1:8090/v1") if self.embed else ""
        cfg = store_dir / "memory-config.json"
        journal = {"enabled": self.tiered, "ttlDays": 0, "recall": 2, "maxBullets": 8}
        cfg.write_text(json.dumps({"memory": {"llm": llm, "embed": {"url": embed_url, "model": "embeddinggemma"}, "journal": journal}}))
        env = dict(os.environ, PI_MEMORY_DIR=str(store_dir / "book"), PI_MEMORY_CONFIG=str(cfg))
        self._proc = subprocess.Popen(
            ["node", _CLI, "serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env, bufsize=1
        )
        if reset:
            self._call({"cmd": "reset"})

    def _call(self, req: dict) -> dict:
        with self._lock:
            assert self._proc and self._proc.stdin and self._proc.stdout
            self._proc.stdin.write(json.dumps(req) + "\n")
            self._proc.stdin.flush()
            line = self._proc.stdout.readline()
        if not line:
            raise RuntimeError("pi-book serve exited")
        res = json.loads(line)
        if not res.get("ok"):
            raise RuntimeError(f"pi-book: {res.get('error')}")
        return res

    def ingest(self, documents: list[Document]) -> None:
        for doc in sorted(documents, key=lambda d: (d.user_id or "", d.timestamp or "", d.id)):
            res = self._call({
                "cmd": "ingest",
                "project": doc.user_id or "default",
                "title": doc.id,
                "date": (doc.timestamp or "")[:10],
                "lines": _lines(doc.content),
                "extract": self.extract,
            })
            if self.extract:
                print(f"[{self.name}] {doc.id}: +{res.get('applied')} refused {res.get('refused')} journal {res.get('journal')} ({res.get('ms')} ms)", file=sys.stderr, flush=True)

    def retrieve(self, query: str, k: int = 10, user_id: str | None = None, query_timestamp: str | None = None):
        k = int(os.environ.get("BOOK_K") or k)
        req = {"cmd": "retrieve", "project": user_id or "default", "query": query, "k": k}
        if os.environ.get("BOOK_BUDGET"):
            req.update(budget=int(os.environ["BOOK_BUDGET"]), unit=os.environ.get("BOOK_UNIT", "bullet"),
                       neighbors=int(os.environ.get("BOOK_NEIGHBORS", "0")))
        res = self._call(req)
        docs = [Document(id=d["id"], content=d["content"], user_id=user_id) for d in res["docs"]]
        if res.get("error"):
            print(f"[book] {res.get('mode')} search: {res['error']}", file=sys.stderr, flush=True)
        # No raw response: LoCoMo's prompt would show json.dumps(raw) instead of the context.
        return docs, None

    def cleanup(self) -> None:
        if self._proc:
            self._proc.stdin.close()
            try:
                self._proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._proc.kill()
            self._proc = None


class BookKeywordMemoryProvider(BookMemoryProvider):
    name = "book-kw"
    description = "pi pi-book, BM25 only (embedding ablation)."
    embed = False


class BookExtractMemoryProvider(BookMemoryProvider):
    name = "book-extract"
    description = "pi pi-book with LLM capture: sessions become extracted notes, then hybrid search."
    extract = True


class BookTieredMemoryProvider(BookMemoryProvider):
    name = "book-tiered"
    description = "pi pi-book with LLM capture into long-term notes plus a per-session journal digest."
    extract = True
    tiered = True
