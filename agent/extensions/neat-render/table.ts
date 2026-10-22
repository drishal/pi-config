/**
 * table — a markdown table drawn as text, not as a grid.
 *
 * pi-tui draws every table with a full box and a rule between every row, which
 * roughly doubles its height and buries the content in borders:
 *
 *   ┌──────┬────────────────────────────────┐
 *   │ Tool │ Result                         │
 *   ├──────┼────────────────────────────────┤
 *   │ bash │ kernel 7.2.11-xanmod1          │
 *   ├──────┼────────────────────────────────┤
 *   │ find │ 4 host default.nix files       │
 *   └──────┴────────────────────────────────┘
 *
 * This keeps the header rule and drops everything else:
 *
 *   Tool    Result
 *   ──────  ────────────────────────────────
 *   bash    kernel 7.2.11-xanmod1
 *   find    4 host default.nix files
 *
 * The patch only reformats the lines pi-tui already laid out, so cell widths,
 * wrapping, alignment and colours stay exactly as the renderer computed them.
 */

import { Markdown } from "@earendil-works/pi-tui";

export const TABLE_PATCH = Symbol.for("dr.pi.neatRender.table.v1");

type RenderTable = (
	this: { theme?: MarkdownTheme },
	token: unknown,
	availableWidth: number,
	nextTokenType: string | undefined,
	styleContext: unknown,
) => string[];

type MarkdownTheme = { hr?(text: string): string; codeBlockBorder?(text: string): string };

const TOP = "┌";
const HEAD = "├";
const BOTTOM = "└";
const ROW = "│";

/**
 * Reform one rendered table. Anything that does not look like pi-tui's box
 * output — a fallback to raw markdown on a very narrow terminal — is left
 * alone.
 */
export function compactTable(lines: string[], theme: MarkdownTheme | undefined): string[] {
	if (lines.length < 3) return lines;
	const rule = (text: string) => theme?.hr?.(text) ?? theme?.codeBlockBorder?.(text) ?? text;
	const cell = (line: string) => line.slice(2, -2).replace(/ +$/, "");

	// Column widths come from the top border, so the header rule can sit under
	// each column instead of running across the gaps between them.
	const top = lines[0];
	const widths = top.startsWith(TOP) && top.endsWith("┐")
		? top.slice(2, -2).split("─┬─").map((part) => part.length)
		: undefined;
	const ruleLine = (line: string) =>
		widths ? widths.map((w) => "─".repeat(w)).join("   ") : cell(line).replace(/┼/g, "─");

	const out: string[] = [];
	let headerSeen = false;
	for (const line of lines) {
		if (line.startsWith(TOP) || line.startsWith(BOTTOM)) continue;
		if (line.startsWith(HEAD)) {
			// The rule that closes the header stays; the ones between data rows
			// are what make a table twice as tall.
			if (headerSeen) continue;
			headerSeen = true;
			if (line.endsWith("┤")) out.push(rule(ruleLine(line)));
			continue;
		}
		if (line.startsWith(`${ROW} `) && line.endsWith(` ${ROW}`)) {
			out.push(cell(line).replace(/ │ /g, "   "));
			continue;
		}
		// The blank line pi adds after a table, and anything unexpected.
		out.push(line);
	}
	return out;
}

/** Patch pi-tui's table renderer. Returns the patched prototype. */
export function installTable(): { renderTable: RenderTable; [key: symbol]: unknown } | undefined {
	const proto = (Markdown as unknown as { prototype?: { renderTable?: RenderTable } } | undefined)?.prototype;
	if (!proto || typeof proto.renderTable !== "function" || proto[TABLE_PATCH as unknown as keyof typeof proto]) {
		return undefined;
	}
	const patched = proto as unknown as { renderTable: RenderTable; [key: symbol]: unknown };
	const original = proto.renderTable;
	patched.renderTable = function (token, availableWidth, nextTokenType, styleContext) {
		const lines = original.call(this, token, availableWidth, nextTokenType, styleContext);
		try {
			return compactTable(lines, this.theme);
		} catch {
			return lines;
		}
	};
	patched[TABLE_PATCH] = original;
	return patched;
}

export function uninstallTable(patched: { renderTable: RenderTable; [key: symbol]: unknown } | undefined): void {
	if (!patched) return;
	const original = patched[TABLE_PATCH];
	if (typeof original === "function") patched.renderTable = original as RenderTable;
	delete patched[TABLE_PATCH];
}
