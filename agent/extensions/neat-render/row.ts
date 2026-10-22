/**
 * row — one tool call, drawn.
 *
 * A finished call is the call plus its outcome; a group of calls fired
 * together hangs off the tree connectors in turn.ts; Ctrl+O opens one call as
 * an omp-style frame. Nothing here decides *whether* a row is shown — that is
 * the turn's job.
 */

import { ToolExecutionComponent, highlightCode } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	type Patchable,
	type RenderFn,
	type ThemeLike,
	type ToolRow,
	factText,
	failText,
	fit,
	glyph,
	liveText,
	noteText,
	oneLine,
	state,
	str,
	subjectText,
	verbText,
} from "./style.ts";
import { summarize } from "./tools.ts";
import {
	DURATION_AFTER_MS,
	RUN_ENDS,
	RUN_STARTS,
	TIMER_AFTER_MS,
	durationLabel,
	elapsedLabel,
	pulseOn,
	watch,
	tookMs,
} from "./clock.ts";

/** Max continuation lines a running command's detail may wrap onto. */
export const WRAP_LINES = 3;

/** Lines a row puts above its call line (the `# remark`), per row. */
export const LEAD_LINES = new WeakMap<ToolRow, number>();
/** Rows the turn renderer is currently drawing as a tree child. */
export const GROUPED = new WeakSet<object>();

/** Verb column width of the tree being drawn right now; 0 outside a tree. */
let treeVerbWidth = 0;

/** Draw rows with every verb padded to one column, so subjects line up. */
export function padVerbs<T>(n: number, fn: () => T): T {
	const prev = treeVerbWidth;
	treeVerbWidth = n;
	try {
		return fn();
	} finally {
		treeVerbWidth = prev;
	}
}

/**
 * Word-wrap to `width`, hard-splitting any single token longer than a line
 * (paths and one-liner pipelines routinely are). Stops after `max` lines and
 * marks the cut, so a giant command cannot push the transcript off-screen.
 */
function wrapTo(text: string, width: number, max: number): string[] {
	const flat = text.replace(/\s+/g, " ").trim();
	if (width < 4) return [flat.slice(0, Math.max(1, width))];
	const out: string[] = [];
	let rest = flat;
	while (rest.length > 0 && out.length < max) {
		if (rest.length <= width) {
			out.push(rest);
			rest = "";
			break;
		}
		// Break at the last space that fits; fall back to a hard cut.
		let cut = rest.lastIndexOf(" ", width);
		if (cut <= 0) cut = width;
		out.push(rest.slice(0, cut));
		rest = rest.slice(cut).trimStart();
	}
	if (rest.length > 0 && out.length > 0) {
		const last = out[out.length - 1];
		out[out.length - 1] = `${last.slice(0, Math.max(0, width - 1))}${glyph.cut}`;
	}
	return out;
}

export type RowOpts = {
	/** When the call started running, for the elapsed timer. */
	start?: number;
	/** How long the call took, when both ends were seen. */
	took?: number;
	/** Pad verbs to this width so subjects line up down a group. */
	verbPad?: number;
	/** Draw as a tree child: facts stay on the call line. */
	tree?: boolean;
	/** Column facts should end at, when there is room. */
	align?: number;
};

/**
 * Render one tool row.
 *
 * Claude Code shows a finished call as the call plus its outcome on an
 * indented `└` continuation:
 *
 *   ● Read ~/.pi/agent/AGENTS.md:1-12
 *     └ 12 lines
 *
 * A *running* call instead puts the whole command on `└ $`, wrapped rather
 * than truncated, so you can actually read what is executing:
 *
 *   ● Run · running… · 4s
 *     └ $ cd ~/.pi && cat .gitignore && echo "═══ SIZES ═══"
 *       && find . -type f -newer agent/settings.json | head -5 …
 *
 * Inside the turn tree a finished call keeps its outcome on the call line
 * instead — the tree connectors already give the rows their structure, and a
 * `└` outcome would collide with the tree's own `└`.
 */
export function rowLines(row: ToolRow, theme: ThemeLike, width: number, opts: RowOpts = {}): string[] {
	const { start, took, verbPad, tree, align } = opts;
	const summary = summarize(row);
	const { subject, facts, glue, body: extra, hidden, note } = summary;
	if (hidden) return [];

	const live = (text: string) => liveText(theme, text);
	// Elapsed time on a call that has been running for a while.
	const timerText =
		row.isPartial && start !== undefined && Date.now() - start >= TIMER_AFTER_MS
			? elapsedLabel(start)
			: "";
	// How long a finished call took, unless the tool already reported it.
	if (took !== undefined && took >= DURATION_AFTER_MS && !facts.some((f) => /^\d[\dm.]*s$/.test(f))) {
		facts.push(durationLabel(took));
	}

	const sep = factText(theme, " · ");
	const join = glue ?? " ";
	const running = row.isPartial === true;

	// The model's remark reads first, like a comment above a shell command.
	// It sits in the bullet column (see the turn renderer), so it heads the
	// call below it instead of trailing the previous row's result.
	const remark = note ? noteText(theme, `# ${oneLine(note, Math.max(8, width))}`) : "";
	const noteLine = remark ? [fit(theme.italic ? theme.italic(remark) : remark, width)] : [];
	LEAD_LINES.set(row, noteLine.length);

	// Verbs are padded to the widest verb in the group so subjects line up.
	const verbWidth = Math.max(visibleWidth(summary.verb), verbPad ?? treeVerbWidth);
	const verb = verbText(theme, summary.verb.padEnd(verbWidth));

	// Running: the command moves to its own wrapped `└ $` block, so the
	// header carries only the verb and the status. Inside a tree the row is
	// already hanging off a connector, so the command stays on the call line.
	if (running && subject && !tree) {
		const status = live("running…") + (timerText ? `${sep}${factText(theme, timerText)}` : "");
		const header = fit(`${verb}${sep}${status}`, width);
		const lead = factText(theme, "└ ");
		const lines = wrapTo(subject, Math.max(8, width - 2), WRAP_LINES);
		return [
			...noteLine,
			header,
			...lines.map((l, i) => fit((i === 0 ? lead : "  ") + subjectText(theme, l), width)),
		];
	}

	// Whatever still lands on the call line has to be budgeted for before the
	// subject is truncated, or the ellipsis eats the status instead of the path.
	const factsWidth = facts.reduce((n, f) => n + visibleWidth(sep) + visibleWidth(f), 0);
	const reserve = running
		? visibleWidth(sep) + visibleWidth("running…") + (timerText ? visibleWidth(sep) + visibleWidth(timerText) : 0)
		: tree
			? Math.min(40, factsWidth + 2)
			: 0;

	let head = verb;
	if (subject) {
		const used = visibleWidth(head) + visibleWidth(join);
		head += `${join}${subjectText(theme, oneLine(subject, Math.max(8, width - used - reserve)))}`;
	}

	if (running) {
		let line = `${head}${sep}${live("running…")}`;
		if (timerText) line += `${sep}${factText(theme, timerText)}`;
		return [...noteLine, fit(line, width)];
	}

	// Only the fact that names the failure is red; a line count stays quiet.
	const paint = (fact: string) =>
		/^(failed|exit [1-9])/.test(fact) ? failText(theme, fact) : factText(theme, fact);

	if (tree) {
		// Facts close the call line. Right-align them when the row is wide
		// enough that the gap reads as a column; otherwise keep them adjacent.
		const factsText = facts.map(paint).join(sep);
		const left = visibleWidth(head);
		const right = visibleWidth(factsText);
		const end = align ?? width;
		if (facts.length === 0) {
			noteLine.push(fit(head, width));
		} else if (left + 2 + right <= end) {
			noteLine.push(fit(head + " ".repeat(end - right - left) + factsText, width));
		} else {
			noteLine.push(fit(`${head}${sep}${factsText}`, width));
		}
		return noteLine;
	}

	noteLine.push(fit(head, width));
	if (facts.length > 0) noteLine.push(fit(factText(theme, "└ ") + facts.map(paint).join(sep), width));
	// Diff rows sit under the stat line, indented past the `└ ` and coloured
	// by their marker so an edit reads as a diff rather than a paragraph.
	for (const line of extra ?? []) {
		const slot = theme.fg(
			line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "dim",
			line,
		);
		noteLine.push(fit(`  ${slot}`, width));
	}
	return noteLine;
}

/* ── the bullet ────────────────────────────────────────────────────────── */

/**
 * A call's bullet: dim when done, red on failure, pulsing while live. Success
 * is the default and needs no colour of its own.
 */
export function bullet(row: ToolRow, theme: ThemeLike): string {
	if (row.isPartial) {
		return theme.fg(pulseOn() ? "warning" : "dim", glyph.bullet);
	}
	return theme.fg(row.result?.isError ? "error" : "dim", glyph.bullet);
}

/* ── expanded rows: framed, omp-style ──────────────────────────────────── */

export type Renderable = { render(width: number): string[] };
/** The parts of pi's ToolExecutionComponent the frame is built from. */
export type ToolInternals = {
	contentBox?: { children?: Renderable[] };
	imageComponents?: Renderable[];
	imageSpacers?: Renderable[];
	hasRendererDefinition?(): boolean;
	getRenderShell?(): string;
	formatToolExecution?(): string;
};

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
export const isBlank = (line: string) => line.replace(ANSI_RE, "").trim() === "";

/** Drop the blank padding lines renderers put above and below their text. */
export function trimBlank(lines: string[]): string[] {
	let a = 0;
	let b = lines.length;
	while (a < b && isBlank(lines[a])) a++;
	while (b > a && isBlank(lines[b - 1])) b--;
	return lines.slice(a, b);
}

/**
 * Make each highlighted line carry its own colour.
 *
 * highlightCode colours a token once and splits into lines afterwards, so a
 * token spanning lines — a quoted `node -e '…'` script, a heredoc — opens its
 * colour on the first line and closes it on the last, leaving the lines in
 * between uncoloured once each is drawn on its own. Re-open the colour at the
 * start of each continued line and close it at the end, so every framed line
 * is self-contained (and the border after it keeps its own colour).
 */
export function carryColour(lines: string[]): string[] {
	let open = "";
	return lines.map((line) => {
		const full = open + line;
		open = "";
		for (const m of full.matchAll(/\x1b\[([0-9;]*)m/g)) {
			const code = m[1];
			if (code === "" || code === "0" || code === "39") open = "";
			else if (/^(38;|3[0-7]$|9[0-7]$)/.test(code)) open = m[0];
		}
		return open ? `${full}\x1b[39m` : full;
	});
}

/**
 * A bash command for the expanded frame: `$ ` then the command syntax-
 * highlighted as bash with pi's own highlighter (the theme's syntax* colours,
 * the same as Markdown code blocks). Continuation lines — heredoc bodies,
 * `\`-continued lines, wrapped long lines — indent under the command.
 * pi's bash renderCall draws the whole command in one colour.
 */
export function highlightedCommand(cmd: string, theme: ThemeLike, width: number): string[] {
	let lines: string[];
	try {
		lines = carryColour(highlightCode(cmd, "bash"));
	} catch {
		lines = cmd.split("\n");
	}
	const room = Math.max(8, width - 2);
	const out: string[] = [];
	lines.forEach((line, i) => {
		wrapTextWithAnsi(line, room).forEach((part, j) => {
			out.push((i === 0 && j === 0 ? factText(theme, "$ ") : "  ") + part);
		});
	});
	return out;
}

/**
 * Ctrl+O view of one tool call, framed the way omp draws it:
 *
 *   ╭──────────────────────────────────────────────╮
 *   │ $ strings -n 4 ~/.local/bin/omp | sed -n '…' │
 *   ├─── Output ───────────────────────────────────┤
 *   │   type: "input_text",                        │
 *   ╰─── 40 lines ─────────────────────────────────╯
 *
 * Border colours follow omp's output-block states: dim when done, accent
 * while running, error on failure.
 *
 * pi's own expanded view puts the same content in a tinted box padded by a
 * blank line on every side, and the row bullet landed on that blank line,
 * alone. Here the call and result come straight from the children of pi's
 * content box — the tool's own renderCall/renderResult output, so diffs and
 * syntax colours survive — minus the tint. Images are drawn after the frame
 * rather than inside it, so terminal graphics are not clipped by borders.
 *
 * Returns undefined when the tool draws its own framing (render shell
 * "self"), leaving that one to pi.
 */
export function framedLines(comp: unknown, row: ToolRow, theme: ThemeLike, width: number): string[] | undefined {
	const c = comp as ToolInternals;
	const inner = width - 4; // "│ " + text + " │"
	if (inner < 12) return undefined;

	let call: string[];
	let output: string[];
	if (c.hasRendererDefinition?.()) {
		if (c.getRenderShell?.() === "self") return undefined;
		const kids = c.contentBox?.children ?? [];
		if (kids.length === 0) return undefined;
		const [first, ...rest] = kids;
		const cmd = row.toolName === "bash" ? (str(row.args?.command) ?? str(row.args?.cmd)) : undefined;
		call = cmd ? highlightedCommand(cmd, theme, inner) : trimBlank(first.render(inner));
		output = trimBlank(rest.flatMap((k) => k.render(inner)));
	} else {
		// No renderer at all: pi formats the whole call as one text block.
		const text = c.formatToolExecution?.();
		if (!text) return undefined;
		call = [];
		output = trimBlank(text.split("\n"));
	}

	const borderSlot = row.isPartial ? "live" : row.result?.isError ? "fail" : "rule";
	const g = (s: string) => (borderSlot === "rule" ? theme.fg("dim", s) : theme.fg(borderSlot === "live" ? "warning" : "error", s));
	const boxed = (line: string) => {
		const t = visibleWidth(line) > inner ? truncateToWidth(line, inner) : line;
		return `${g(glyph.bar)} ${t}${" ".repeat(Math.max(0, inner - visibleWidth(t)))} ${g(glyph.bar)}`;
	};
	/** A border with a label set into it after a 3-dash cap, as omp draws it:
	 *  `├─── Output ───┤`. Fill = width - (corner + cap) - label - corner. */
	const labelled = (left: string, label: string, right: string, color: string) => {
		const l = truncateToWidth(` ${label} `, Math.max(0, width - 5));
		return g(`${left}───`) + theme.fg(color, l) + g("─".repeat(Math.max(0, width - 5 - visibleWidth(l)))) + g(right);
	};

	const out = ["", g(`╭${"─".repeat(width - 2)}╮`)];
	out.push(...call.map(boxed));
	if (output.length > 0) {
		if (call.length > 0) out.push(labelled("├", "Output", "┤", "toolTitle"));
		out.push(...output.map(boxed));
	}
	const { facts } = summarize(row);
	const start = comp && typeof comp === "object" ? RUN_STARTS.get(comp as object) : undefined;
	const status = row.isPartial
		? start !== undefined && Date.now() - start >= TIMER_AFTER_MS
			? ["running…", elapsedLabel(start)]
			: ["running…"]
		: facts;
	out.push(status.length > 0 ? labelled("╰", status.join(" · "), "╯", borderSlot === "rule" ? "dim" : "error") : g(`╰${"─".repeat(width - 2)}╯`));

	// Images keep pi's own layout, below the frame.
	const images = c.imageComponents ?? [];
	images.forEach((img, i) => {
		const spacer = c.imageSpacers?.[i];
		if (spacer) out.push(...spacer.render(width));
		out.push(...img.render(width));
	});
	return out;
}

/* ── patch: compact tool rows ──────────────────────────────────────────── */

export const ROW_PATCH = Symbol.for("dr.pi.neatRender.row.v1");

export function installRows(): Patchable | undefined {
	const proto = ToolExecutionComponent?.prototype as unknown as Patchable | undefined;
	if (!proto || typeof proto.render !== "function" || proto[ROW_PATCH]) return undefined;
	const original = proto.render;

	proto.render = function (width: number): string[] {
		const theme = state.theme;
		const row = this as unknown as ToolRow;
		if (!theme) return original.call(this, width);
		if (row.expanded) {
			try {
				const framed = framedLines(this, row, theme, width);
				if (framed) return framed;
			} catch {
				// fall through to pi's own expanded view
			}
			return original.call(this, width);
		}
		// Stamp the call while it is in flight; the clock keeps it repainting.
		let start: number | undefined;
		if (row.isPartial) {
			start = RUN_STARTS.get(this as object) ?? Date.now();
			RUN_STARTS.set(this as object, start);
			// Keep the row repainting while it runs; the clock drops it once it stops.
			watch(this as object);
		} else if (RUN_STARTS.has(this as object) && !RUN_ENDS.has(this as object)) {
			// First finished render of a call we saw running: its end time.
			RUN_ENDS.set(this as object, Date.now());
		}
		try {
			return rowLines(row, theme, width, {
				start,
				took: tookMs(this as object),
				tree: GROUPED.has(row as object),
				align: width,
			});
		} catch {
			return original.call(this, width);
		}
	} as RenderFn;

	proto[ROW_PATCH] = original;
	return proto;
}
