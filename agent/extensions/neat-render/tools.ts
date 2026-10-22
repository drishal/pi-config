/**
 * tools — what each tool call did, in one row of words.
 *
 * A tool row is described by a registry entry, not by an if-chain: a verb
 * (`Read`, `Run`, `Search`…), the subject (path, command, query), and the
 * facts worth keeping (line counts, exit codes, results). `summarize` is the
 * only thing that knows tool-specific argument shapes; the row renderer just
 * lays the words out.
 */

import { countLines, num, off, oneLine, plural, shortPath, str, type ToolRow } from "./style.ts";

/* ── small helpers ─────────────────────────────────────────────────────── */

export function resultText(row: ToolRow): string {
	const parts = row.result?.content;
	if (!Array.isArray(parts)) return "";
	return parts
		.filter((p) => p?.type === "text" && typeof p.text === "string")
		.map((p) => p.text as string)
		.join("\n");
}

/* ── per-tool row text ─────────────────────────────────────────────────── */

/** A tool row reduced to label + detail + trailing facts. */
export type Summary = {
	label: string;
	detail?: string;
	facts: string[];
	/** Text between label and detail. "" gives `Update(path)`; default " ". */
	glue?: string;
	/** Extra lines under the facts line, already split. Diff rows for edits. */
	body?: string[];
	/** Render nothing at all — a batch member that is not the commit. */
	hidden?: boolean;
	/** The model's own remark about the call (a bash command's leading
	 *  `# comment` lines), shown dim on its own line instead of in the detail. */
	note?: string;
};

/**
 * Split a bash command's leading `# comment` lines off the command.
 *
 * Models often narrate inside the command itself ("# check how pi loads
 * extensions ⏎ rg -n …"), which collapses to `$ # check how pi loads…` and
 * pushes the real command off the row. Only the display changes: the tool
 * still runs the command verbatim. A shebang is not a comment, and a command
 * that is nothing but comments is left alone.
 */
export function splitLeadingComments(cmd: string, marker = "#"): { note?: string; command: string } {
	const lines = cmd.split("\n");
	const notes: string[] = [];
	let i = 0;
	for (; i < lines.length; i++) {
		const t = lines[i].trim();
		if (t === "" && notes.length > 0) continue;
		if (!t.startsWith(marker) || t.startsWith("#!")) break;
		const text = t.slice(marker.length).replace(/^[#/\s]*/, "");
		if (text) notes.push(text);
	}
	const command = lines.slice(i).join("\n").trim();
	if (!command || notes.length === 0) return { command: cmd };
	return { note: notes.join(" "), command };
}

/** Diff rows shown inline under an edit before the rest is elided. */
export const DIFF_PREVIEW_LINES = 8;

/**
 * hashline emits ` anchor│text`, `-anchor│text`, `+anchor│text`. Strip the
 * anchor — it is addressing, not content — and keep the +/-/space marker so
 * the row reads as a diff.
 */
export function diffPreview(diff: string): string[] {
	const rows = diff
		.split("\n")
		// A combined batch diff opens with a `batch N:` caption; the row count
		// is already on the stat line above.
		.filter((l) => l.length > 0 && !/^batch \d+:$/.test(l.trim()));
	const out: string[] = [];
	for (const row of rows.slice(0, DIFF_PREVIEW_LINES)) {
		const marker = row[0] === "+" || row[0] === "-" ? row[0] : " ";
		const bar = row.indexOf("│");
		out.push(`${marker} ${bar >= 0 ? row.slice(bar + 1) : row.slice(1)}`);
	}
	if (rows.length > out.length) out.push(`… ${rows.length - out.length} more`);
	return out;
}

/** "Added 35 lines, removed 2 lines" — Claude Code's phrasing. */
export function diffStat(added?: number, removed?: number): string | undefined {
	const parts: string[] = [];
	if (added) parts.push(`Added ${added} line${added === 1 ? "" : "s"}`);
	if (removed) parts.push(`removed ${removed} line${removed === 1 ? "" : "s"}`);
	if (parts.length === 0) return undefined;
	return parts.join(", ");
}

export const READ_TOOLS = new Set(["read", "read_symbol", "read_enclosing"]);
export const SEARCH_TOOLS = new Set([
	"grep", "anchor_grep", "ast_grep_search", "symbol_search", "find", "glob",
]);
export const MUTATE_TOOLS = new Set([
	"write", "edit", "replace", "insert", "ast_grep_replace", "undo_last_change",
]);
// Web tools take their subject under a named key, and the generic fallback
// below picks the first scalar *by key order* — which on `{mode, url}` shows
// "answer" and hides the URL entirely. Name them explicitly instead.
export const WEB_TOOLS = new Set([
	"web_search", "web_fetch", "fetch_content", "get_search_content", "source_check",
]);

/** Drop the scheme and any trailing slash so a URL fits a row. */
export function shortUrl(u: string): string {
	return u.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

export function summarize(row: ToolRow): Summary {
	const name = row.toolName ?? "tool";
	const args = (row.args ?? {}) as Record<string, unknown>;
	const text = resultText(row);
	const lines = countLines(text);

	const path =
		str(args.path) ?? str(args.file_path) ?? str(args.filePath) ??
		str(args.file) ?? str(args.target);

	if (READ_TOOLS.has(name)) {
		let where = path ? shortPath(path) : (str(args.symbol) ?? "");
		const from = num(args.offset) ?? num(args.start_line) ?? num(args.startLine);
		const limit = num(args.limit);
		const to = num(args.end_line) ?? num(args.endLine) ??
			(from !== undefined && limit !== undefined ? from + limit - 1 : undefined);
		if (from !== undefined) where += to !== undefined ? `:${from}-${to}` : `:${from}`;
		return { label: "Read", detail: where, facts: lines ? [plural(lines, "line")] : [] };
	}

	if (name === "bash") {
		const cmd = str(args.command) ?? str(args.cmd) ?? "";
		// Prefer a real exit code when the tool reports one.
		const code = num(row.result?.details?.exitCode) ?? num(row.result?.details?.exit_code);
		const facts: string[] = [];
		// Success is the expected case and the bullet already colours for it,
		// so `exit 0` on every call is a word that never varies. Only a
		// non-zero code — or a failure with no code to report — says anything.
		if (code !== undefined) {
			if (code !== 0) facts.push(`exit ${code}`);
		} else if (!row.isPartial && row.result?.isError) {
			facts.push("failed");
		}
		if (lines) facts.push(plural(lines, "line"));
		const { note, command } = off("NEAT_RENDER_COMMENTS") ? { command: cmd } : splitLeadingComments(cmd);
		return { label: "Bash", detail: `$ ${command}`, facts, note };
	}

	if (name === "eval") {
		// The eval extension: a Python/JavaScript cell. Label by language,
		// show the first line of code (a leading comment goes above the row,
		// as for bash), and the size of what it printed.
		const lang = str(args.language);
		const code = str(args.code) ?? "";
		const { note, command } = off("NEAT_RENDER_COMMENTS")
			? { command: code }
			: splitLeadingComments(code, lang === "js" ? "//" : "#");
		const codeLines = command.split("\n").filter((l) => l.trim());
		const facts: string[] = [];
		if (!row.isPartial && row.result?.isError) facts.push("failed");
		if (lines) facts.push(plural(lines, "line"));
		const ms = num(row.result?.details?.durationMs);
		if (ms !== undefined && ms >= 1000) facts.push(`${(ms / 1000).toFixed(1)}s`);
		return {
			label: lang === "js" ? "JavaScript" : lang === "py" ? "Python" : "eval",
			detail: codeLines.length > 1 ? `${codeLines[0]} …` : codeLines[0],
			facts,
			note,
		};
	}

	if (WEB_TOOLS.has(name)) {
		// A url/query may arrive singular or as a list; show the first and say
		// how many more, so a parallel fan-out is still one readable row.
		const pick = (single: unknown, many: unknown): [string?, number?] => {
			const one = str(single);
			if (one) return [one, 1];
			if (Array.isArray(many)) {
				const first = str(many[0]);
				if (first) return [first, many.length];
			}
			return [undefined, undefined];
		};
		const [url, urlCount] = pick(args.url, args.urls);
		const [query, queryCount] = pick(args.query ?? args.q, args.queries);
		const subject = url ? shortUrl(url) : query;
		const count = url ? urlCount : queryCount;

		const facts: string[] = [];
		// `mode` is the thing that used to masquerade as the subject; it is a
		// modifier, so it belongs with the outcome, not the title.
		const mode = str(args.mode);
		if (mode && mode !== "readable") facts.push(mode);
		if (lines) facts.push(plural(lines, "line"));

		return {
			label: name,
			detail: subject
				? count && count > 1
					? `${subject} +${count - 1} more`
					: subject
				: undefined,
			facts,
		};
	}

	if (SEARCH_TOOLS.has(name)) {
		const q = str(args.pattern) ?? str(args.query) ?? str(args.regex) ?? str(args.name) ?? "";
		const scope = path ? ` in ${shortPath(path)}` : "";
		return {
			label: name === "anchor_grep" ? "grep" : name,
			detail: `${q}${scope}`,
			facts: lines ? [`${lines} ${lines === 1 ? "result" : "results"}`] : [],
		};
	}

	if (MUTATE_TOOLS.has(name)) {
		const d = (row.result?.details ?? {}) as {
			snapshotId?: unknown;
			classification?: unknown;
			diff?: unknown;
			batch?: { last?: unknown };
			metrics?: { added_lines?: unknown; removed_lines?: unknown };
		};

		// hashline groups same-file edits from one assistant message into a
		// batch that validates every member but commits once, on the last
		// call. The earlier members reply "In batch N" with no diff, and
		// their metrics are per-call; the last member carries the combined
		// diff and the combined totals. Rendering all of them turns a single
		// logical edit into a column of near-identical rows, so only the
		// commit is shown.
		const batch = d.batch;
		if (batch && batch.last === false && !row.isPartial) {
			return { label: name, facts: [], hidden: true };
		}

		// hashline's replace/insert identify the file by anchor, so `path` is
		// usually absent from the args. Its snapshotId is
		// `v2|<path>|<ino>|<mtime>|<ctime>|<size>`, which carries the real one.
		const snapPath = (() => {
			const snap = str(d.snapshotId);
			if (!snap) return undefined;
			const parts = snap.split("|");
			return parts.length > 2 ? parts[1] : undefined;
		})();
		const where = path ?? snapPath;

		const added = num(d.metrics?.added_lines);
		const removed = num(d.metrics?.removed_lines);
		const facts: string[] = [];
		let body: string[] | undefined;

		if (row.result?.isError) {
			// A failed edit used to render no facts at all — only a red dot,
			// with nothing saying what went wrong.
			facts.push("failed");
		} else if (str(d.classification) === "noop") {
			facts.push("no change");
		} else {
			const stat = diffStat(added, removed);
			if (stat) facts.push(stat);
			else if (added !== undefined || removed !== undefined) facts.push("no change");
			const diff = str(d.diff);
			if (diff) body = diffPreview(diff);
		}

		// `Update(path)` / `Write(path)`, the way Claude Code names an edit:
		// one verb, the file in parens, and the scale underneath.
		return {
			label: name === "write" ? "Write" : "Update",
			detail: where ? `(${shortPath(where)})` : undefined,
			glue: "",
			facts,
			body,
		};
	}

	// Unknown tool: show the first meaningful scalar argument.
	const firstArg = Object.values(args).map(str).find(Boolean);
	return {
		label: name,
		detail: firstArg,
		facts: lines ? [plural(lines, "line")] : [],
	};
}
