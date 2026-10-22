/**
 * turn — the shape of one exchange.
 *
 * One prompt, the work it caused, the answer, and a footer with what the turn
 * cost. Once the turn is done the work folds into a single summary line;
 * Ctrl+O opens it into the full tree of rows.
 */

import { ToolExecutionComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	type Patchable,
	type RenderFn,
	type ThemeLike,
	type ToolRow,
	fit,
	glyph,
	inset,
	noteText,
	paint,
	state,
} from "./style.ts";
import { summarize } from "./tools.ts";
import {
	DURATION_AFTER_MS,
	RUN_ENDS,
	RUN_STARTS,
	TIMER_AFTER_MS,
	durationLabel,
	elapsedLabel,
} from "./clock.ts";
import { GROUPED, LEAD_LINES, bullet, padVerbs } from "./row.ts";

/* ── the prompt: a `❯` quote over a full-width fill strip ──────────────── */

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

export const CARD_PATCH = Symbol.for("dr.pi.neatRender.card.v1");

export function installCard(): Patchable | undefined {
	const proto = UserMessageComponent?.prototype as unknown as Patchable | undefined;
	if (!proto || typeof proto.render !== "function" || proto[CARD_PATCH]) return undefined;
	const original = proto.render;

	proto.render = function (width: number): string[] {
		const theme = state.theme;
		if (!theme || width < 12) return original.call(this, width);
		// `text` is TS-private but a plain field at runtime.
		const text = (this as unknown as { text?: unknown }).text;
		if (typeof text !== "string" || !text.trim()) return original.call(this, width);

		// Claude Code draws the prompt as a `❯` quote over a plain full-width
		// fill strip: no borders, so no box geometry to break. The raw text is
		// wrapped and quoted directly, then each line is padded out to the
		// full width and painted. Every painted line measures exactly `width`,
		// which is all pi requires.
		const mark = noteText(theme, glyph.prompt);
		const room = Math.max(8, width - 2);
		// The `❯` opens the quote once, Claude-style: wrapped lines and later
		// paragraphs indent under it instead of repeating the marker.
		const rows: string[] = [];
		let opened = false;
		for (const para of text.replace(/\n+$/, "").split("\n")) {
			if (!para.trim()) {
				rows.push("");
				continue;
			}
			wrapTextWithAnsi(para, room).forEach((line) => {
				rows.push(opened ? `  ${line}` : `${mark} ${line}`);
				opened = true;
			});
		}
		if (rows.length === 0) return original.call(this, width);
		const out = rows.map((line) =>
			theme.bg("userMessageBg", line + " ".repeat(Math.max(0, width - visibleWidth(line)))),
		);
		// Keep the shell-integration zone pi's own render emits.
		out[0] = `${OSC133_ZONE_START}${out[0]}`;
		out[out.length - 1] = `${out[out.length - 1]}${OSC133_ZONE_END}${OSC133_ZONE_FINAL}`;
		return out;
	} as RenderFn;

	proto[CARD_PATCH] = original;
	return proto;
}

/* ── patch: one tree per run of tool calls ─────────────────────────────── */

export const GROUP_PATCH = Symbol.for("dr.pi.neatRender.group.v1");

/**
 * Container.render is a plain concat of child renders, so it is safe to
 * reimplement: pass everything through untouched except runs of adjacent
 * ToolExecutionComponents, which become one tree-connected block.
 */
export function installGrouping(): Patchable | undefined {
	const proto = Container?.prototype as unknown as Patchable | undefined;
	if (!proto || typeof proto.render !== "function" || proto[GROUP_PATCH]) return undefined;
	const original = proto.render;

	proto.render = function (width: number): string[] {
		const theme = state.theme;
		const kids = (this as { children?: unknown[] }).children;
		if (!theme || !Array.isArray(kids) || kids.length === 0) {
			return original.call(this, width);
		}
		if (!kids.some((k) => k instanceof ToolExecutionComponent)) {
			return original.call(this, width);
		}

		const out: string[] = [];
		for (let i = 0; i < kids.length; ) {
			if (!(kids[i] instanceof ToolExecutionComponent)) {
				const child = kids[i] as { render(w: number): string[] };
				out.push(...child.render(width));
				i += 1;
				continue;
			}
			// Collect the whole run. pi gives every assistant message its own
			// component, and one that is nothing but tool calls renders no
			// lines — so it must not split calls that read as one block.
			const run: ToolRow[] = [];
			let after: string[] = [];
			let end = i;
			while (end < kids.length) {
				const kid = kids[end];
				if (kid instanceof ToolExecutionComponent) {
					run.push(kid as unknown as ToolRow);
					end += 1;
					continue;
				}
				const lines = (kid as { render(w: number): string[] }).render(width);
				end += 1;
				if (lines.length > 0) {
					after = lines;
					break;
				}
			}
			out.push(...renderRun(run, theme, width), ...after);
			i = end;
		}
		return out;
	} as RenderFn;

	proto[GROUP_PATCH] = original;
	return proto;
}

/**
 * Render a run of adjacent tool calls.
 *
 * A lone call is a bulleted row; continuation lines align under its text:
 *
 *   ● Run $ grep -rniE '(api[_-]?key|secret|token)' .
 *     └ 80 lines
 *
 * Two or more calls fired together hang off one disclosure header, drawn in
 * the same grammar as a thinking block (`●` pulsing while live, `▾` once
 * done), with each call on one line and its outcome in a right-hand column:
 *
 *   ▾ 3 tool calls · 1.4s
 *   ├─ ● Read    agent/skills/pi-config-sync/SKILL.md   115 lines
 *   ├─ ● Run     $ ls -la ~/dotfiles/config/pi/           14 lines
 *   └─ ● Search  "defaultTools" in agent/settings.json    18 results
 *
 * The header only says what the rows cannot: how many, how long overall, and
 * how many failed. Calls from consecutive assistant messages group too, as
 * long as nothing visible sits between them.
 */
export function renderRun(run: ToolRow[], theme: ThemeLike, width: number): string[] {
	const render = (r: ToolRow, w: number) => (r as unknown as { render(x: number): string[] }).render(w);

	const pad = inset();

	/** One call as a bulleted row; continuation lines align under the text. */
	const bulleted = (r: ToolRow): string[] => {
		GROUPED.delete(r as unknown as object);
		// An expanded (ctrl+o) row is a frame — or pi's box — which carries its
		// own chrome. A bullet there sat alone on the box's blank first line.
		if (r.expanded) return render(r, Math.max(8, width - pad.length)).map((l) => (l ? pad + l : l));
		const lines = render(r, Math.max(8, width - pad.length - 2));
		const lead = LEAD_LINES.get(r) ?? 0;
		return lines.map((l, idx) =>
			idx < lead ? `${pad}${l}` : idx === lead ? `${pad}${bullet(r, theme)} ${l}` : `${pad}  ${l}`,
		);
	};

	// Batch members that render nothing (a commit's siblings) neither count
	// nor take a tree slot.
	const shown = run.filter((r) => {
		try {
			return !summarize(r).hidden;
		} catch {
			return true;
		}
	});
	if (shown.length < 2) {
		return run.flatMap(bulleted);
	}

	// Rows first: drawing a row is what stamps its end time, which the
	// header's total needs on the very frame the group finishes.
	const body: string[] = [];
	const branch = (s: string) => paint(theme, "rule", s);
	const verbPad = Math.max(0, ...shown.map((r) => summarize(r).verb.length));
	// Every row draws through its own render(), so the verb column is passed
	// down through the row module instead of per call.
	padVerbs(verbPad, () => {
		shown.forEach((child, idx) => {
			const last = idx === shown.length - 1;
			const fork = branch(last ? "└─ " : "├─ ");
			const trunk = branch(last ? "   " : "│  ");
			const node = child as unknown as object;
			GROUPED.add(node);
			if (child.expanded) {
				// A frame brings its own chrome; just hang it off the tree.
				render(child, Math.max(8, width - pad.length - 3)).forEach((line, li) => {
					body.push(pad + (li === 0 ? fork : trunk) + line);
				});
				return;
			}
			const lines = render(child, Math.max(8, width - pad.length - 5));
			const callLine = LEAD_LINES.get(child) ?? 0;
			lines.forEach((line, li) => {
				// A `# remark` sits above its call, on the trunk it belongs to.
				const lead =
					li < callLine
						? branch("│  ")
						: li === callLine
							? `${fork}${bullet(child, theme)} `
							: `${trunk}  `;
				body.push(pad + lead + line);
			});
		});
	});

	// ── header ──────────────────────────────────────────────────────────────
	const running = shown.some((r) => r.isPartial);
	const failures = shown.filter((r) => r.result?.isError === true).length;
	const sep = paint(theme, "fact", " · ");
	const starts = shown
		.map((r) => RUN_STARTS.get(r as unknown as object))
		.filter((s): s is number => s !== undefined);
	const first = starts.length > 0 ? Math.min(...starts) : undefined;
	let clock = "";
	if (first !== undefined) {
		if (running) {
			if (Date.now() - first >= TIMER_AFTER_MS) clock = elapsedLabel(first);
		} else {
			// Wall time of the whole group. A member with no stamps finished
			// before it was ever drawn running, so it cannot be the last one.
			const ends = shown
				.map((r) => RUN_ENDS.get(r as unknown as object))
				.filter((e): e is number => e !== undefined);
			const total = ends.length > 0 ? Math.max(...ends) - first : 0;
			if (total >= DURATION_AFTER_MS) clock = durationLabel(total);
		}
	}

	let header = `${pad}${paint(theme, "fact", glyph.open)} ${paint(theme, "fact", `${shown.length} tool calls`)}`;
	if (running) header += sep + paint(theme, "live", "running");
	if (clock) header += sep + paint(theme, "fact", clock);
	if (failures > 0) header += sep + theme.fg("error", `${failures} failed`);

	return [truncateToWidth(header, width), ...body];
}
