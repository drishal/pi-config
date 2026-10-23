/**
 * tools — what each tool call did, in one row of words.
 *
 * A row is described by a registry entry, not by an if-chain: a verb (`Read`,
 * `Search`, `Bash`…), a category that feeds the turn summary, the subject (a
 * path, a command, a query), and the facts worth keeping (line counts, exit
 * codes, result counts). `summarize` is the only thing that knows
 * tool-specific argument shapes; the row renderer just lays the words out.
 */

import { type ToolRow, countLines, num, plural, shortPath, str } from "./style.ts";

/** What a call did, at the coarsest useful level. Feeds the turn summary. */
export type Category = "read" | "run" | "search" | "fetch" | "edit" | "other";

/** A tool row reduced to verb + subject + trailing facts. */
export type Summary = {
	/** The verb: Read, Search, Bash. Always one word unless a tool is unknown. */
	verb: string;
	category: Category;
	subject?: string;
	facts: string[];
	/** Text between verb and subject. "" gives `Edit(path)`; default " ". */
	glue?: string;
	/** Extra lines under the facts line, already split. Diff rows for edits. */
	body?: string[];
	/** Render nothing at all — a batch member that is not the commit. */
	hidden?: boolean;
	/** The model's own remark about the call (a bash command's leading
	 *  `# comment` lines), shown dim on its own line instead of in the subject. */
	note?: string;
	/** highlight.js language for the subject, when the subject is code. */
	lang?: string;
};

/** Everything a registry entry may look at. */
type Ctx = {
	row: ToolRow;
	args: Record<string, unknown>;
	/** Text the tool printed. */
	text: string;
	lines: number;
	path?: string;
	details: Record<string, unknown>;
};

type Spec = {
	category: Category;
	verb: string | ((c: Ctx) => string);
	subject?(c: Ctx): string | undefined;
	lang?: string | ((c: Ctx) => string | undefined);
	facts?(c: Ctx): string[];
	body?(c: Ctx): string[] | undefined;
	note?(c: Ctx): string | undefined;
	hidden?(c: Ctx): boolean;
	glue?: string;
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

/** Drop the scheme and any trailing slash so a URL fits a row. */
const shortUrl = (u: string) => u.replace(/^https?:\/\//, "").replace(/\/+$/, "");

/**
 * A url/query may arrive singular or as a list; show the first and say how
 * many more, so a parallel fan-out is still one readable row.
 */
function pickSubject(single: unknown, many: unknown): string | undefined {
	const one = str(single);
	if (one) return one;
	if (Array.isArray(many)) return str(many[0]);
	return undefined;
}

function withMore(single: unknown, many: unknown): string | undefined {
	const one = pickSubject(single, many);
	if (!one) return undefined;
	if (Array.isArray(many) && many.length > 1) return `${one} +${many.length - 1} more`;
	return one;
}

/** The file a mutate tool touched: `path` when given, else hashline's snapshot. */
function mutatePath(c: Ctx): string | undefined {
	// hashline's replace/insert identify the file by anchor, so `path` is
	// usually absent from the args. Its snapshotId is
	// `v2|<path>|<ino>|<mtime>|<ctime>|<size>`, which carries the real one.
	const snap = str(c.details.snapshotId);
	if (!snap) return c.path;
	const parts = snap.split("|");
	return c.path ?? (parts.length > 2 ? parts[1] : undefined);
}

const lineFacts = (c: Ctx) => (c.lines ? [plural(c.lines, "line")] : []);

/** Bodiless failure marker, shared by every tool that reports `isError`. */
function failedFact(c: Ctx): string[] {
	return !c.row.isPartial && c.row.result?.isError ? ["failed"] : [];
}

/**
 * Acronyms and short words that must not be title-cased by `humanise`
 * (`lsp_diagnostics` → `LSP diagnostics`, not `Lsp diagnostics`).
 */
const UPPER = new Set([
	"lsp", "api", "mcp", "cli", "ui", "url", "http", "json", "pdf", "sql", "id",
	"bg", "pr", "ast", "llm", "tui", "fs", "css", "html",
]);

/** `lsp_diagnostics` → `LSP diagnostics`. The fallback for tools with no entry. */
export function humanise(name: string): string {
	const words = name.split(/[_\-.]+/).filter(Boolean);
	if (words.length === 0) return name;
	return words
		.map((w, i) => (UPPER.has(w.toLowerCase()) ? w.toUpperCase() : i === 0 ? w[0].toUpperCase() + w.slice(1) : w))
		.join(" ");
}

/**
 * Every search-shaped tool reads the same: a pattern (or query, regex, name)
 * and, when one was given, the place it was searched.
 */
const SEARCH: Record<string, Spec> = {
	grep: {
		category: "search",
		verb: "Search",
		subject: (c) => {
			const q = str(c.args.pattern) ?? str(c.args.query) ?? str(c.args.regex) ?? str(c.args.name) ?? "";
			const scope = c.path ? ` in ${shortPath(c.path)}` : "";
			return `${q}${scope}`;
		},
		facts: (c) => (c.lines ? [`${c.lines} ${c.lines === 1 ? "result" : "results"}`] : []),
	},
};

for (const name of ["anchor_grep", "ast_grep_search", "symbol_search", "find", "glob"]) {
	SEARCH[name] = SEARCH.grep;
}

/**
 * The registry: one entry per tool family. An entry only says what makes the
 * row readable — a missing `subject` or `facts` just leaves that part blank.
 */
const REGISTRY: Record<string, Spec> = {
	...SEARCH,

	read: {
		category: "read",
		verb: "Read",
		subject: (c) => {
			let where = c.path ? shortPath(c.path) : (str(c.args.symbol) ?? "");
			const from = num(c.args.offset) ?? num(c.args.start_line) ?? num(c.args.startLine);
			const limit = num(c.args.limit);
			const to = num(c.args.end_line) ?? num(c.args.endLine) ??
				(from !== undefined && limit !== undefined ? from + limit - 1 : undefined);
			if (from !== undefined) where += to !== undefined ? `:${from}-${to}` : `:${from}`;
			return where;
		},
		facts: lineFacts,
	},
	read_symbol: { category: "read", verb: "Read", subject: (c) => str(c.args.symbol) ?? c.path, facts: lineFacts },
	read_enclosing: { category: "read", verb: "Read", subject: (c) => c.path, facts: lineFacts },

	bash: {
		category: "run",
		// `Bash` names the shell the command runs in; the `$ ` subject already
		// says it is a command line, so the verb stays the tool's own name.
		verb: "Bash",
		lang: "bash",
		note: (c) => splitLeadingComments(str(c.args.command) ?? str(c.args.cmd) ?? "").note,
		subject: (c) => `$ ${splitLeadingComments(str(c.args.command) ?? str(c.args.cmd) ?? "").command}`,
		facts: (c) => {
			const code = num(c.details.exitCode) ?? num(c.details.exit_code);
			const facts: string[] = [];
			// Success is the expected case and the bullet already colours for
			// it, so `exit 0` on every call is a word that never varies. Only a
			// non-zero code — or a failure with no code to report — says anything.
			if (code !== undefined) {
				if (code !== 0) facts.push(`exit ${code}`);
			} else facts.push(...failedFact(c));
			return [...facts, ...lineFacts(c)];
		},
	},

	eval: {
		category: "run",
		// The eval extension: a Python/JavaScript cell. Label by language and
		// show the first line of code, as for bash.
		verb: (c) => {
			const lang = str(c.args.language);
			return lang === "js" ? "JavaScript" : lang === "py" ? "Python" : "Eval";
		},
		lang: (c) => {
			const lang = str(c.args.language);
			return lang === "js" ? "javascript" : lang === "py" ? "python" : undefined;
		},
		note: (c) =>
			splitLeadingComments(
				str(c.args.code) ?? "",
				str(c.args.language) === "js" ? "//" : "#",
			).note,
		subject: (c) => {
			const lang = str(c.args.language);
			const code = splitLeadingComments(str(c.args.code) ?? "", lang === "js" ? "//" : "#").command;
			const rows = code.split("\n").filter((l) => l.trim());
			return rows.length > 1 ? `${rows[0]} …` : rows[0];
		},
		facts: (c) => {
			const facts = failedFact(c);
			if (c.lines) facts.push(plural(c.lines, "line"));
			const ms = num(c.details.durationMs);
			if (ms !== undefined && ms >= 1000) facts.push(`${(ms / 1000).toFixed(1)}s`);
			return facts;
		},
	},

	...SEARCH,

	web_search: {
		category: "search",
		verb: "Search",
		subject: (c) => pickSubject(c.args.query ?? c.args.q, c.args.queries),
		facts: lineFacts,
	},
	source_check: {
		category: "search",
		verb: "Search",
		subject: (c) => pickSubject(c.args.claim, c.args.queries),
		facts: lineFacts,
	},
	fetch_content: {
		category: "fetch",
		verb: "Fetch",
		subject: (c) => {
			const url = withMore(c.args.url, c.args.urls);
			return url ? shortUrl(url) : withMore(c.args.query, c.args.queries);
		},
		facts: (c) => {
			// `mode` is a modifier, so it belongs with the outcome.
			const mode = str(c.args.mode);
			const facts = mode && mode !== "readable" ? [mode] : [];
			return [...facts, ...lineFacts(c)];
		},
	},
	web_fetch: { category: "fetch", verb: "Fetch" },
	get_search_content: { category: "fetch", verb: "Fetch" },

	codemode: {
		category: "run",
		// The model writes JavaScript that calls other tools. The verb matches
		// what the fallback used to produce, so only the colour is new.
		verb: "Codemode",
		lang: "javascript",
		subject: (c) => {
			const rows = (str(c.args.code) ?? "").split("\n").filter((l) => l.trim());
			return rows.length > 1 ? `${rows[0]} …` : rows[0];
		},
		facts: lineFacts,
	},

	write: {
		category: "edit",
		verb: "Write",
		glue: "",
		subject: (c) => {
			const where = mutatePath(c);
			return where ? `(${shortPath(where)})` : undefined;
		},
		facts: (c) => {
			if (c.row.result?.isError) return ["failed"];
			const metrics = (c.details.metrics ?? {}) as { added_lines?: unknown };
			const stat = diffStat(num(metrics.added_lines), undefined);
			return stat ? [stat] : [];
		},
		body: (c) => {
			const diff = str(c.details.diff);
			return diff && !c.row.result?.isError ? diffPreview(diff) : undefined;
		},
	},
};

/**
 * Every edit-shaped tool shares one entry: hashline groups same-file edits from
 * one assistant message into a batch that validates every member but commits
 * once, on the last call. Earlier members reply "In batch N" with no diff, so
 * rendering all of them turns a single logical edit into a column of
 * near-identical rows — only the commit is shown.
 */
const EDIT: Spec = {
	category: "edit",
	verb: "Edit",
	glue: "",
	hidden: (c) => {
		const batch = c.details.batch as { last?: unknown } | undefined;
		return batch !== undefined && batch.last === false && !c.row.isPartial;
	},
	subject: (c) => {
		const where = mutatePath(c);
		return where ? `(${shortPath(where)})` : undefined;
	},
	facts: (c) => {
		if (c.row.result?.isError) return ["failed"];
		if (str(c.details.classification) === "noop") return ["no change"];
		const metrics = (c.details.metrics ?? {}) as { added_lines?: unknown; removed_lines?: unknown };
		const added = num(metrics.added_lines);
		const removed = num(metrics.removed_lines);
		const stat = diffStat(added, removed);
		if (stat) return [stat];
		return added !== undefined || removed !== undefined ? ["no change"] : [];
	},
	body: (c) => {
		const diff = str(c.details.diff);
		return diff && !c.row.result?.isError ? diffPreview(diff) : undefined;
	},
};

for (const name of [
	"edit", "replace", "replace_match", "insert", "apply_patch", "ast_grep_replace",
	"undo_last_change",
]) {
	REGISTRY[name] = EDIT;
}

/** Everything a row shows, from one row object. */
export function summarize(row: ToolRow): Summary {
	const args = (row.args ?? {}) as Record<string, unknown>;
	const text = resultText(row);
	const ctx: Ctx = {
		row,
		args,
		text,
		lines: countLines(text),
		path: str(args.path) ?? str(args.file_path) ?? str(args.filePath) ?? str(args.file) ?? str(args.target),
		details: (row.result?.details ?? {}) as Record<string, unknown>,
	};

	const name = row.toolName ?? "tool";
	const spec = REGISTRY[name];
	if (!spec) {
		// Unknown tool: its own name as the verb, and the first meaningful
		// scalar argument as the subject.
		const firstArg = Object.values(args).map(str).find(Boolean);
		return {
			verb: humanise(name),
			category: "other",
			subject: firstArg,
			facts: lineFacts(ctx),
		};
	}

	return {
		verb: typeof spec.verb === "function" ? spec.verb(ctx) : spec.verb,
		category: spec.category,
		subject: spec.subject?.(ctx),
		lang: typeof spec.lang === "function" ? spec.lang(ctx) : spec.lang,
		glue: spec.glue,
		facts: spec.facts?.(ctx) ?? [],
		body: spec.body?.(ctx),
		hidden: spec.hidden?.(ctx) ?? false,
		note: spec.note?.(ctx),
	};
}

export function resultText(row: ToolRow): string {
	const parts = row.result?.content;
	if (!Array.isArray(parts)) return "";
	return parts
		.filter((p) => p?.type === "text" && typeof p.text === "string")
		.map((p) => p.text as string)
		.join("\n");
}
