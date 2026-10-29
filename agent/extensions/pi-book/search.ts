/**
 * Hybrid search over the book: BM25 keywords + embedding similarity, fused
 * with reciprocal-rank fusion (RRF). Either side alone still answers — when the
 * embedding server is down, search degrades to keywords instead of failing.
 *
 * The unit is a chunk: a section's heading plus a run of its bullets, capped at
 * CHUNK_CHARS so a long section is still embedded whole (llama-server rejects
 * inputs past its batch size). A hit reports its section, so `read` can widen
 * to the whole section or chapter.
 *
 * Vectors are cached in <root>/.index/vectors.json keyed by content hash and
 * embedding model, so editing one bullet re-embeds one chunk, and the cache can
 * be deleted at any time.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Section } from "./book.ts";

export interface EmbedConfig {
	/** OpenAI-compatible base URL, e.g. http://127.0.0.1:8090/v1. Empty disables vectors. */
	url: string;
	model: string;
	/** A literal key. Prefer apiKeyFrom / apiKeyEnv, so the key is not copied here. */
	apiKey?: string;
	/** Env var holding the key. */
	apiKeyEnv?: string;
	/** A pi provider name: use the key pi keeps for it in auth.json (e.g. "litellm"). */
	apiKeyFrom?: string;
	/** Prepended to queries / documents; EmbeddingGemma and Qwen3-Embedding want task prompts. */
	queryPrefix?: string;
	docPrefix?: string;
	timeoutMs?: number;
	/** The vector side of one search (catching up on new notes + the query) gets this long, then keywords answer alone. */
	searchBudgetMs?: number;
}

export interface Chunk {
	/** Section id plus the chunk's ordinal within it. */
	key: string;
	section: Section;
	text: string;
	/** Bullet units only: the bullet's position among the section's bullets. */
	line?: number;
}

export interface Hit {
	chunk: Chunk;
	score: number;
	/** Rank on each side (1-based), for /memory debugging; absent = not in that list. */
	bm25?: number;
	vector?: number;
	/** Cosine similarity to the query, when vectors were available. */
	cos?: number;
}

const CHUNK_CHARS = 1400;
const RRF_K = 60;

/** Task prompts by model family, used when the config does not set its own. */
export function defaultPrefixes(model: string): { query: string; doc: string } {
	const m = model.toLowerCase();
	if (m.includes("gemma")) return { query: "task: search result | query: ", doc: "title: none | text: " };
	if (m.includes("qwen3-embedding") || m.includes("qwen3_embedding"))
		return { query: "Instruct: Given a question, retrieve memory notes that answer it\nQuery: ", doc: "" };
	if (m.includes("nomic")) return { query: "search_query: ", doc: "search_document: " };
	return { query: "", doc: "" };
}

export function chunkSections(sections: Section[]): Chunk[] {
	const out: Chunk[] = [];
	for (const s of sections) {
		const [head, ...lines] = s.text.split("\n");
		let buf: string[] = [];
		let size = head.length;
		let n = 0;
		const flush = () => {
			if (!buf.length) return;
			out.push({ key: `${s.id}~${n++}`, section: s, text: [head, ...buf].join("\n") });
			buf = [];
			size = head.length;
		};
		for (const line of lines) {
			if (!line.trim()) continue;
			const piece = line.length > CHUNK_CHARS ? `${line.slice(0, CHUNK_CHARS)}…` : line;
			if (size + piece.length + 1 > CHUNK_CHARS) flush();
			buf.push(piece);
			size += piece.length + 1;
		}
		flush();
	}
	return out;
}

/**
 * One unit per bullet, each carrying its heading ("## Editor\n- … Uses Neovim")
 * so a fact is scored with its topic but can be returned on its own — the
 * basis of budgeted reads, which spend tokens only on matching facts.
 */
export function bulletUnits(sections: Section[]): Chunk[] {
	const out: Chunk[] = [];
	for (const s of sections) {
		const [head, ...rest] = s.text.split("\n");
		const lines = rest.filter((l) => l.trim());
		lines.forEach((line, i) => {
			const piece = line.length > CHUNK_CHARS ? `${line.slice(0, CHUNK_CHARS)}…` : line;
			out.push({ key: `${s.id}~b${i}`, section: s, text: `${head}\n${piece}`, line: i });
		});
	}
	return out;
}

/** The section's bullets, in order — what budgeted reads pick lines from. */
export function sectionLines(s: Section): string[] {
	return s.text.split("\n").slice(1).filter((l) => l.trim());
}

// ── BM25 ──────────────────────────────────────────────────────────────────

const STOP = new Set(
	"a an and are as at be but by for from has have i if in is it its me my of on or our so that the their them then there these they this to was we were what when where which who why will with you your do does did how can not no".split(
		" ",
	),
);

/** Light suffix stripping so "commits", "committed" and "committing" meet "commit". */
export function stem(t: string): string {
	if (t.length <= 4 || /\d/.test(t)) return t;
	if (t.endsWith("ies")) return `${t.slice(0, -3)}y`;
	if (t.endsWith("sses")) return t.slice(0, -2);
	if (t.endsWith("ing") && t.length > 6) return t.slice(0, -3).replace(/(.)\1$/, "$1");
	if (t.endsWith("ed") && t.length > 5) return t.slice(0, -2).replace(/(.)\1$/, "$1");
	if (t.endsWith("s") && !/(ss|us|is)$/.test(t)) return t.slice(0, -1);
	return t;
}

export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/\d{4}-\d{2}-\d{2} · /g, " ")
		.split(/[^\p{L}\p{N}_.+#-]+/u)
		.map((t) => t.replace(/^[.\-+#]+|[.\-+#]+$/g, ""))
		.filter((t) => t.length > 1 && !STOP.has(t))
		.map(stem);
}

function bm25Rank(chunks: Chunk[], query: string, k1 = 1.2, b = 0.75): Array<{ i: number; score: number }> {
	const q = [...new Set(tokenize(query))];
	if (!q.length || !chunks.length) return [];
	const docs = chunks.map((c) => tokenize(c.text));
	const avg = docs.reduce((a, d) => a + d.length, 0) / docs.length || 1;
	const df = new Map<string, number>();
	for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
	const N = docs.length;
	const scored: Array<{ i: number; score: number }> = [];
	docs.forEach((d, i) => {
		const tf = new Map<string, number>();
		for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
		let score = 0;
		for (const t of q) {
			const f = tf.get(t);
			if (!f) continue;
			const n = df.get(t) ?? 0;
			const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
			score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg)));
		}
		if (score > 0) scored.push({ i, score });
	});
	return scored.sort((a, b2) => b2.score - a.score);
}

// ── Embeddings ────────────────────────────────────────────────────────────

type VectorCache = { model: string; vectors: Record<string, number[]> };

function hash(text: string): string {
	return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

function normalizeVec(v: number[]): number[] {
	const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
	return v.map((x) => x / n);
}

function dot(a: number[], b: number[]): number {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i] * b[i];
	return s;
}

export class Embedder {
	cfg: EmbedConfig;
	/** Last failure, shown by /memory; cleared by the next success. */
	lastError = "";

	constructor(cfg: EmbedConfig) {
		this.cfg = cfg;
	}

	get enabled(): boolean {
		return !!this.cfg.url && !!this.cfg.model;
	}

	private prefixes() {
		const d = defaultPrefixes(this.cfg.model);
		return { query: this.cfg.queryPrefix ?? d.query, doc: this.cfg.docPrefix ?? d.doc };
	}

	/** `onBatch` sees each batch as it arrives, so an interrupted run keeps what it finished. */
	async embed(texts: string[], kind: "query" | "doc", signal?: AbortSignal, onBatch?: (start: number, vecs: number[][]) => void): Promise<number[][]> {
		const prefix = this.prefixes()[kind];
		const out: number[][] = [];
		for (let i = 0; i < texts.length; i += 16) {
			const batch = texts.slice(i, i + 16).map((t) => prefix + t);
			const ctrl = new AbortController();
			// A query waits at most 3 s — past that, keyword search answers instead of the user
			// waiting on a hung server. Documents (embedded once, then cached) get longer.
			const limit = kind === "query" ? Math.min(this.cfg.timeoutMs ?? 3_000, 3_000) : (this.cfg.timeoutMs ?? 30_000);
			const timer = setTimeout(() => ctrl.abort(), limit);
			const onAbort = () => ctrl.abort();
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				const res = await fetch(`${this.cfg.url.replace(/\/+$/, "")}/embeddings`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
					},
					body: JSON.stringify({ model: this.cfg.model, input: batch }),
					signal: ctrl.signal,
				});
				if (!res.ok) throw new Error(`embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
				const body = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> };
				const rows = [...body.data].sort((a, b) => a.index - b.index);
				if (rows.length !== batch.length) throw new Error(`embeddings returned ${rows.length}/${batch.length}`);
				const vecs = rows.map((r) => normalizeVec(r.embedding));
				onBatch?.(i, vecs);
				out.push(...vecs);
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		}
		this.lastError = "";
		return out;
	}
}

export class SearchIndex {
	private file: string;
	private cache: VectorCache | undefined;
	embedder: Embedder;

	constructor(root: string, embedder: Embedder) {
		this.file = path.join(root, ".index", "vectors.json");
		this.embedder = embedder;
	}

	private load(): VectorCache {
		if (this.cache?.model === this.embedder.cfg.model) return this.cache;
		try {
			const raw = JSON.parse(fs.readFileSync(this.file, "utf-8")) as VectorCache;
			this.cache = raw.model === this.embedder.cfg.model ? raw : { model: this.embedder.cfg.model, vectors: {} };
		} catch {
			this.cache = { model: this.embedder.cfg.model, vectors: {} };
		}
		return this.cache;
	}

	private save(live: Set<string>): void {
		const cache = this.load();
		// Drop vectors for chunks that no longer exist.
		for (const h of Object.keys(cache.vectors)) if (!live.has(h)) delete cache.vectors[h];
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		const tmp = `${this.file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(cache));
		fs.renameSync(tmp, this.file);
	}

	/** Embed every chunk not yet cached. Returns how many were embedded. */
	async refresh(chunks: Chunk[], signal?: AbortSignal): Promise<number> {
		if (!this.embedder.enabled) return 0;
		const cache = this.load();
		const hashes = chunks.map((c) => hash(c.text));
		const missing = chunks.filter((_, i) => !cache.vectors[hashes[i]]);
		let done = 0;
		try {
			if (missing.length) {
				await this.embedder.embed(
					missing.map((c) => c.text),
					"doc",
					signal,
					(start, vecs) => {
						vecs.forEach((v, j) => {
							cache.vectors[hash(missing[start + j].text)] = v;
						});
						done += vecs.length;
					},
				);
			}
		} finally {
			// Saved even when cut short, so the next search resumes instead of starting over.
			// Scoped searches see a subset of chunks, so nothing is pruned here — prune() does that.
			if (done) this.save(new Set(Object.keys(cache.vectors)));
		}
		return done;
	}

	/** Rewrite the cache keeping only these chunks' vectors (after a full-book refresh). */
	prune(chunks: Chunk[]): void {
		if (!this.embedder.enabled) return;
		this.save(new Set(chunks.map((c) => hash(c.text))));
	}

	/**
	 * For each text, the chunk with the highest cosine — texts embedded as
	 * documents, so a new note compares with stored ones like for like.
	 * undefined everywhere when embeddings are off.
	 */
	async nearest(chunks: Chunk[], texts: string[], signal?: AbortSignal): Promise<Array<{ chunk: Chunk; cos: number } | undefined>> {
		if (!this.embedder.enabled || !chunks.length || !texts.length) return texts.map(() => undefined);
		await this.refresh(chunks, signal);
		const cache = this.load();
		const vecs = await this.embedder.embed(texts, "doc", signal);
		return vecs.map((v) => {
			let best: { chunk: Chunk; cos: number } | undefined;
			for (const c of chunks) {
				const u = cache.vectors[hash(c.text)];
				if (!u) continue;
				const cos = dot(v, u);
				if (!best || cos > best.cos) best = { chunk: c, cos };
			}
			return best;
		});
	}

	/**
	 * Top `k` chunks for the query. `mode` is recorded on the result so callers
	 * can tell a degraded (keyword-only) search from a hybrid one.
	 */
	async search(
		chunks: Chunk[],
		query: string,
		k: number,
		signal?: AbortSignal,
	): Promise<{ hits: Hit[]; mode: "hybrid" | "keyword" | "vector"; error?: string }> {
		const lexical = bm25Rank(chunks, query);
		let vector: Array<{ i: number; score: number }> = [];
		let error: string | undefined;
		if (this.embedder.enabled && chunks.length) {
			const budget = AbortSignal.timeout(this.embedder.cfg.searchBudgetMs ?? 3_000);
			const deadline = signal ? AbortSignal.any([signal, budget]) : budget;
			try {
				await this.refresh(chunks, deadline);
				const cache = this.load();
				const [qv] = await this.embedder.embed([query], "query", deadline);
				vector = chunks
					.map((c, i) => ({ i, score: dot(qv, cache.vectors[hash(c.text)] ?? []) }))
					.filter((r) => Number.isFinite(r.score))
					.sort((a, b) => b.score - a.score);
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
				this.embedder.lastError = error;
			}
		}

		const fused = new Map<number, Hit>();
		const depth = Math.max(k * 4, 40);
		lexical.slice(0, depth).forEach((r, rank) => {
			const hit = fused.get(r.i) ?? { chunk: chunks[r.i], score: 0 };
			hit.score += 1 / (RRF_K + rank + 1);
			hit.bm25 = rank + 1;
			fused.set(r.i, hit);
		});
		vector.slice(0, depth).forEach((r, rank) => {
			const hit = fused.get(r.i) ?? { chunk: chunks[r.i], score: 0 };
			hit.score += 1 / (RRF_K + rank + 1);
			hit.vector = rank + 1;
			hit.cos = r.score;
			fused.set(r.i, hit);
		});
		const hits = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, k);
		const mode = vector.length && lexical.length ? "hybrid" : vector.length ? "vector" : "keyword";
		return { hits, mode, error };
	}
}
