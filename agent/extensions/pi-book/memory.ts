/**
 * The memory's behaviour, shared by the pi extension and the CLI: config,
 * search, the recall block, and capture (turning a conversation into edits).
 *
 * Tiers, and what decides between them:
 *   short   the live session — pi's own context; nothing stored here
 *   medium  the journal: one digest per session (done / failed / open / next),
 *           rewritten by each capture, recalled for the next sessions, expired
 *           after journal.ttlDays — after a last chance to promote lasting facts
 *   long    the book's chapters: durable facts, kept until changed
 *   appendix long write-ups the agent saves through the tool (a debug session's
 *           cause, commands, key log lines): found by summary and text, recalled
 *           as one summary line, the body read only on demand
 *   archive pi's raw session files, searched on demand (archive.ts)
 * The capture model sorts each item into long (ops), medium (journal) or
 * nothing. Size then routes in code: a "fact" too long for a note goes to the
 * journal, and nothing longer than a digest bullet is stored at all — code,
 * logs and long explanations stay in the archive only.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Appendix, Book, cleanFact, JOURNAL, type JournalEntry, kebab, type Scope, today } from "./book.ts";
import { type Complete, type LlmConfig, makeLlm } from "./llm.ts";
import { resolveProvider, splitModelRef } from "./providers.ts";
import { bulletUnits, type Chunk, chunkSections, type EmbedConfig, Embedder, type Hit, SearchIndex, sectionLines, tokenize } from "./search.ts";

export interface MemoryConfig {
	dir: string;
	llm: LlmConfig;
	embed: EmbedConfig;
	/**
	 * budgetTokens: what the matching notes may spend (bullet-level, see read());
	 * maxChars caps the whole block; minCos: a recalled note must be at least this
	 * similar to the prompt (when vectors are up).
	 */
	recall: { enabled: boolean; budgetTokens: number; maxChars: number; minCos: number };
	/** "auto": extract after every agent run; "manual": only /remember and the tool. */
	capture: "auto" | "manual";
	/** Problems found in pi-book.json; each fell back to a default. Shown by /memory. */
	warnings?: string[];
	/** Medium tier. ttlDays 0 keeps digests forever; recall = digests shown at session start. */
	journal: { enabled: boolean; ttlDays: number; recall: number; maxBullets: number };
}

export const DEFAULTS: Omit<MemoryConfig, "dir"> = {
	llm: { mode: "pi" },
	embed: { url: "http://127.0.0.1:8090/v1", model: "embeddinggemma" },
	recall: { enabled: true, budgetTokens: 400, maxChars: 2800, minCos: 0.3 },
	capture: "auto",
	journal: { enabled: true, ttlDays: 30, recall: 2, maxBullets: 8 },
};

function expandHome(p: string): string {
	return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * agent/pi-book.json — pi-book's own config file (per machine, never synced):
 *
 *   {
 *     "model": "litellm/GLM-5.3-Flash",        capture + consolidation ("the judge")
 *     "mode": "microcall",                     or "normal": a direct call
 *     "embedding": "litellm/Qwen3-Embedding-8B"
 *   }
 *
 *   model      "provider/model". Unset: the microcall chain (model-state.json
 *              "micro", else the session's model).
 *   mode       "microcall" — a minimal pi session through microcall.ts; works
 *              with any provider pi can use, including ones that only accept
 *              pi's own traffic. "normal" (or "direct") — a plain
 *              OpenAI-compatible POST to the provider's endpoint: faster, no
 *              session; the provider needs an OpenAI-compatible API.
 *   embedding  "provider/model" for /embeddings; "" or false = keyword search.
 *
 * Providers resolve from pi's own models.json / auth.json (providers.ts): no
 * URL or key is repeated here. Any other key of the "memory" section (recall,
 * journal, capture, dir, or full llm / embed objects) may also go here.
 */
export interface BookFile extends Partial<Omit<MemoryConfig, "llm" | "embed" | "warnings">> {
	model?: string;
	mode?: "microcall" | "normal" | "direct";
	embedding?: string | false | Partial<EmbedConfig>;
	llm?: Partial<LlmConfig>;
	embed?: Partial<EmbedConfig>;
}

function readJson(file: string): Record<string, any> | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return undefined;
	}
}

/** pi-book.json's short keys → the "memory" section shape. Problems become warnings. */
function fromBookFile(book: BookFile, agentDir: string, warnings: string[]): Partial<MemoryConfig> {
	const { model, mode, embedding, ...rest } = book;
	const out = { ...rest } as Partial<MemoryConfig>;

	if (model !== undefined || mode !== undefined) {
		const direct = mode === "normal" || mode === "direct";
		if (mode !== undefined && !direct && mode !== "microcall")
			warnings.push(`pi-book.json: unknown mode "${mode}" — using microcall`);
		const ref = model ? splitModelRef(model) : undefined;
		if (model && !ref) warnings.push(`pi-book.json: "model" must be "provider/model", not "${model}"`);
		if (direct && ref) {
			const ep = resolveProvider(agentDir, ref[0]);
			if (!ep.baseUrl) {
				warnings.push(`pi-book.json: provider "${ref[0]}" has no baseUrl in models.json — using microcall`);
			} else if (ep.api && !ep.api.startsWith("openai")) {
				warnings.push(`pi-book.json: provider "${ref[0]}" speaks ${ep.api}, normal mode needs an OpenAI-compatible API — using microcall`);
			} else {
				out.llm = { ...book.llm, mode: "raw", baseUrl: ep.baseUrl, model: ref[1], ...(ep.apiKey ? { apiKey: ep.apiKey } : {}) } as LlmConfig;
			}
		} else if (direct) {
			warnings.push('pi-book.json: normal mode needs "model": "provider/model" — using microcall');
		}
		out.llm ??= { ...book.llm, mode: "pi", ...(ref ? { model } : {}) } as LlmConfig;
	}

	if (embedding === "" || embedding === false) {
		out.embed = { ...book.embed, url: "" } as EmbedConfig;
	} else if (typeof embedding === "string") {
		const ref = splitModelRef(embedding);
		const ep = ref ? resolveProvider(agentDir, ref[0]) : undefined;
		if (!ref) warnings.push(`pi-book.json: "embedding" must be "provider/model", not "${embedding}"`);
		else if (!ep?.baseUrl) warnings.push(`pi-book.json: provider "${ref[0]}" has no baseUrl in models.json — embeddings off`);
		out.embed = ref && ep?.baseUrl
			? ({ ...book.embed, url: ep.baseUrl, model: ref[1], ...(ep.apiKey ? { apiKey: ep.apiKey } : {}) } as EmbedConfig)
			: ({ ...book.embed, url: "" } as EmbedConfig);
	} else if (embedding && typeof embedding === "object") {
		out.embed = { ...book.embed, ...embedding } as EmbedConfig;
	}
	return out;
}

/**
 * An embed object's key without copying it: a literal `apiKey`, else the env
 * var `apiKeyEnv`, else the key pi keeps for provider `apiKeyFrom`.
 */
function resolveEmbedKey(embed: EmbedConfig, agentDir: string): string | undefined {
	if (embed.apiKey) return embed.apiKey;
	if (embed.apiKeyEnv && process.env[embed.apiKeyEnv]) return process.env[embed.apiKeyEnv];
	return embed.apiKeyFrom ? resolveProvider(agentDir, embed.apiKeyFrom).apiKey : undefined;
}

/**
 * Defaults, then model-state.json "memory" (older home of these settings,
 * still read), then agent/pi-book.json — later wins, key by key.
 * PI_MEMORY_CONFIG points at another JSON file with a "memory" section (and
 * then pi-book.json is not read), and PI_MEMORY_DIR moves the book — both for
 * tests and the benchmark.
 */
export function loadConfig(agentDir: string): MemoryConfig {
	const warnings: string[] = [];
	const isolated = !!process.env.PI_MEMORY_CONFIG;
	const legacy: Partial<MemoryConfig> =
		readJson(process.env.PI_MEMORY_CONFIG || path.join(agentDir, "model-state.json"))?.memory ?? {};
	const book = isolated ? undefined : readJson(path.join(agentDir, "pi-book.json"));
	const user: Partial<MemoryConfig> = { ...legacy, ...(book ? fromBookFile(book as BookFile, agentDir, warnings) : {}) };
	const dir = expandHome(process.env.PI_MEMORY_DIR || user.dir || path.join(agentDir, "book"));
	const embed = { ...DEFAULTS.embed, ...user.embed } as EmbedConfig;
	const apiKey = resolveEmbedKey(embed, agentDir);
	return {
		dir,
		llm: { ...DEFAULTS.llm, ...user.llm } as LlmConfig,
		embed: apiKey ? { ...embed, apiKey } : embed,
		recall: { ...DEFAULTS.recall, ...user.recall },
		capture: user.capture === "manual" ? "manual" : "auto",
		journal: { ...DEFAULTS.journal, ...user.journal },
		...(warnings.length ? { warnings } : {}),
	};
}

/** One edit proposed by capture or asked for through the tool. */
export type Op =
	| { op: "add"; scope: Scope; chapter: string; section: string; text: string; summary?: string; quote?: string }
	| { op: "update"; old: string; text: string }
	| { op: "delete"; old: string };

/** How a read spends its tokens. */
export interface ReadOptions {
	/** Rough token budget (chars / 4) for everything returned. */
	budgetTokens: number;
	/** "bullet": score facts one by one; "section": whole sections (the old way). */
	unit?: "bullet" | "section";
	/** Bullet reads: also include this many bullets on each side of a hit (context for raw turns). */
	neighbors?: number;
	/** Drop hits below this cosine when vectors are up (recall uses it; benchmarks do not). */
	minCos?: number;
	/** With minCos: keep keyword (BM25) matches even below it — for explicit searches of exact terms. */
	keepKeyword?: boolean;
	/** Section ids to leave out (e.g. digests the recall block already shows). */
	skip?: Set<string>;
	signal?: AbortSignal;
}

export interface ReadGroup {
	section: Chunk["section"];
	lines: string[];
}

export interface Applied {
	op: Op;
	ok: boolean;
	/** Where it landed, or why it was refused. */
	note: string;
}

const MAX_FACT = 300;
/** Recall shows at most this many lines of each recent digest. */
const DIGEST_LINES = 5;
/** Resume-first order for digest lines in recall. */
function digestRank(b: string): number {
	const k = /^(Open|Next|Decided|Failed|Tried|Done):/i.exec(b)?.[1]?.toLowerCase();
	return k ? ["open", "next", "decided", "failed", "tried", "done"].indexOf(k) : 6;
}
/** A digest bullet: longer is cut — the detail is still in the archive. */
const MAX_BULLET = 240;
const MAX_OPS = 8;
/**
 * A new note this similar (cosine) to a stored one goes to the dedupe judge.
 * From the book's own pairs: reworded duplicates scored 0.87–0.91, but so did
 * two different facts about one feature (0.90) — so similarity only nominates.
 */
const NEAR_DUP = 0.85;
/** Never store what looks like a credential, whatever the model says. */
const SECRET =
	/(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|\b[a-f0-9]{40,}\b|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S{8,})/i;

/**
 * Credentials inside an appendix body are blanked rather than refusing the
 * page: logs are long and one stray token should not lose the rest. Bare
 * 40-hex strings stay (in logs they are commit ids); a private key refuses it.
 */
const REDACT =
	/(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)?|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S{8,})/gi;
const MAX_APPENDIX = 6000;
const MAX_SUMMARY = 200;
/** Recall shows at most this many matching appendix summaries. */
const RECALL_APPENDICES = 2;

export function looksSecret(text: string): boolean {
	return SECRET.test(text);
}

/** Word overlap (Jaccard, stopwords dropped) — near 1 means the same note reworded. */
export function overlap(a: string, b: string): number {
	const x = new Set(tokenize(a));
	const y = new Set(tokenize(b));
	if (!x.size || !y.size) return 0;
	let both = 0;
	for (const t of x) if (y.has(t)) both++;
	return both / (x.size + y.size - both);
}

const THIS_PROJECT = /\b(?:this|the current) (?:repo|repository|project|codebase|workspace)\b/i;

/** A note that says what the user wants — it needs the user's own words behind it (see quoted()). */
const USER_CLAIM =
	/^(?:the )?user (?:wants|prefers|likes|dislikes|asks|asked|insists|expects|requires|chose|approved|rejects|rejected|does not want|doesn't want)\b|^(?:prefers|wants|likes|dislikes)\b/i;
const PREFERENCE_CHAPTER = /^(?:preferences|workflow|style|styling|rules)$/;

/**
 * True when the quote's words (stemmed, stopwords dropped) nearly all appear in
 * one user line of the transcript — so a preference was stated, not inferred
 * from what the assistant did.
 */
export function quoted(quote: string, transcript: string): boolean {
	const q = new Set(tokenize(quote));
	if (!q.size) return false;
	return transcript
		.split("\n")
		.filter((l) => l.startsWith("User: "))
		.some((l) => {
			const words = new Set(tokenize(l));
			let n = 0;
			for (const w of q) if (words.has(w)) n++;
			return n / q.size >= 0.8;
		});
}

/**
 * An update whose words (stemmed, stopwords dropped) are exactly the note's is
 * a pure rewording, and is refused. Anything less strict blocks real changes:
 * "the main branch is called master" → "… called main" shares 3 of 4 words.
 */
const REWORD = 1;

export class Memory {
	cfg: MemoryConfig;
	book: Book;
	index: SearchIndex;
	llm: Complete;

	constructor(cfg: MemoryConfig, opts: { inPi: boolean; agentDir: string }) {
		this.cfg = cfg;
		this.book = new Book(cfg.dir);
		this.index = new SearchIndex(cfg.dir, new Embedder(cfg.embed));
		this.llm = makeLlm(cfg.llm, opts);
	}

	chunks(project?: string): Chunk[] {
		return chunkSections(this.book.chapters(project === undefined ? undefined : [project]).flatMap((c) => c.sections));
	}

	/** Appendix bodies as search chunks, each headed by its summary (so a hit says what it is). */
	appendixChunks(project?: string): Chunk[] {
		return chunkSections(
			this.book.appendices(project === undefined ? undefined : [project]).map((a) => ({
				id: a.rel,
				rel: a.rel,
				chapter: "appendix",
				scope: a.scope,
				project: a.project,
				heading: a.summary,
				text: `## ${a.summary}\n${a.title}\n${a.body}`,
			})),
		);
	}

	/**
	 * Appendices matching a query, best first, one entry per appendix — their
	 * summaries only; the body is for `read`. Filtered like notes: below minCos
	 * out, unless keepKeyword and the words matched.
	 */
	async findAppendices(
		query: string,
		project: string,
		opts: { k: number; minCos?: number; keepKeyword?: boolean; signal?: AbortSignal },
	): Promise<Appendix[]> {
		const all = this.book.appendices([project]);
		if (!all.length) return [];
		const chunks = this.appendixChunks(project);
		const { hits, mode } = await this.index.search(chunks, query, chunks.length, opts.signal);
		const out: Appendix[] = [];
		for (const h of hits) {
			const ok = opts.minCos === undefined || mode === "keyword" || (h.cos ?? 0) >= opts.minCos || (!!opts.keepKeyword && h.bm25 !== undefined);
			const a = ok ? all.find((x) => x.rel === h.chunk.section.rel) : undefined;
			if (a && !out.includes(a)) out.push(a);
			if (out.length >= opts.k) break;
		}
		return out;
	}

	/** Save a long write-up under a one-line summary; every refusal is reported, nothing throws. */
	saveAppendix(input: { scope: Scope; title: string; summary: string; body: string }, project: string, opts: { session?: string } = {}): { ok: boolean; note: string } {
		const summary = cleanFact(input.summary);
		const title = (input.title || summary).replace(/[#\n]/g, " ").trim().slice(0, 80);
		const body = input.body.trim();
		if (input.scope === "project" && !project) return { ok: false, note: "refused: no project here (temp directory)" };
		if (!summary) return { ok: false, note: "refused: an appendix needs a one-line summary" };
		if (summary.length > MAX_SUMMARY) return { ok: false, note: `refused: summary over ${MAX_SUMMARY} chars` };
		if (!body) return { ok: false, note: "refused: empty body" };
		if (body.length > MAX_APPENDIX) return { ok: false, note: `refused: body over ${MAX_APPENDIX} chars — keep the lines that matter` };
		if (looksSecret(summary) || looksSecret(title) || /-----BEGIN [A-Z ]*PRIVATE KEY/.test(body)) return { ok: false, note: "refused: looks like a credential" };
		const { rel, replaced } = this.book.writeAppendix(input.scope, title, summary, body.replace(REDACT, "[redacted]"), {
			project: input.scope === "project" ? project : undefined,
			session: opts.session,
		});
		this.book.writeIndex();
		return { ok: true, note: `${replaced ? "replaced" : "saved"} ${rel}` };
	}

	async search(query: string, project: string | undefined, k: number, signal?: AbortSignal) {
		return this.index.search(this.chunks(project), query, k, signal);
	}

	/**
	 * A budgeted read: rank units (bullets or section chunks), then add the best
	 * ones — with their neighbours, for bullets — until the token budget is spent.
	 * Groups come back in rank order of their first hit, lines in book order, so
	 * each fact keeps its heading without paying for the rest of its section.
	 */
	async read(query: string, project: string | undefined, opts: ReadOptions): Promise<{ groups: ReadGroup[]; tokens: number; mode: string; error?: string }> {
		const sections = this.book.chapters(project === undefined ? undefined : [project]).flatMap((c) => c.sections);
		const bullet = (opts.unit ?? "bullet") === "bullet";
		const units = bullet ? bulletUnits(sections) : chunkSections(sections);
		const { hits, mode, error } = await this.index.search(units, query, Math.min(units.length, 400), opts.signal);
		const keep = hits.filter(
			(h) =>
				!opts.skip?.has(h.chunk.section.id) &&
				(opts.minCos === undefined || mode === "keyword" || (h.cos ?? 0) >= opts.minCos || (!!opts.keepKeyword && h.bm25 !== undefined)),
		);
		const budget = opts.budgetTokens * 4;
		const groups = new Map<string, { section: ReadGroup["section"]; picked: Set<number>; all: string[] }>();
		let used = 0;
		for (const h of keep) {
			const id = h.chunk.section.id;
			let g = groups.get(id);
			const all = g?.all ?? (bullet ? sectionLines(h.chunk.section) : []);
			let add: Array<{ i: number; text: string }>;
			if (bullet) {
				const n = opts.neighbors ?? 0;
				const i = h.chunk.line ?? 0;
				add = [];
				for (let j = Math.max(0, i - n); j <= Math.min(all.length - 1, i + n); j++) if (!g?.picked.has(j)) add.push({ i: j, text: all[j] });
			} else {
				add = [{ i: g ? g.picked.size : 0, text: h.chunk.text.split("\n").slice(1).join("\n") }];
			}
			if (!add.length) continue;
			const head = g ? 0 : h.chunk.section.rel.length + h.chunk.section.heading.length + 8;
			const cost = head + add.reduce((a, x) => a + x.text.length + 1, 0);
			if (used + cost > budget) continue; // a smaller hit further down may still fit
			if (!g) {
				g = { section: h.chunk.section, picked: new Set(), all };
				groups.set(id, g);
			}
			for (const x of add) {
				g.picked.add(x.i);
				if (!bullet) g.all[x.i] = x.text;
			}
			used += cost;
			if (budget - used < 40) break;
		}
		const out: ReadGroup[] = [...groups.values()].map((g) => ({
			section: g.section,
			lines: [...g.picked].sort((a, b) => a - b).map((i) => g.all[i]),
		}));
		return { groups: out, tokens: Math.round(used / 4), mode, error };
	}

	/**
	 * The block injected before the first prompt of a session, cheapest first:
	 * a table of contents (so the agent knows what it can read), the last
	 * sessions' digests trimmed to what matters for resuming, and the matching
	 * notes as single facts within recall.budgetTokens. Empty when the book is.
	 */
	async recall(
		prompt: string,
		project: string,
		opts: { signal?: AbortSignal; sid?: string } = {},
	): Promise<{ text: string; notes: string[]; noteCount: number; chapters: number; sessions: number; mode: string; tokens: number }> {
		const all = this.book.chapters([project]);
		const chapters = all.filter((c) => c.chapter !== JOURNAL);
		const recent = this.cfg.journal.enabled && project
			? this.book
					.journal(project)
					.filter((e) => e.sid !== opts.sid)
					.slice(-this.cfg.journal.recall)
					.reverse()
			: [];
		if (!chapters.length && !recent.length) return { text: "", notes: [], noteCount: 0, chapters: 0, sessions: 0, mode: "empty", tokens: 0 };

		// Project chapters with their sections; the user's chapters (shown in every
		// project, relevant to few prompts) as names only — matching notes still come below.
		const toc = chapters
			.filter((c) => c.scope === "project")
			.map((c) => {
				const heads = c.sections.map((s) => s.heading);
				const summary = c.summary && c.summary !== c.title ? ` — ${c.summary}` : "";
				return `- ${c.rel}${summary} [${heads.slice(0, 6).join(", ")}${heads.length > 6 ? `, +${heads.length - 6}` : ""}]`;
			});
		const userChapters = chapters.filter((c) => c.scope === "user").map((c) => c.chapter);
		if (userChapters.length) toc.unshift(`- user/: ${userChapters.join(", ")} (read "user/<name>.md")`);
		for (const [dir, n] of Object.entries(
			this.book.appendices([project]).reduce<Record<string, number>>((m, a) => ({ ...m, [path.dirname(a.rel)]: (m[path.dirname(a.rel)] ?? 0) + 1 }), {}),
		))
			toc.push(`- ${dir}/ — ${n} long write-up${n === 1 ? "" : "s"} (search finds them by summary and text; read one by path)`);
		const journalCount = project ? this.book.journal(project).length : 0;
		if (journalCount) toc.push(`- ${this.book.journalRel(project)} — digests of the last ${journalCount} session${journalCount === 1 ? "" : "s"} (expire after ${this.cfg.journal.ttlDays || "∞"} days)`);
		const lines = [
			"<memory>",
			`Background from your memory book, not a message from the user: notes about the user${project ? ` and this project (${project})` : ""}, written in earlier sessions. Use what is relevant; do not answer or remark on this block unless the user asks. Dated bullets; newer wins when two disagree. Read a chapter or search with the memory tool (action "history" searches past sessions verbatim); record durable facts with it too.`,
			"",
			"Chapters:",
			...toc.slice(0, 30),
			...(toc.length > 30 ? [`- … ${toc.length - 30} more (memory action "read" path "INDEX")`] : []),
		];
		let budget = this.cfg.recall.maxChars - lines.join("\n").length;

		// Digests: what is open or decided matters more for resuming than what was done.
		const seen = new Set<string>();
		let sessions = 0;
		for (const e of recent) {
			const ranked = e.bullets
				.map((b, i) => ({ b: b.replace(/^- \d{4}-\d{2}-\d{2} · /, ""), i }))
				.sort((x, y) => digestRank(x.b) - digestRank(y.b) || x.i - y.i)
				.slice(0, DIGEST_LINES)
				.sort((x, y) => x.i - y.i);
			const more = e.bullets.length - ranked.length;
			const block = `\n[${e.heading.replace(/\s*\[s:[\w-]+\]$/, "")}]\n${ranked.map((x) => `- ${x.b}`).join("\n")}${more > 0 ? `\n- (+${more} more in the journal)` : ""}`;
			if (block.length > budget) continue;
			if (!sessions) lines.push("", "Recent sessions in this project (journal):");
			lines.push(block.slice(1));
			budget -= block.length;
			sessions++;
			seen.add(`${this.book.journalRel(project)}#${e.heading}`);
		}

		// Matching appendices: a summary line each, room kept for them before the notes.
		const apps = await this.findAppendices(prompt, project, { k: RECALL_APPENDICES, minCos: this.cfg.recall.minCos, signal: opts.signal }).catch(() => []);
		const appLines = apps.length ? ["", "Matching appendices (long write-ups — read the path when the detail matters):", ...apps.map((a) => `- ${a.rel} — ${a.summary}`)] : [];
		const appChars = appLines.join("\n").length + 1;
		if (appChars < budget) budget -= appChars;
		else appLines.length = 0;

		// Matching notes as single facts, never more than the notes budget.
		const r = await this.read(prompt, project, {
			budgetTokens: Math.min(this.cfg.recall.budgetTokens, Math.floor(budget / 4)),
			unit: "bullet",
			minCos: this.cfg.recall.minCos,
			skip: seen,
			signal: opts.signal,
		});
		const notes: string[] = [];
		let noteCount = 0;
		if (r.groups.length) lines.push("", "Relevant notes:");
		for (const g of r.groups) {
			lines.push(`[${g.section.rel} › ${g.section.heading}]`, ...g.lines);
			notes.push(`${g.section.rel} › ${g.section.heading}`);
			noteCount += g.lines.length;
		}
		lines.push(...appLines);
		notes.push(...apps.slice(0, appLines.length ? apps.length : 0).map((a) => a.rel));
		lines.push("</memory>");
		const text = lines.join("\n");
		return { text, notes, noteCount, chapters: chapters.length, sessions, mode: r.mode, tokens: Math.round(text.length / 4) };
	}

	/** Validate and apply edits; every refusal is reported, nothing throws. */
	apply(ops: Op[], project: string, opts: { date?: string; maxOps?: number } = {}): Applied[] {
		return this.book.batch(() => this.applyAll(ops, project, opts));
	}

	private applyAll(ops: Op[], project: string, opts: { date?: string; maxOps?: number }): Applied[] {
		const out: Applied[] = [];
		const date = opts.date;
		for (const op of ops.slice(0, opts.maxOps ?? MAX_OPS)) {
			const text = "text" in op ? cleanFact(String(op.text ?? "")) : "";
			if (text && looksSecret(text)) {
				out.push({ op, ok: false, note: "refused: looks like a credential" });
				continue;
			}
			if (text.length > MAX_FACT) {
				out.push({ op, ok: false, note: `refused: over ${MAX_FACT} chars` });
				continue;
			}
			if (op.op === "add") {
				if (!text) {
					out.push({ op, ok: false, note: "refused: empty" });
					continue;
				}
				// "this repo" is never a fact about the user, whatever scope the model picked.
				const scope: Scope = op.scope === "user" && !THIS_PROJECT.test(text) ? "user" : "project";
				if (scope === "project" && !project) {
					out.push({ op, ok: false, note: "refused: no project here (temp directory)" });
					continue;
				}
				const chapter = kebab(op.chapter || "notes");
				const section = String(op.section || "Notes").replace(/[#\n]/g, " ").trim().slice(0, 60) || "Notes";
				const rel = this.book.rel(scope, chapter, project);
				const added = this.book.add(scope, chapter, section, text, { project: scope === "project" ? project : undefined, summary: op.summary, date });
				out.push({ op, ok: added, note: added ? `${rel} › ${section}` : "already recorded" });
			} else if (op.op === "update" && !text) {
				out.push({ op, ok: false, note: "refused: empty update" });
			} else if (op.op === "update" || op.op === "delete") {
				const hits = this.book.resolve(String(op.old ?? ""), [project]);
				if (!hits.length) out.push({ op, ok: false, note: "no matching note" });
				else if (hits.length > 1)
					out.push({
						op,
						ok: false,
						note: `refused: ${hits.length} notes contain that — quote one in full:\n${hits.map((h) => `  ${h.rel} › ${cleanFact(h.line).slice(0, 120)}`).join("\n")}`,
					});
				else if (op.op === "update" && overlap(hits[0].norm, text) >= REWORD) out.push({ op, ok: false, note: "refused: only rewords the note" });
				else {
					const rel = this.book.change(hits[0], op.op === "update" ? text : undefined);
					out.push({ op, ok: !!rel, note: rel ?? "no matching note" });
				}
			}
		}
		if (out.some((a) => a.ok)) this.book.writeIndex();
		return out;
	}

	/**
	 * Turn a conversation excerpt into edits. The model sees what the book
	 * already says on the subject so it can update instead of duplicating, and
	 * is told that "nothing" is the usual answer.
	 */
	async capture(
		transcript: string,
		project: string,
		opts: {
			signal?: AbortSignal;
			profile?: "coding" | "conversation";
			forceScope?: Scope;
			date?: string;
			/** The session this transcript belongs to; without one there is no journal digest. */
			session?: { id: string; title: string };
		} = {},
	): Promise<{ applied: Applied[]; journal?: string[]; model: string; raw: string }> {
		const chapters = this.book.chapters([project]).filter((c) => c.chapter !== JOURNAL);
		const toc = chapters.map((c) => `${c.scope === "user" ? "user" : "project"}:${c.chapter} — ${c.sections.map((s) => s.heading).join(" | ")}`);
		const { hits } = await this.search(transcript.slice(-4000), project, 6, opts.signal).catch(() => ({ hits: [] as Hit[] }));
		const related = [
			...new Set(
				hits.flatMap((h) =>
					h.chunk.text
						.split("\n")
						.slice(1)
						.map((l) => (h.chunk.section.chapter === JOURNAL ? `(journal) ${l}` : l)),
				),
			),
		].slice(0, 30);
		const journalOn = this.cfg.journal.enabled && !!opts.session && !!project;
		const digest = journalOn ? (this.book.journal(project).find((e) => e.sid === opts.session?.id)?.bullets ?? []) : [];

		const base = opts.profile === "conversation" ? CONVERSATION_SYSTEM : CODING_SYSTEM;
		const rules = opts.profile === "conversation" ? CONVERSATION_JOURNAL_RULES : JOURNAL_RULES;
		const system = journalOn ? `${base}\n\n${rules.replace("{max}", String(this.cfg.journal.maxBullets))}` : base;
		const prompt = [
			`Today: ${opts.date ?? today()}`,
			`Project id: ${project}`,
			"",
			"Existing chapters (scope:chapter — sections):",
			toc.length ? toc.join("\n") : "(none yet)",
			"",
			"Existing notes that may overlap:",
			related.length ? related.join("\n") : "(none)",
			...(journalOn
				? ["", "This session's journal digest so far:", digest.length ? digest.map((b) => b.replace(/^- \d{4}-\d{2}-\d{2} · /, "- ")).join("\n") : "(empty)"]
				: []),
			"",
			"<conversation>",
			transcript,
			"</conversation>",
			"",
			journalOn ? 'Reply with JSON only: {"ops": [...], "journal": [...] or null}' : 'Reply with JSON only: {"ops": [...]}',
		].join("\n");

		const { text, model } = await this.llm(system, prompt, { label: "memory capture", signal: opts.signal });
		let ops = parseOps(text);
		if (opts.forceScope) ops = ops.map((o) => (o.op === "add" ? { ...o, scope: opts.forceScope as Scope } : o));
		// Facts the session found may be kept, but "the user wants …" only on the user's words.
		const refused: Applied[] = [];
		if (opts.profile !== "conversation") {
			ops = ops.filter((o) => {
				if (o.op !== "add") return true;
				const claim = USER_CLAIM.test(cleanFact(String(o.text ?? ""))) || PREFERENCE_CHAPTER.test(kebab(o.chapter || ""));
				if (!claim || quoted(String(o.quote ?? ""), transcript)) return true;
				refused.push({ op: o, ok: false, note: "refused: no user words state this preference" });
				return false;
			});
		}
		// An empty list never wipes a digest: models send [] for "nothing new" as often as null.
		let journal = journalOn ? parseJournal(text) : undefined;
		if (journal && !journal.length) journal = undefined;

		// Size routing: a "fact" too long to be a note is session detail — it goes
		// to the digest (when there is one) instead of being lost.
		const long = ops.filter((o): o is Extract<Op, { op: "add" }> => o.op === "add" && cleanFact(String(o.text ?? "")).length > MAX_FACT);
		if (long.length && journalOn) {
			ops = ops.filter((o) => !long.includes(o as Extract<Op, { op: "add" }>));
			journal = [...(journal ?? digest.map((b) => b.replace(/^- \d{4}-\d{2}-\d{2} · /, ""))), ...long.map((o) => String(o.text))];
		}

		const maxOps = opts.profile === "conversation" ? 40 : MAX_OPS;
		const deduped = await this.dedupe(ops, project, opts.signal);
		const applied = [...refused, ...deduped.skipped, ...this.apply(deduped.ops, project, { date: opts.date, maxOps })];
		if (journal && opts.session) {
			const bullets = journal
				.map((b) => cleanFact(String(b)))
				.filter((b) => b && !looksSecret(b))
				.map((b) => (b.length > MAX_BULLET ? `${b.slice(0, MAX_BULLET - 1)}…` : b))
				.slice(0, this.cfg.journal.maxBullets);
			this.book.setJournal(project, opts.session.id, opts.date ?? today(), opts.session.title, bullets);
			this.book.writeIndex();
			journal = bullets;
		}
		return { applied, journal, model, raw: text };
	}

	/**
	 * Expire old digests, first giving the model one look at them for lasting
	 * facts worth promoting into the book. Returns what happened, for /memory.
	 */
	async expire(project: string, signal?: AbortSignal): Promise<{ expired: number; promoted: Applied[] }> {
		const ttl = this.cfg.journal.ttlDays;
		if (!this.cfg.journal.enabled || !ttl || !project) return { expired: 0, promoted: [] };
		const cutoff = new Date(Date.now() - ttl * 86_400_000).toISOString().slice(0, 10);
		const due = this.book.journal(project).filter((e) => e.date < cutoff);
		if (!due.length) return { expired: 0, promoted: [] };
		let promoted: Applied[] = [];
		try {
			const r = await this.promote(due, project, signal);
			promoted = r;
		} catch {
			// The model is unavailable: expire anyway — .history/ and the archive still hold it.
		}
		const expired = this.book.expireJournal(project, ttl).length;
		this.book.writeIndex();
		return { expired, promoted };
	}

	/**
	 * New notes that nearly match a stored one get a second look: the model
	 * says whether each is the same fact (dropped), a newer version (it updates
	 * the stored note) or a different fact (added). Without embeddings, or when
	 * the judge fails, the adds go through as before.
	 */
	private async dedupe(ops: Op[], project: string, signal?: AbortSignal): Promise<{ ops: Op[]; skipped: Applied[] }> {
		const adds = ops.filter((o): o is Extract<Op, { op: "add" }> => o.op === "add");
		if (!adds.length) return { ops, skipped: [] };
		const units = bulletUnits(
			this.book
				.chapters([project])
				.filter((c) => c.chapter !== JOURNAL)
				.flatMap((c) => c.sections),
		);
		const texts = adds.map((a) => `## ${String(a.section || "Notes").trim()}\n- ${today()} · ${cleanFact(String(a.text ?? ""))}`);
		const near = await this.index.nearest(units, texts, signal).catch(() => adds.map(() => undefined));
		const pairs = adds
			.map((add, i) => ({ add, old: near[i] && near[i].cos >= NEAR_DUP ? near[i].chunk.text.split("\n")[1].replace(/^- \d{4}-\d{2}-\d{2} · /, "") : "" }))
			.filter((p) => p.old);
		if (!pairs.length) return { ops, skipped: [] };
		let verdicts: unknown[] = [];
		try {
			const body = pairs.map((p, i) => `${i + 1}. new: ${cleanFact(String(p.add.text))}\n   stored: ${p.old}`).join("\n");
			const { text } = await this.llm(DEDUPE_SYSTEM, `${body}\n\nReply with JSON only.`, { label: "memory dedupe", signal });
			const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { verdicts?: unknown };
			if (Array.isArray(j.verdicts)) verdicts = j.verdicts;
		} catch {
			return { ops, skipped: [] };
		}
		const skipped: Applied[] = [];
		const replace = new Map<Op, Op | undefined>();
		pairs.forEach((p, i) => {
			const v = String(verdicts[i] ?? "different").toLowerCase();
			if (v === "same") {
				replace.set(p.add, undefined);
				skipped.push({ op: p.add, ok: false, note: `same as a stored note: ${p.old.slice(0, 80)}` });
			} else if (v === "newer") {
				replace.set(p.add, { op: "update", old: p.old, text: String(p.add.text) });
			}
		});
		const out = ops.flatMap((o) => (replace.has(o) ? (replace.get(o) ? [replace.get(o) as Op] : []) : [o]));
		return { ops: out, skipped };
	}

	private async promote(entries: JournalEntry[], project: string, signal?: AbortSignal): Promise<Applied[]> {
		const toc = this.book
			.chapters([project])
			.filter((c) => c.chapter !== JOURNAL)
			.map((c) => `${c.scope === "user" ? "user" : "project"}:${c.chapter} — ${c.sections.map((s) => s.heading).join(" | ")}`);
		const body = entries.map((e) => `[${e.heading}]\n${e.bullets.join("\n")}`).join("\n\n");
		const prompt = [
			"Existing chapters (scope:chapter — sections):",
			toc.length ? toc.join("\n") : "(none yet)",
			"",
			"Journal entries about to expire:",
			body,
			"",
			'Reply with JSON only: {"ops": [...]}',
		].join("\n");
		const { text } = await this.llm(PROMOTE_SYSTEM, prompt, { label: "memory promote", signal });
		const ops = parseOps(text).filter((o) => o.op === "add");
		return this.apply(ops, project);
	}
}

/** The "journal" array of a capture reply; undefined when absent or null (no change). */
export function parseJournal(text: string): string[] | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		const j = (JSON.parse(text.slice(start, end + 1)) as { journal?: unknown }).journal;
		return Array.isArray(j) ? j.filter((b): b is string => typeof b === "string" && !!b.trim()) : undefined;
	} catch {
		return undefined;
	}
}

export function parseOps(text: string): Op[] {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return [];
	try {
		const parsed = JSON.parse(text.slice(start, end + 1)) as { ops?: unknown };
		if (!Array.isArray(parsed.ops)) return [];
		return parsed.ops.filter(
			(o): o is Op =>
				!!o &&
				typeof o === "object" &&
				((o as Op).op === "add" || (o as Op).op === "update" || (o as Op).op === "delete"),
		);
	} catch {
		return [];
	}
}

const OPS_FORMAT = `Output format — JSON only, no prose:
{"ops": [
  {"op": "add", "scope": "user" | "project", "chapter": "kebab-case-name", "section": "Short Heading", "text": "one self-contained fact", "quote": "the user's words, for a preference"},
  {"op": "update", "old": "<existing note text, copied>", "text": "the corrected fact"},
  {"op": "delete", "old": "<existing note text, copied>"}
]}
Put a fact in an existing chapter and section when one fits; invent a new one only when none does. Chapter names are broad topics (preferences, environment, workflow, architecture, conventions, decisions, gotchas, commands), not one per fact.
When a new fact changes or contradicts an existing note, "update" that note instead of adding. "delete" only when the conversation says a note is no longer true.
If an existing note already says it, do nothing — do not reword notes that are still correct.
Most conversations contain nothing worth keeping: then reply {"ops": []}.`;

const CODING_SYSTEM = `You maintain a coding agent's long-term memory: a small book of notes it reads at the start of future sessions. From the conversation, record only facts that will still be true and useful weeks from now.

Keep:
- the user's stated preferences, corrections of the agent, and how they like to work (scope "user" only when it holds in every project; a preference about this project's own code, UI, output or files is scope "project")
- the user's machine, tools and environment when it matters for future work (scope "user")
- project decisions and why, conventions, architecture, non-obvious gotchas, commands that work, constraints (scope "project")
- what the session established, even when the assistant found it: a confirmed root cause, a gotcha, an environment detail, a command that works — once verified, never while it is a guess. Such a finding may also update a note it proves wrong.

Never record:
- what was done in this session, task progress, or plans ("we fixed X", "next we will…") — that is journal material when there is a journal, never a note
- a preference, rule or correction the user did not state: never turn what the assistant did or suggested into "the user wants …"
- anything readable from the code, git history or docs
- guesses, unconfirmed hypotheses, one-off errors, file contents, long lists, measurements that only describe one debugging session
- secrets: keys, tokens, passwords, private URLs with credentials

A preference, rule or correction of the user's needs "quote": the user's own words from the conversation that state it, copied exactly (a short phrase is enough). Without one it is not recorded.

Each fact: one sentence under 200 characters, specific (names, paths, versions), understandable without the conversation. No relative time ("last month", "yesterday"): give the date or leave it out.

${OPS_FORMAT}`;

const JOURNAL_RULES = `Second tier — the session journal: a short digest of THIS session that the next sessions read to pick up where it stopped. It expires after a few weeks.
- Up to {max} bullets, each starting with Done:, Tried:, Failed:, Decided:, Open: or Next: — name files, commands, errors and reasons.
- It REPLACES the digest so far: keep what still matters from it and fold in what the new turns changed.
- No code, logs or long explanations — the raw session stays searchable.
- Give "journal": null when the new turns change nothing worth resuming from (small talk, a plain question answered).
Notes marked (journal) come from earlier sessions. When one has proven to be a lasting fact — it came up again, or the user confirmed it — also record it as a long-term add.`;

/** The benchmark's personal conversations: a session digest is what happened in it, dated. */
const CONVERSATION_JOURNAL_RULES = `Second tier — the session journal: a digest of THIS session, read later alongside the notes.
- Up to {max} bullets: the events, plans, feelings and details discussed, each naming the person and giving absolute dates.
- Include specifics the notes left out (names, places, objects, reasons) — the digest is where detail survives.
- It REPLACES the digest so far; reply "journal": null only for pure small talk.`;

const DEDUPE_SYSTEM = `Each item pairs a new memory note with the stored note most similar to it. For each, decide:
- "same": every specific in the new note (names, numbers, paths, commands, items) is already in the stored note — it adds nothing
- "newer": both describe the same thing, and the new note keeps everything the stored one says while changing or adding to it, so it can replace it
- "different": anything else — another fact on the same topic, or a note with a specific the stored one lacks that cannot replace it. Both are kept.
When unsure, answer "different": a duplicate costs a line, a wrong "same" loses a fact.
Reply with JSON only, one verdict per item in order: {"verdicts": ["same", "newer", "different", …]}`;

const PROMOTE_SYSTEM = `Journal entries from a coding agent's past sessions are about to expire. Record as long-term notes only what is still a lasting fact: user preferences, project decisions and why, conventions, gotchas, commands that work. Skip progress, finished tasks and anything the notes already cover. Never turn a Done: or Tried: bullet into a preference of the user. Usually there is nothing.

${OPS_FORMAT}`;

/** For the benchmark's personal conversations, where dated events are the facts asked about. */
const CONVERSATION_SYSTEM = `You maintain long-term memory about the people in a conversation: a small book of notes read later to answer questions about them. Record facts about each speaker: identity, relationships, preferences, plans, and events with their dates (resolve "yesterday", "last week" against the session date given as Today and write the absolute date).

Each fact: one sentence under 200 characters, name the person, understandable without the conversation. Use scope "project". Chapters per person (e.g. "caroline"), sections by topic (Events, Family, Work, Hobbies, Preferences, Plans).

${OPS_FORMAT.replace("Most conversations contain nothing worth keeping: then reply {\"ops\": []}.", "Skip small talk; there is usually something worth keeping.")}`;

