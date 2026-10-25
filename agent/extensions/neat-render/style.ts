/**
 * style — one palette, one place.
 *
 * Every colour and glyph neat-render draws comes from here, so the transcript
 * has a single voice: the verb carries the accent, the subject stays plain,
 * facts are dim, and only a failure or a live row gets a colour of its own.
 * A row that needs a new colour gets it as a role below, not as a one-off
 * `theme.fg("success")` somewhere in a renderer.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type ThemeLike = {
	fg(slot: string, text: string): string;
	bg(slot: string, text: string): string;
	bold(text: string): string;
	italic?(text: string): string;
};

export type ToolRow = {
	toolName?: string;
	args?: Record<string, unknown>;
	expanded?: boolean;
	isPartial?: boolean;
	result?: {
		isError?: boolean;
		content?: Array<{ type?: string; text?: string }>;
		details?: Record<string, unknown>;
	};
};

export type RenderFn = (this: unknown, width: number) => string[];
export type Patchable = {
	render: RenderFn;
	invalidate?: (this: unknown) => void;
	[key: symbol]: unknown;
};

/** Shared across the patches; filled in on session_start. */
export const state: {
	theme?: ThemeLike;
	/**
	 * pi's screen, taken from the first tool row it renders. Renderers repaint
	 * on request only, so a running timer or a click has to ask.
	 */
	renderer?: { requestRender?(): void };
} = {};

/**
 * The one row the pointer is over. A single value, because a pointer is over
 * one row at a time; row.ts reads it to light the row's marker.
 */
let hoveredRow: object | undefined;

/** Mark a row as hovered; returns true when the hovered row changed. */
export function setHovered(row: object | undefined): boolean {
	if (hoveredRow === row) return false;
	hoveredRow = row;
	return true;
}

export const isHovered = (row: object): boolean => hoveredRow === row;

export const off = (name: string) => process.env[name] === "0";

/**
 * pi renders message content with an output pad of 1, so tool rows have to
 * start at the same column or the transcript reads as two ragged columns.
 */
export function inset(): string {
	const n = Number(process.env.NEAT_RENDER_INSET ?? "1");
	return " ".repeat(Number.isFinite(n) && n >= 0 ? Math.min(8, n) : 1);
}

/**
 * The palette: one role per meaning, and the theme slot it paints with.
 *
 * Success is deliberately absent — a finished call is the normal case and
 * needs no colour at all. `live` and `fail` are the only states that shout.
 */
export const role = {
	/** The tool's verb: Read, Search, Run. */
	verb: "accent",
	/** What the call acted on: a path, a command, a query. */
	subject: "text",
	/** Counts, durations, outcomes. */
	fact: "dim",
	/** A dim aside, like a bash command's leading comment. */
	note: "dim",
	/** Something still running. */
	live: "warning",
	/** Something that went wrong. */
	fail: "error",
	/** Tree connectors and rules. */
	rule: "borderMuted",
	/** The final answer's bullet. */
	answer: "accent",
	/** Reasoning, and the chrome around it. */
	thought: "thinkingText",
	/** The turn footer: model, time, cost. */
	meta: "dim",
	/** A neutral marker: a finished call's bullet, a quiet glyph. */
	mark: "dim",
	/** A frame's section label, e.g. Output inside an expanded call. */
	frame: "toolTitle",
	/** Diff rows under an edit. */
	diffAdded: "toolDiffAdded",
	diffRemoved: "toolDiffRemoved",
	diffContext: "toolDiffContext",
} as const;

/** One-column glyphs, so a glyph never shifts a row. */
export const glyph = {
	prompt: "❯",
	bullet: "●",
	/** The hollow half of the running blink. */
	bulletOpen: "○",
	open: "▾",
	shut: "▸",
	bar: "│",
	cut: "…",
	thought: "◇",
	/** The filled half of the thinking blink. */
	thoughtFilled: "◆",
} as const;

export function paint(t: ThemeLike, slot: keyof typeof role, text: string): string {
	return t.fg(role[slot], text);
}

export const verbText = (t: ThemeLike, text: string) => t.bold(paint(t, "verb", text));
export const subjectText = (t: ThemeLike, text: string) => paint(t, "subject", text);
export const factText = (t: ThemeLike, text: string) => paint(t, "fact", text);
export const liveText = (t: ThemeLike, text: string) => paint(t, "live", text);
export const failText = (t: ThemeLike, text: string) => paint(t, "fail", text);
export const noteText = (t: ThemeLike, text: string) => paint(t, "note", text);
export const markText = (t: ThemeLike, text: string) => paint(t, "mark", text);

/** A horizontal rule of exactly `width` columns. */
export const ruleText = (t: ThemeLike, width: number) =>
	paint(t, "rule", "─".repeat(Math.max(0, width)));

/** pi hard-errors if a rendered line is wider than the width it handed us. */
export const fit = (text: string, width: number) =>
	visibleWidth(text) > width ? truncateToWidth(text, width) : text;

/** "1 line", "12 lines". */
export function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function countLines(text: string): number {
	const trimmed = text.replace(/\n+$/, "");
	return trimmed ? trimmed.split("\n").length : 0;
}

export function str(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Collapse a path to something readable without losing the tail. */
export function shortPath(p: string, cwd = process.cwd()): string {
	// A path boundary, not a bare prefix: `/repo2` is not inside `/repo`.
	const inside = (path: string, root: string) =>
		path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
	let out = inside(p, cwd) ? p.slice(cwd.length).replace(/^\/+/, "") : p;
	const home = process.env.HOME;
	if (home && inside(out, home)) out = `~${out.slice(home.length)}`;
	const segs = out.split("/");
	return segs.length > 4 ? `…/${segs.slice(-3).join("/")}` : out;
}

export function oneLine(s: string, max: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return visibleWidth(flat) > max ? truncateToWidth(flat, max, glyph.cut) : flat;
}

/**
 * Whether two memo keys still describe the same inputs. Keys hold object
 * references (an args or result object, a theme, a children array) beside
 * primitives, so identity is the right comparison.
 */
export function sameKey(a: readonly unknown[], b: readonly unknown[]): boolean {
	return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}
