/**
 * pi-book outside pi: inspect the book, and serve the benchmark adapter.
 *
 *   node cli.ts status
 *   node cli.ts search <query> [--project <id>] [--k <n>]
 *   node cli.ts recall <prompt> --project <id>
 *   node cli.ts capture --project <id> [--date YYYY-MM-DD] [--session <id>] < transcript.txt
 *   node cli.ts history <query> [--project <id>]   past pi sessions, verbatim
 *   node cli.ts serve          JSON lines on stdin → JSON lines on stdout
 *
 * Config is the same model-state.json "memory" section pi uses; PI_MEMORY_DIR
 * and PI_MEMORY_CONFIG override it. `serve` refuses to run against the real
 * book: it needs PI_MEMORY_DIR, because "reset" deletes the directory.
 *
 * serve requests (one JSON object per line, answered in order):
 *   {"cmd":"reset"}
 *   {"cmd":"ingest","project":"p","title":"Session 3","date":"2023-05-08","lines":["A: hi", …],
 *    "extract":false}                raw: the lines become one section
 *                                     extract: the capture model turns them into notes
 *                                     (plus a journal digest per session when the
 *                                     config enables the journal)
 *   {"cmd":"retrieve","project":"p","query":"…","k":10}      top-k section chunks
 *   {"cmd":"retrieve","project":"p","query":"…","budget":1000,"unit":"bullet","neighbors":1}
 *                                     budgeted read (see Memory.read)
 *   {"cmd":"stats"}
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { Archive } from "./archive.ts";
import { projectId } from "./book.ts";
import { describe as describeLlm } from "./llm.ts";
import { loadConfig, Memory } from "./memory.ts";

const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");

function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	if (i < 0) return undefined;
	const v = args[i + 1];
	args.splice(i, 2);
	return v;
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const c of process.stdin) chunks.push(c as Buffer);
	return Buffer.concat(chunks).toString("utf-8");
}

async function serve(memory: Memory): Promise<void> {
	const real = path.join(agentDir, "book");
	if (!process.env.PI_MEMORY_DIR || path.resolve(memory.cfg.dir) === path.resolve(real)) {
		throw new Error("serve needs PI_MEMORY_DIR pointing away from the real book");
	}
	const out = (obj: unknown) => process.stdout.write(`${JSON.stringify(obj)}\n`);
	const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
	for await (const line of rl) {
		if (!line.trim()) continue;
		let req: Record<string, unknown>;
		try {
			req = JSON.parse(line);
		} catch {
			out({ ok: false, error: "bad json" });
			continue;
		}
		const t0 = performance.now();
		try {
			const project = String(req.project ?? "bench");
			switch (req.cmd) {
				case "reset":
					fs.rmSync(memory.cfg.dir, { recursive: true, force: true });
					memory.book.ensure();
					out({ ok: true });
					break;
				case "ingest": {
					const lines = (req.lines as string[]) ?? [];
					const date = String(req.date ?? "").slice(0, 10) || new Date().toISOString().slice(0, 10);
					const title = String(req.title ?? "Session");
					if (req.extract) {
						const transcript = lines.join("\n");
						const sid = title.replace(/[^\w-]+/g, "-");
						const r = await memory.capture(transcript, project, { profile: "conversation", forceScope: "project", date, session: { id: sid, title } });
						out({
							ok: true,
							applied: r.applied.filter((a) => a.ok).length,
							refused: r.applied.filter((a) => !a.ok).length,
							journal: r.journal?.length ?? 0,
							model: r.model,
							ms: Math.round(performance.now() - t0),
						});
					} else {
						memory.book.appendSection(memory.book.rel("project", "sessions", project), `${title} (${date})`, lines, date, "Conversation sessions, verbatim");
						out({ ok: true, ms: Math.round(performance.now() - t0) });
					}
					break;
				}
				case "retrieve": {
					if (req.budget) {
						const r = await memory.read(String(req.query ?? ""), project, {
							budgetTokens: Number(req.budget),
							unit: req.unit === "section" ? "section" : "bullet",
							neighbors: Number(req.neighbors ?? 0),
						});
						out({
							ok: true,
							mode: r.mode,
							error: r.error,
							tokens: r.tokens,
							ms: Math.round(performance.now() - t0),
							docs: r.groups.map((g) => ({ id: g.section.id, content: `[${g.section.chapter} › ${g.section.heading}]\n${g.lines.join("\n")}` })),
						});
						break;
					}
					const k = Number(req.k ?? 10);
					const r = await memory.search(String(req.query ?? ""), project, k);
					out({
						ok: true,
						mode: r.mode,
						error: r.error,
						ms: Math.round(performance.now() - t0),
						docs: r.hits.map((h) => ({
							id: h.chunk.section.id,
							content: `[${h.chunk.section.chapter} › ${h.chunk.section.heading}]\n${h.chunk.text.split("\n").slice(1).join("\n")}`,
							bm25: h.bm25,
							vector: h.vector,
						})),
					});
					break;
				}
				case "stats": {
					const chapters = memory.book.chapters(req.project ? [project] : undefined);
					const bullets = memory.book.bullets(req.project ? [project] : undefined);
					out({ ok: true, chapters: chapters.length, sections: chapters.reduce((n, c) => n + c.sections.length, 0), notes: bullets.length, chars: chapters.reduce((n, c) => n + c.chars, 0) });
					break;
				}
				default:
					out({ ok: false, error: `unknown cmd ${String(req.cmd)}` });
			}
		} catch (err) {
			out({ ok: false, error: err instanceof Error ? err.message : String(err) });
		}
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const cmd = args.shift() ?? "status";
	const project = flag(args, "project") ?? projectId(process.cwd());
	const k = Number(flag(args, "k") ?? 6);
	const date = flag(args, "date");
	const sessionId = flag(args, "session");
	const memory = new Memory(loadConfig(agentDir), { inPi: false, agentDir });
	memory.book.ensure();

	switch (cmd) {
		case "serve":
			return serve(memory);
		case "search": {
			const r = await memory.search(args.join(" "), project, k);
			console.log(`${r.mode}${r.error ? ` (${r.error})` : ""}`);
			for (const h of r.hits) console.log(`\n${h.score.toFixed(4)} bm25#${h.bm25 ?? "-"} vec#${h.vector ?? "-"} cos=${h.cos?.toFixed(3) ?? "-"} ${h.chunk.section.id}\n${h.chunk.text}`);
			return;
		}
		case "recall": {
			const r = await memory.recall(args.join(" "), project, { sid: sessionId });
			console.log(r.text || "(empty book)");
			console.error(`\n${r.text.length} chars (~${r.tokens} tokens) · ${r.sessions} sessions · ${r.noteCount} notes · ${r.mode}`);
			return;
		}
		case "capture": {
			const transcript = await readStdin();
			const r = await memory.capture(transcript, project, { date, session: sessionId ? { id: sessionId, title: "cli" } : undefined });
			console.log(`model: ${r.model}\nraw: ${r.raw}\n`);
			for (const a of r.applied) console.log(`${a.ok ? "✓" : "·"} ${JSON.stringify(a.op)} — ${a.note}`);
			if (r.journal) console.log(`journal [s:${sessionId}]:\n${r.journal.map((b) => `  - ${b}`).join("\n")}`);
			return;
		}
		case "history": {
			const hits = new Archive(path.join(agentDir, "sessions")).search(args.join(" "), project, k);
			for (const h of hits) console.log(`\n${h.score.toFixed(2)} ${h.date} ${h.file}\n${h.text}`);
			if (!hits.length) console.log("no matches");
			return;
		}
		default: {
			const all = memory.book.chapters();
			console.log(`book: ${memory.cfg.dir} (${all.length} chapters)`);
			console.log(`project here: ${project}`);
			console.log(`llm: ${describeLlm(memory.cfg.llm)}`);
			console.log(`embed: ${memory.cfg.embed.model} @ ${memory.cfg.embed.url || "off"}`);
			for (const w of memory.cfg.warnings ?? []) console.log(`⚠ ${w}`);
		}
	}
}

main().then(
	() => process.exit(0),
	(err) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	},
);
