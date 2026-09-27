/**
 * The archive tier: pi's own past session files, searched in place.
 *
 * Nothing is copied — pi already keeps every session under
 * ~/.pi/agent/sessions/<cwd>/*.jsonl. Sessions belong to a project when their
 * header's cwd resolves to the same project id (so every checkout of a repo
 * counts). Search is BM25 over windows of consecutive messages: user and
 * assistant text plus a short excerpt of each tool result. It is never
 * recalled automatically — the `memory` tool reaches it on demand, so it costs
 * no tokens until asked, and keeps the detail the notes deliberately drop.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { projectId } from "./book.ts";
import { tokenize } from "./search.ts";

export interface ArchiveHit {
	file: string;
	date: string;
	score: number;
	text: string;
}

const WINDOW_CHARS = 1600;
const TOOL_CHARS = 400;
const TEXT_CHARS = 1200;

type Part = { type?: string; text?: string; name?: string };
type Entry = { type?: string; cwd?: string; timestamp?: string; message?: { role?: string; content?: string | Part[]; toolName?: string } };

interface Window {
	date: string;
	text: string;
	tokens: string[];
}

function textOf(content: string | Part[] | undefined): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((p) => p?.type === "text" && p.text)
		.map((p) => p.text)
		.join("\n");
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} …` : s);

export class Archive {
	private root: string;
	/** cwd → project id (git lookups are not free). */
	private ids = new Map<string, string>();
	/** file → windows, rebuilt when the file's mtime changes. */
	private cache = new Map<string, { mtime: number; cwd: string; windows: Window[] }>();

	constructor(sessionsRoot: string) {
		this.root = sessionsRoot;
	}

	private idOf(cwd: string): string {
		let id = this.ids.get(cwd);
		if (id === undefined) {
			id = fs.existsSync(cwd) ? projectId(cwd) : "";
			this.ids.set(cwd, id);
		}
		return id;
	}

	private load(file: string): { cwd: string; windows: Window[] } | undefined {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(file);
		} catch {
			return undefined;
		}
		const hit = this.cache.get(file);
		if (hit && hit.mtime === stat.mtimeMs) return hit;
		let raw: string;
		try {
			raw = fs.readFileSync(file, "utf-8");
		} catch {
			return undefined;
		}
		let cwd = "";
		const windows: Window[] = [];
		let buf: string[] = [];
		let size = 0;
		let date = "";
		const flush = () => {
			if (!buf.length) return;
			const text = buf.join("\n");
			windows.push({ date, text, tokens: tokenize(text) });
			buf = [];
			size = 0;
		};
		for (const line of raw.split("\n")) {
			if (!line) continue;
			let e: Entry;
			try {
				e = JSON.parse(line);
			} catch {
				continue;
			}
			if (e.type === "session") {
				cwd = e.cwd ?? "";
				continue;
			}
			const m = e.message;
			if (!m) continue;
			let piece = "";
			if (m.role === "user") piece = `User: ${clip(textOf(m.content), TEXT_CHARS)}`;
			else if (m.role === "assistant") {
				const t = textOf(m.content).trim();
				const tools = Array.isArray(m.content) ? m.content.filter((p) => p?.type === "toolCall").map((p) => p.name) : [];
				piece = [t ? `Assistant: ${clip(t, TEXT_CHARS)}` : "", tools.length ? `[tools: ${tools.join(", ")}]` : ""].filter(Boolean).join("\n");
			} else if (m.role === "toolResult") {
				const t = textOf(m.content).trim();
				if (t) piece = `[${m.toolName ?? "tool"} → ${clip(t.replace(/\s+/g, " "), TOOL_CHARS)}]`;
			}
			if (!piece.trim()) continue;
			if (size + piece.length > WINDOW_CHARS) flush();
			if (!buf.length) date = (e.timestamp ?? "").slice(0, 10);
			buf.push(piece);
			size += piece.length + 1;
		}
		flush();
		const entry = { mtime: stat.mtimeMs, cwd, windows };
		this.cache.set(file, entry);
		return entry;
	}

	/** Session files whose cwd is this project, newest first. */
	files(project: string, exclude?: string): string[] {
		const out: Array<{ file: string; name: string }> = [];
		let dirs: string[] = [];
		try {
			dirs = fs.readdirSync(this.root);
		} catch {
			return [];
		}
		for (const d of dirs) {
			const dir = path.join(this.root, d);
			let names: string[] = [];
			try {
				names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
			} catch {
				continue;
			}
			if (!names.length) continue;
			// One header read decides the whole directory: pi keeps one directory per cwd.
			const first = this.load(path.join(dir, names[0]));
			if (!first || this.idOf(first.cwd) !== project) continue;
			for (const n of names) {
				const file = path.join(dir, n);
				if (file !== exclude) out.push({ file, name: n });
			}
		}
		return out.sort((a, b) => (a.name < b.name ? 1 : -1)).map((o) => o.file);
	}

	search(query: string, project: string, k: number, exclude?: string): ArchiveHit[] {
		const q = [...new Set(tokenize(query))];
		if (!q.length) return [];
		const all: Array<{ file: string; w: Window }> = [];
		for (const file of this.files(project, exclude)) {
			const s = this.load(file);
			if (s) for (const w of s.windows) all.push({ file, w });
		}
		if (!all.length) return [];
		const avg = all.reduce((a, x) => a + x.w.tokens.length, 0) / all.length || 1;
		const df = new Map<string, number>();
		for (const x of all) for (const t of new Set(x.w.tokens)) if (q.includes(t)) df.set(t, (df.get(t) ?? 0) + 1);
		const N = all.length;
		const scored: ArchiveHit[] = [];
		for (const x of all) {
			const tf = new Map<string, number>();
			for (const t of x.w.tokens) if (df.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
			let score = 0;
			for (const [t, f] of tf) {
				const n = df.get(t) ?? 0;
				const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
				score += idf * ((f * 2.2) / (f + 1.2 * (0.25 + (0.75 * x.w.tokens.length) / avg)));
			}
			if (score > 0) scored.push({ file: path.basename(x.file), date: x.w.date, score, text: x.w.text });
		}
		return scored.sort((a, b) => b.score - a.score).slice(0, k);
	}
}
