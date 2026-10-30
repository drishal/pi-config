/**
 * pi-book — long-term memory for pi as a book of Markdown notes.
 *
 * Replaces mem0's opaque vector store with files you can read and fix by hand
 * (see book.ts for the layout, ~/.pi/agent/book by default). Notes are scoped:
 * user chapters apply everywhere, project chapters only in the repo they were
 * written in (matched by git remote, so any checkout of it).
 *
 *   tiers    long-term notes (the chapters), a medium-term journal of recent
 *            session digests that expires, and the archive of raw past
 *            sessions (searched on demand). See memory.ts for how items are
 *            sorted between them.
 *   recall   Before the first prompt of a session (and again after a
 *            compaction), one message: the chapters in scope, the last
 *            sessions' digests, and the sections that best match the prompt,
 *            by BM25 + embeddings (RRF). One line in the transcript; ctrl+o
 *            shows it.
 *   capture  After each agent run, one small model call reads the new turns
 *            against what the book already says: long-term add / update /
 *            delete edits (usually none) and this session's rewritten digest.
 *            Credentials are refused outright.
 *   expiry   At session start, digests past journal.ttlDays get one promotion
 *            pass (lasting facts move into the chapters), then are removed.
 *   tool     `memory`: search, read a chapter, write/update/delete a note,
 *            appendix (save a long write-up under a one-line summary),
 *            history (search past sessions verbatim).
 *
 * /remember <fact>        file a fact (the model picks chapter and section)
 * /memory                 status: book, models, last captures
 * /memory search <query>  ranked hits with their BM25 / vector ranks
 * /memory reindex         re-embed everything (notes and appendices), rewrite INDEX.md
 * /memory tidy            propose merges of duplicate or stale notes in scope
 *
 * Models and paths live in agent/pi-book.json (per machine, never synced):
 *   { "model": "provider/model", "mode": "microcall" | "normal",
 *     "embedding": "provider/model" }
 * — providers resolve from pi's models.json / auth.json (see memory.ts). The
 * long form, also accepted there and in model-state.json "memory":
 *   "memory": {
 *     "llm":   { "mode": "pi" } | { "mode": "raw", "baseUrl": "…/v1", "model": "…" },
 *     "embed": { "url": "http://127.0.0.1:8090/v1", "model": "embeddinggemma" },
 *     "recall": { "enabled": true, "budgetTokens": 400, "maxChars": 2800, "minCos": 0.3 },
 *     "capture": "auto" | "manual",
 *     "journal": { "enabled": true, "ttlDays": 30, "recall": 2, "maxBullets": 8 }
 *   }
 * See llm.ts for the two model modes.
 *
 * PI_BOOK=off (or 0 / false / no) turns the whole extension off for that pi:
 * no recall, no capture, no expiry pass, no tool or commands. Meant for
 * benchmark and scripted `pi -p` runs, whose prompts memory would contaminate
 * and whose transcripts do not belong in the book.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as path from "node:path";
import { Archive } from "./archive.ts";
import { projectId } from "./book.ts";
import { describe as describeLlm } from "./llm.ts";
import { type Applied, loadConfig, Memory, type Op, parseOps } from "./memory.ts";

const RECALL_TYPE = "book-recall";
const TRANSCRIPT_CHARS = 12_000;
const MESSAGE_CHARS = 2_000;
/** Replies with nothing to remember — skipped without a model call. */
const ACK = /^(?:(?:ok(?:ay)?|k|yes|yep|yeah|sure|no|nope|thanks?|thank you|thx|go ahead|go on|continue|proceed|do it|sounds good|great|nice|cool|perfect|lgtm|done|next)[\s,.!]*)+$/i;

type Theme = { fg(color: string, text: string): string };
type Part = { type?: string; text?: string; name?: string };
type Msg = { role?: string; content?: string | Part[] };

function textOf(content: Msg["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((p) => p?.type === "text" && p.text)
		.map((p) => p.text)
		.join("\n");
}

/** User and assistant text of an agent run, tool calls as names only. */
function transcriptOf(messages: unknown[]): { text: string; userChars: number; toolCalls: number } {
	const lines: string[] = [];
	let userChars = 0; // excluding acknowledgements
	let toolCalls = 0;
	for (const m of messages as Msg[]) {
		const clip = (s: string) => (s.length > MESSAGE_CHARS ? `${s.slice(0, MESSAGE_CHARS)} …` : s);
		if (m.role === "user") {
			const t = textOf(m.content).trim();
			if (!t) continue;
			if (!ACK.test(t)) userChars += t.length;
			lines.push(`User: ${clip(t)}`);
		} else if (m.role === "assistant") {
			const t = textOf(m.content).trim();
			const tools = Array.isArray(m.content) ? m.content.filter((p) => p?.type === "toolCall").map((p) => p.name) : [];
			if (t) lines.push(`Assistant: ${clip(t)}`);
			if (tools.length) {
				toolCalls += tools.length;
				lines.push(`[used tools: ${[...new Set(tools)].join(", ")}]`);
			}
		}
	}
	const text = lines.join("\n");
	if (text.length <= TRANSCRIPT_CHARS) return { text, userChars, toolCalls };
	// Too long: keep every user line — the request, corrections and preferences
	// come first in a run and would be the first cut — then the newest of the rest.
	const isUser = (l: string) => l.startsWith("User: ");
	let room = TRANSCRIPT_CHARS - lines.filter(isUser).reduce((n, l) => n + l.length + 1, 0);
	const keep = new Set<number>();
	for (let i = lines.length - 1; i >= 0; i--) {
		if (isUser(lines[i])) keep.add(i);
		else if (room >= lines[i].length + 1) {
			keep.add(i);
			room -= lines[i].length + 1;
		} else room = -1; // the rest stays a contiguous tail
	}
	const out: string[] = [];
	lines.forEach((l, i) => {
		if (keep.has(i)) out.push(l);
		else if (out.at(-1) !== "…") out.push("…");
	});
	const kept = out.join("\n");
	return { text: kept.length > TRANSCRIPT_CHARS ? `…${kept.slice(-TRANSCRIPT_CHARS)}` : kept, userChars, toolCalls };
}

function summarize(applied: Applied[]): string {
	return applied
		.map((a) => {
			const what = a.op.op === "add" ? a.op.text : a.op.op === "update" ? `${a.op.old} → ${a.op.text}` : a.op.old;
			return `${a.ok ? "✓" : "·"} ${a.op.op} ${what.slice(0, 90)}${what.length > 90 ? "…" : ""} (${a.note})`;
		})
		.join("\n");
}

class RecallView {
	constructor(
		private readonly title: string,
		private readonly body: string[],
		private readonly expanded: boolean,
		private readonly pad: number,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		const { theme } = this;
		const pad = " ".repeat(this.pad);
		const fit = (s: string) => (visibleWidth(s) > width ? truncateToWidth(s, width) : s);
		const w = width - this.pad;
		if (!this.expanded || w < 16) return [fit(`${pad}${theme.fg("dim", "●")} ${theme.fg("muted", this.title)}`)];
		const g = (s: string) => theme.fg("dim", s);
		const inner = w - 4;
		const label = ` ${this.title} `;
		const out = [pad + g("╭───") + theme.fg("muted", label) + g("─".repeat(Math.max(0, w - 5 - visibleWidth(label)))) + g("╮")];
		for (const line of this.body) {
			for (const piece of line ? wrapTextWithAnsi(line, inner) : [""]) {
				const t = visibleWidth(piece) > inner ? truncateToWidth(piece, inner) : piece;
				out.push(`${pad}${g("│")} ${theme.fg("muted", t)}${" ".repeat(Math.max(0, inner - visibleWidth(t)))} ${g("│")}`);
			}
		}
		out.push(pad + g(`╰${"─".repeat(Math.max(0, w - 2))}╯`));
		return out.map(fit);
	}

	invalidate(): void {}
}

export default function (pi: ExtensionAPI) {
	if (/^(off|0|false|no)$/i.test(process.env.PI_BOOK?.trim() ?? "")) return;
	const agentDir = getAgentDir();
	let memory: Memory | undefined;
	let project = "";
	let recalled = false;
	/** This session in the journal: short id and the first prompt as its title. */
	let session: { id: string; title: string } | undefined;
	let sessionFile: string | undefined;
	let pending: Promise<unknown> = Promise.resolve();
	const archive = new Archive(path.join(agentDir, "sessions"));
	const log: Array<{ at: Date; what: string }> = [];

	const note = (what: string) => {
		log.push({ at: new Date(), what });
		if (log.length > 12) log.shift();
	};

	/** Built on first use and rebuilt when the config file changes (/reload also does it). */
	const mem = (): Memory => {
		if (!memory) {
			memory = new Memory(loadConfig(agentDir), { inPi: true, agentDir });
			memory.book.ensure();
		}
		return memory;
	};

	pi.on("session_start", async (_event, ctx) => {
		memory = undefined;
		project = projectId(ctx.cwd);
		const sid = ctx.sessionManager.getSessionId();
		session = { id: sid.replace(/-/g, "").slice(-8), title: "" };
		sessionFile = ctx.sessionManager.getSessionFile();
		// Old digests: promote what lasts, drop the rest — in the background.
		const m = mem();
		const scope = project;
		pending = pending.then(async () => {
			try {
				const r = await m.expire(scope);
				if (r.expired) note(`journal: expired ${r.expired} digest${r.expired === 1 ? "" : "s"}, promoted ${r.promoted.filter((a) => a.ok).length}`);
			} catch (err) {
				note(`journal expiry failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		});
		recalled = ctx.sessionManager
			.getBranch()
			.some((e) => (e as { type?: string; customType?: string }).type === "custom_message" && (e as { customType?: string }).customType === RECALL_TYPE);
	});

	// The recall message is summarised away by a compaction; offer it again.
	pi.on("session_compact", async () => {
		recalled = false;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const m = mem();
		if (session && !session.title) session.title = (event.prompt ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
		if (recalled || !m.cfg.recall.enabled) return;
		recalled = true;
		try {
			const r = await m.recall(event.prompt ?? "", project || projectId(ctx.cwd), { sid: session?.id });
			if (!r.text) return;
			return {
				message: {
					customType: RECALL_TYPE,
					content: r.text,
					display: true,
					details: {
						chapters: r.chapters,
						sessions: r.sessions,
						mode: r.mode,
						notes: r.noteCount,
						tokens: r.tokens,
						hits: r.notes,
					},
				},
			};
		} catch (err) {
			note(`recall failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		const m = mem();
		if (m.cfg.capture !== "auto") return;
		const { text, userChars, toolCalls } = transcriptOf(event.messages as unknown[]);
		const scope = project || projectId(ctx.cwd);
		// An acknowledgement ("go ahead") still did work when it used tools: keep
		// the digest current, but never turn such a run into notes.
		const notes = userChars >= 12;
		if (!notes && (!toolCalls || !m.cfg.journal.enabled || !scope || !session)) return;
		// Serialised and in the background: the next prompt never waits on it.
		pending = pending.then(async () => {
			try {
				const r = await m.capture(text, scope, { session: session?.title ? session : undefined, notes });
				const ok = r.applied.filter((a) => a.ok);
				note(
					`capture via ${r.model}: ${ok.length} applied${r.applied.length > ok.length ? `, ${r.applied.length - ok.length} refused` : ""}${r.journal ? `, journal ${r.journal.length} bullets` : ""}${r.applied.length ? `\n${summarize(r.applied)}` : ""}`,
				);
				if (ok.length) {
					// Embed the changed sections now, so the next search does not wait on them.
					await m.index.refresh(m.chunks(scope)).catch(() => {});
					try {
						ctx.ui.setStatus("memory", `book +${ok.length}`);
					} catch {
						// The session was replaced meanwhile.
					}
				}
			} catch (err) {
				note(`capture failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		});
	});

	pi.on("agent_start", async (_event, ctx) => {
		ctx.ui.setStatus("memory", undefined);
	});

	// Let an in-flight capture finish before pi exits, up to 20 s.
	pi.on("session_shutdown", async () => {
		await Promise.race([pending, new Promise((r) => setTimeout(r, 20_000).unref?.())]);
	});

	pi.registerMessageRenderer(RECALL_TYPE, (message, options, theme) => {
		const d = (message.details ?? {}) as { chapters?: number; sessions?: number; hits?: string[]; notes?: number; tokens?: number; mode?: string };
		const n = d.notes ?? d.hits?.length ?? 0;
		const recent = d.sessions ? `, ${d.sessions} recent session${d.sessions === 1 ? "" : "s"}` : "";
		const title = `Memory · ${d.chapters ?? 0} chapter${d.chapters === 1 ? "" : "s"}${recent}, ${n} note${n === 1 ? "" : "s"} recalled${d.tokens ? ` · ~${d.tokens} tokens` : ""}${d.mode && d.mode !== "hybrid" && d.mode !== "empty" ? ` (${d.mode})` : ""}`;
		const body = textOf(message.content as Msg["content"])
			.split("\n")
			.filter((l) => l !== "<memory>" && l !== "</memory>");
		return new RecallView(title, body, options.expanded, options.outputPad, theme as Theme);
	});

	pi.registerTool({
		name: "memory",
		label: "Memory",
		description:
			"Your long-term memory book: Markdown notes about the user (all projects) and the current project, kept across sessions. " +
			'search: hybrid keyword + semantic search (query). read: a chapter by path such as "user/preferences.md", or "INDEX". ' +
			"write: record one durable fact (scope, chapter, section, text). update / delete: change a note, quoting its text as old; delete with path removes an appendix. " +
			"appendix: save a long write-up — a debug session's cause, commands and key log lines, or reference material — as text (up to 6000 chars) under a one-line summary; search lists it by summary, read loads it. " +
			"history: keyword search over past sessions of this project, verbatim — for details the notes do not keep (errors, commands, what exactly was said).",
		promptSnippet: "Search, read or record long-term memory notes about the user and this project",
		promptGuidelines: [
			"Use memory write when the user states a lasting preference, corrects you, or a project decision is made — never for task progress or secrets.",
			"After solving a non-trivial problem whose detail would help next time (a root cause, the commands and log lines that showed it), save it with memory appendix.",
		],
		parameters: Type.Object({
			action: StringEnum(["search", "read", "write", "update", "delete", "appendix", "history"] as const),
			query: Type.Optional(Type.String({ description: "search / history: what to look for" })),
			path: Type.Optional(Type.String({ description: 'read: chapter or appendix path from the index, or "INDEX"; delete: an appendix path' })),
			scope: Type.Optional(StringEnum(["user", "project"] as const, { description: "write / appendix: user = about the person, everywhere; project = this repo only" })),
			chapter: Type.Optional(Type.String({ description: "write: broad topic, e.g. preferences, environment, conventions, decisions, gotchas" })),
			section: Type.Optional(Type.String({ description: "write: short heading within the chapter" })),
			text: Type.Optional(Type.String({ description: "write / update: one self-contained sentence; appendix: the write-up (Markdown)" })),
			title: Type.Optional(Type.String({ description: "appendix: short title; the same title replaces it" })),
			summary: Type.Optional(Type.String({ description: "appendix: one line saying what it holds, so a search finds it" })),
			old: Type.Optional(Type.String({ description: "update / delete: the existing note's text" })),
			budget: Type.Optional(Type.Number({ description: "search: token budget for results (default 800)" })),
			k: Type.Optional(Type.Number({ description: "history: number of excerpts (default 4)" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const m = mem();
			const scope = project || projectId(ctx.cwd);
			const reply = (text: string, details?: unknown) => ({ content: [{ type: "text" as const, text }], details });
			switch (params.action) {
				case "search": {
					if (!params.query) return reply("search needs a query");
					// Single facts under their headings, within a token budget; exact-term
					// (keyword) matches survive the similarity floor.
					const r = await m.read(params.query, scope, {
						budgetTokens: Math.min(Math.max(params.budget ?? 800, 100), 4000),
						unit: "bullet",
						minCos: m.cfg.recall.minCos,
						keepKeyword: true,
						signal,
					});
					const apps = await m.findAppendices(params.query, scope, { k: 4, minCos: m.cfg.recall.minCos, keepKeyword: true, signal }).catch(() => []);
					if (!r.groups.length && !apps.length) return reply("No matching notes.");
					const body = r.groups.map((g) => `[${g.section.rel} › ${g.section.heading}]\n${g.lines.join("\n")}`);
					if (apps.length) body.push(`Appendices (read the path for the full text):\n${apps.map((a) => `- ${a.rel} — ${a.summary}`).join("\n")}`);
					return reply(`${body.join("\n\n")}${r.mode !== "hybrid" ? `\n\n(${r.mode} search${r.error ? `: ${r.error}` : ""})` : ""}`);
				}
				case "history": {
					if (!params.query) return reply("history needs a query");
					if (!scope) return reply("No project here (temp directory): past sessions are searched per project.");
					const hits = archive.search(params.query, scope, Math.min(Math.max(params.k ?? 4, 1), 10), sessionFile);
					if (!hits.length) return reply("No past session matches.");
					return reply(hits.map((h) => `[${h.date} · ${h.file}]\n${h.text}`).join("\n\n---\n\n"));
				}
				case "read": {
					const rel = (params.path ?? "INDEX").replace(/^\/+/, "").replace(/#.*$/, "");
					if (rel === "INDEX" || rel === "INDEX.md") {
						m.book.writeIndex();
						return reply(m.book.readText("INDEX.md") ?? "The book is empty.");
					}
					const inScope = rel.startsWith("user/") || rel.startsWith(`projects/${scope}/`);
					if (!inScope || rel.includes("..")) return reply(`${rel} is not a chapter in scope (user/… or projects/${scope}/…)`);
					return reply(m.book.readText(rel) ?? `No chapter ${rel}. Read "INDEX" for the list.`);
				}
				case "appendix": {
					const a = m.saveAppendix(
						{ scope: params.scope ?? "project", title: params.title ?? "", summary: params.summary ?? "", body: params.text ?? "" },
						scope,
						{ session: session?.id },
					);
					note(`tool appendix: ${a.note}`);
					if (a.ok) await m.index.refresh(m.appendixChunks(scope)).catch(() => {});
					return reply(a.ok ? `Appendix ${a.note}` : `Not saved — ${a.note}`);
				}
				case "delete":
					if (params.path) {
						const rel = params.path.replace(/^\/+/, "");
						const ok = /^(?:user|projects\/[^/]+)\/appendix\/[^/]+\.md$/.test(rel) && (rel.startsWith("user/") || rel.startsWith(`projects/${scope}/`));
						if (!ok) return reply(`${rel} is not an appendix in scope`);
						const done = m.book.removeAppendix(rel);
						if (done) m.book.writeIndex();
						note(`tool delete ${rel}: ${done ? "removed" : "not found"}`);
						return reply(done ? `Deleted ${rel} (previous text kept in .history/)` : `No appendix ${rel}`);
					}
				// falls through: delete a note
				case "write":
				case "update": {
					const op: Op =
						params.action === "write"
							? { op: "add", scope: params.scope ?? "project", chapter: params.chapter ?? "notes", section: params.section ?? "Notes", text: params.text ?? "" }
							: params.action === "update"
								? { op: "update", old: params.old ?? "", text: params.text ?? "" }
								: { op: "delete", old: params.old ?? "" };
					const [a] = m.apply([op], scope);
					note(`tool ${params.action}: ${summarize([a])}`);
					return reply(a.ok ? `${params.action === "write" ? "Recorded" : params.action === "update" ? "Updated" : "Deleted"}: ${a.note}` : `Not changed — ${a.note}`);
				}
			}
		},
	});

	pi.registerCommand("remember", {
		description: "File a fact in the memory book (the model picks where)",
		handler: async (args, ctx) => {
			const fact = (args ?? "").trim();
			if (!fact) return ctx.ui.notify("usage: /remember <fact>", "warning");
			const m = mem();
			const scope = project || projectId(ctx.cwd);
			try {
				const r = await m.capture(`User: Remember this: ${fact}`, scope);
				if (r.applied.some((a) => a.ok)) return ctx.ui.notify(summarize(r.applied), "info");
				if (r.applied.length) return ctx.ui.notify(`Not filed:\n${summarize(r.applied)}`, "warning");
			} catch (err) {
				note(`/remember model call failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			// Never drop an explicit request: file it verbatim when the model would not.
			const [a] = m.apply([{ op: "add", scope: "project", chapter: "notes", section: "Inbox", text: fact }], scope);
			ctx.ui.notify(a.ok ? `Filed verbatim: ${a.note}` : `Not filed — ${a.note}`, a.ok ? "info" : "warning");
		},
	});

	pi.registerCommand("memory", {
		description: "Memory book: status | search <query> | reindex | tidy",
		handler: async (args, ctx) => {
			const [sub, ...rest] = (args ?? "").trim().split(/\s+/);
			memory = undefined; // pick up config edits
			const m = mem();
			const scope = project || projectId(ctx.cwd);

			if (sub === "search") {
				const q = rest.join(" ");
				if (!q) return ctx.ui.notify("usage: /memory search <query>", "warning");
				const r = await m.search(q, scope, 8);
				const lines = r.hits.map(
					(h) => `${h.score.toFixed(4)} bm25#${h.bm25 ?? "-"} vec#${h.vector ?? "-"}  ${h.chunk.section.rel} › ${h.chunk.section.heading}`,
				);
				return ctx.ui.notify([`${r.mode}${r.error ? ` (${r.error})` : ""}`, ...(lines.length ? lines : ["no hits"])].join("\n"), "info");
			}

			if (sub === "reindex") {
				const chunks = [...m.chunks(), ...m.appendixChunks()];
				try {
					const n = await m.index.refresh(chunks);
					m.index.prune(chunks);
					m.book.writeIndex();
					return ctx.ui.notify(`reindexed: ${chunks.length} chunks, ${n} embedded, INDEX.md rewritten`, "info");
				} catch (err) {
					m.book.writeIndex();
					return ctx.ui.notify(`INDEX.md rewritten; embeddings failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
				}
			}

			if (sub === "tidy") {
				const chapters = m.book.chapters([scope]).filter((c) => c.sections.length);
				if (!chapters.length) return ctx.ui.notify("nothing to tidy", "info");
				const results: string[] = [];
				for (const c of chapters) {
					const text = m.book.readText(c.rel) ?? "";
					try {
						const { text: out } = await m.llm(TIDY_SYSTEM, `Chapter ${c.rel}:\n\n${text}\n\nReply with JSON only.`, { label: "memory tidy" });
						const ops = parseOps(out).filter((o) => o.op !== "add");
						const applied = m.apply(ops, scope, { maxOps: 20 });
						if (applied.length) results.push(`${c.rel}\n${summarize(applied)}`);
					} catch (err) {
						results.push(`${c.rel}: ${err instanceof Error ? err.message : String(err)}`);
					}
				}
				return ctx.ui.notify(results.length ? `${results.join("\n")}\n(previous text kept in .history/)` : "already tidy", "info");
			}

			const chapters = m.book.chapters([scope]);
			const notes = chapters.reduce((n, c) => n + c.sections.reduce((k, s) => k + s.text.split("\n").length - 1, 0), 0);
			const all = m.book.chapters();
			const lines = [
				`book: ${m.cfg.dir}  (${all.length} chapters total)`,
				`in scope: ${chapters.length} chapters, ${notes} notes — ${scope ? `user + ${scope}` : "user only (temp directory, no project)"}`,
				`llm: ${describeLlm(m.cfg.llm)} · capture ${m.cfg.capture}`,
				`embed: ${m.cfg.embed.url ? `${m.cfg.embed.model} @ ${m.cfg.embed.url}` : "off (keyword search only)"}${m.index.embedder.lastError ? ` — last error: ${m.index.embedder.lastError}` : ""}`,
				...(m.cfg.warnings ?? []).map((w) => `⚠ ${w}`),
				`recall: ${m.cfg.recall.enabled ? `on, notes ≤${m.cfg.recall.budgetTokens} tokens, block ≤${m.cfg.recall.maxChars} chars` : "off"} · ${recalled ? "done this session" : "pending"}`,
				`journal: ${m.cfg.journal.enabled ? `${m.book.journal(scope).length} digests, recall ${m.cfg.journal.recall}, expire after ${m.cfg.journal.ttlDays || "∞"} days` : "off"}${session ? ` · this session [s:${session.id}]` : ""}`,
				`appendix: ${m.book.appendices(scope ? [scope] : []).length} long write-ups in scope`,
				`archive: ${archive.files(scope, sessionFile).length} past sessions searchable (memory action "history")`,
				...(log.length ? ["", ...log.slice(-6).map((e) => `${e.at.toTimeString().slice(0, 8)} ${e.what}`)] : []),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

const TIDY_SYSTEM = `You tidy one chapter of a coding agent's long-term memory. Propose edits that make it shorter without losing information:
- merge duplicates: "update" one note to the combined fact, "delete" the others
- when two notes contradict, keep the newer (dates prefix each note) and delete the older
- delete notes that are task progress rather than lasting facts
Never invent facts. Quote "old" exactly as the note's text (without the date).
Reply with JSON only: {"ops": [{"op": "update", "old": "…", "text": "…"}, {"op": "delete", "old": "…"}]} — or {"ops": []} when it is already tidy.`;

