/**
 * style — one palette, one place.
 *
 * Every colour and glyph neat-render draws comes from here, so the transcript
 * has a single voice: the verb carries the accent, the subject stays plain,
 * facts are dim, and only a failure or a live row gets a colour of its own.
 * A row that needs a new colour should get it as a role below, not as a
 * one-off `theme.fg("success")` somewhere in a renderer.
 */

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
export type Patchable = { render: RenderFn; [key: symbol]: unknown };

/** Shared across the three patches; filled in on session_start. */
export const state: { theme?: ThemeLike } = {};

export const off = (name: string) => process.env[name] === "0";
/** For knobs that default off, so absent means off rather than on. */
export const on = (name: string) => process.env[name] === "1";

/**
 * pi renders message content with an output pad of 1, so tool rows have to
 * start at the same column or the transcript reads as two ragged columns.
 */
export function inset(): string {
	const n = Number(process.env.NEAT_RENDER_INSET ?? "1");
	return " ".repeat(Number.isFinite(n) && n >= 0 ? Math.min(8, n) : 1);
}

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
	let out = p.startsWith(cwd) ? p.slice(cwd.length).replace(/^\/+/, "") : p;
	const home = process.env.HOME;
	if (home && out.startsWith(home)) out = `~${out.slice(home.length)}`;
	const segs = out.split("/");
	return segs.length > 4 ? `…/${segs.slice(-3).join("/")}` : out;
}

export function oneLine(s: string, max: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
