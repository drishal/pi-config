/**
 * row — one tool call, drawn.
 *
 * A finished call is the call plus its outcome; a group of calls fired
 * together hangs off the tree connectors in `renderRun`, and Ctrl+O opens one
 * call as an omp-style frame. Nothing here decides *whether* a row is shown —
 * that is the turn's job.
 */

import { ToolExecutionComponent, highlightCode } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	type Patchable,
	type RenderFn,
	type ThemeLike,
	type ToolRow,
	inset,
	off,
	oneLine,
	state,
	str,
} from "./style.ts";
import { summarize } from "./tools.ts";
import {
	DURATION_AFTER_MS,
	RUN_ENDS,
	RUN_STARTS,
	TIMER_AFTER_MS,
	TIMER_TICK_MS,
	armPulse,
	durationLabel,
	elapsedLabel,
	pulseOn,
	timedRows,
	tookMs,
} from "./clock.ts";

export const ROW_PATCH = Symbol.for("dr.pi.neatRender.row.v1");
/** Max continuation lines a running command's detail may wrap onto. */
export const WRAP_LINES = 3;

/**
 * Word-wrap to `width`, hard-splitting any single token longer than a line
 * (paths and one-liner pipelines routinely are). Stops after `max` lines and
 * marks the cut, so a giant command cannot push the transcript off-screen.
 */
export function wrapTo(text: string, width: number, max: number): string[] {
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
		out[out.length - 1] = `${last.slice(0, Math.max(0, width - 1))}…`;
	}
	return out;
}

/**
 * Render one tool row.
 *
 * Claude Code shows a finished call as the call plus its outcome on an
 * indented `└` continuation:
 *
 *   ● Bash $ ls ~/.pi/agent/extensions/
 *     └ exit 0 · 11 lines
 *
 * A *running* call instead puts the whole command on `└ $`, wrapped rather
 * than truncated, so you can actually read what is executing:
 *
 *   ● Bash · running… · 4s
 *     └ $ cd ~/.pi && cat .gitignore && echo "═══ SIZES ═══"
 *       && find . -type f -newer agent/settings.json | head -5 …
 *
 * Inside a parallel group (see renderRun) a finished call keeps its outcome
 * on the call line instead — the tree connectors already give the rows their
 * structure, and a `└` outcome would collide with the tree's own `└`:
 *
 *   ├─ ● Read agent/skills/pi-config-sync/SKILL.md · 115 lines
 *
 * Both callers already indent continuation lines (renderRun pads a lone
 * call by two columns and a group child by its `│  `/`   ` lead), so extra
 * lines nest correctly with no layout work here.
 *
 * NEAT_RENDER_SPLIT=0 keeps the old single-line form.
 */
/** Lines a row puts above its call line (the `# remark`), per row. */
export const LEAD_LINES = new WeakMap<ToolRow, number>();
/** Rows renderRun is currently drawing as a parallel-group child. */
export const GROUPED = new WeakSet<object>();

export function rowLines(row: ToolRow, theme: ThemeLike, width: number, start?: number, took?: number): string[] {
	const { label, detail, facts, glue, body: extra, hidden, note } = summarize(row);
	// Elapsed time on a call that has been running for a while.
	const timerText =
		!off("NEAT_RENDER_TIMER") && row.isPartial && start !== undefined && Date.now() - start >= TIMER_AFTER_MS
			? elapsedLabel(start)
			: "";
	if (hidden) return [];
	// How long a finished call took, unless the tool already reported it.
	if (!off("NEAT_RENDER_TIMER") && took !== undefined && took >= DURATION_AFTER_MS && !facts.some((f) => /^\d[\dm.]*s$/.test(f))) {
		facts.push(durationLabel(took));
	}
	const sep = theme.fg("dim", " · ");
	const failed = row.result?.isError === true;
	const split = !off("NEAT_RENDER_SPLIT");
	const inline = !split || GROUPED.has(row as object);
	const join = glue ?? " ";

	// pi hard-errors if any rendered line exceeds the width it handed us, so
	// every return below goes through this. Sizing alone is not enough: the
	// label is a tool name of unknown length (`pi_lens_activate_tools` is 22
	// columns), so budgeting the detail against a constant overflows on the
	// long ones.
	const fit = (s: string) => (visibleWidth(s) > width ? truncateToWidth(s, width) : s);

	const running = row.isPartial === true;
	// The model's remark reads first, like a comment above a shell command.
	// It sits in the bullet column (see renderRun), so it heads the call below
	// it instead of trailing the previous row's result.
	const noteLine = note && split
		? (() => {
				const dim = theme.fg("dim", `# ${oneLine(note, Math.max(8, width))}`);
				return [fit(theme.italic ? theme.italic(dim) : dim)];
			})()
		: [];
	LEAD_LINES.set(row, noteLine.length);

	// Running, split mode: the command moves to its own wrapped `└ $` block,
	// so the header carries only the label and status.
	if (running && split && detail) {
		const status = theme.fg("muted", "running…") + (timerText ? `${sep}${theme.fg("dim", timerText)}` : "");
		const header = fit(`${theme.bold(theme.fg("toolTitle", label))}${sep}${status}`);
		// "└ " then the detail; continuation lines align under the detail.
		const lead = theme.fg("dim", "└ ");
		const body = wrapTo(detail, Math.max(8, width - 2), WRAP_LINES);
		return [
			...noteLine,
			header,
			...body.map((l, i) =>
				fit((i === 0 ? lead : "  ") + theme.fg("syntaxVariable", l)),
			),
		];
	}

	// Whatever still lands on the call line has to be budgeted for before the
	// detail is truncated, or the ellipsis eats the status instead of the path.
	const reserve = running
		? visibleWidth(sep) + visibleWidth("running…") + (timerText ? visibleWidth(sep) + visibleWidth(timerText) : 0)
		: inline
			? Math.min(40, facts.reduce((n, f) => n + visibleWidth(sep) + visibleWidth(f), 0))
			: 0;

	let head = theme.bold(theme.fg("toolTitle", label));
	if (detail) {
		// Measure what the label actually took, then give the rest to detail,
		// reserving the joiner's own width.
		const used = visibleWidth(head) + visibleWidth(join);
		head += `${join}${theme.fg("syntaxVariable", oneLine(detail, Math.max(8, width - used - reserve)))}`;
	}

	// A still-running call has no outcome yet; keep it on one line.
	if (running) {
		let line = `${head}${sep}${theme.fg("muted", "running…")}`;
		if (timerText) line += `${sep}${theme.fg("dim", timerText)}`;
		return [fit(line)];
	}

	const paint = (f: string) =>
		theme.fg(failed || /^(failed|exit [1-9])/.test(f) ? "error" : "success", f);

	if (!split) {
		let out = head;
		for (const f of facts) out += sep + paint(f);
		return [fit(out)];
	}

	const out = [...noteLine];
	if (inline) {
		out.push(fit(head + facts.map((f) => sep + paint(f)).join("")));
	} else {
		out.push(fit(head));
		if (facts.length > 0) out.push(fit(theme.fg("dim", "└ ") + facts.map(paint).join(sep)));
	}
	// Diff rows sit under the stat line, indented past the `└ ` and coloured
	// by their marker so an edit reads as a diff rather than a paragraph.
	for (const line of extra ?? []) {
		const slot = theme.fg(
			line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "dim",
			line,
		);
		out.push(fit(`  ${slot}`));
	}
	return out;
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

export const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
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
			out.push((i === 0 && j === 0 ? theme.fg("dim", "$ ") : "  ") + part);
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
 * "self"), leaving that one to pi. NEAT_RENDER_FRAME=0 restores pi's box.
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
		call = cmd && !off("NEAT_RENDER_HIGHLIGHT")
			? highlightedCommand(cmd, theme, inner)
			: trimBlank(first.render(inner));
		output = trimBlank(rest.flatMap((k) => k.render(inner)));
	} else {
		// No renderer at all: pi formats the whole call as one text block.
		const text = c.formatToolExecution?.();
		if (!text) return undefined;
		call = [];
		output = trimBlank(text.split("\n"));
	}

	// omp's state colours: quiet when done, accent while running, red on failure.
	const tone = row.isPartial ? "accent" : row.result?.isError ? "error" : "dim";
	const g = (s: string) => theme.fg(tone, s);
	const fit = (s: string) => (visibleWidth(s) > inner ? truncateToWidth(s, inner) : s);
	const boxed = (line: string) => {
		const t = fit(line);
		return `${g("│")} ${t}${" ".repeat(Math.max(0, inner - visibleWidth(t)))} ${g("│")}`;
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
	out.push(status.length > 0 ? labelled("╰", status.join(" · "), "╯", tone) : g(`╰${"─".repeat(width - 2)}╯`));

	// Images keep pi's own layout, below the frame.
	const images = c.imageComponents ?? [];
	images.forEach((img, i) => {
		const spacer = c.imageSpacers?.[i];
		if (spacer) out.push(...spacer.render(width));
		out.push(...img.render(width));
	});
	return out;
}

/* ── patch 2: compact tool rows ────────────────────────────────────────── */

export function installRows(): Patchable | undefined {
	const proto = ToolExecutionComponent?.prototype as unknown as Patchable | undefined;
	if (!proto || typeof proto.render !== "function" || proto[ROW_PATCH]) return undefined;
	const original = proto.render;
	const frame = !off("NEAT_RENDER_FRAME");

	proto.render = function (width: number): string[] {
		const theme = state.theme;
		const row = this as unknown as ToolRow;
		if (!theme) return original.call(this, width);
		if (row.expanded) {
			if (frame) {
				try {
					const framed = framedLines(this, row, theme, width);
					if (framed) return framed;
				} catch {
					// fall through to pi's own expanded view
				}
			}
			return original.call(this, width);
		}
		// Stamp the call while it is in flight, and keep the repaint chain
		// alive for the timer even when pulse is off.
		let start: number | undefined;
		if (row.isPartial) {
			start = RUN_STARTS.get(this as object) ?? Date.now();
			RUN_STARTS.set(this as object, start);
			armPulse(this);
			if (!off("NEAT_RENDER_TIMER") && Date.now() - start >= TIMER_AFTER_MS && timedRows.add(this as object)) {
				// The timer must tick even with pulse off; armPulse no-ops then.
			const timer = setTimeout(() => {
				try {
					(this as unknown as { invalidate?(): void }).invalidate?.();
				} catch {
					/* component torn down mid-flight */
				}
			}, TIMER_TICK_MS);
			(timer as { unref?: () => void }).unref?.();
			}
		} else if (RUN_STARTS.has(this as object) && !RUN_ENDS.has(this as object)) {
			// First finished render of a call we saw running: its end time.
			RUN_ENDS.set(this as object, Date.now());
		}
		try {
			return rowLines(row, theme, width, start, tookMs(this as object));
		} catch {
			return original.call(this, width);
		}
	} as RenderFn;

	proto[ROW_PATCH] = original;
	return proto;
}
