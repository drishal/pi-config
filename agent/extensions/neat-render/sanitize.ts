/**
 * Tool output is text, but it is not always *safe* text: a bash command or an
 * MCP server can return cursor moves, screen erases, hyperlinks, or a whole
 * DCS/APC string. Drawn into a row, those move the terminal's cursor and tear
 * the frame, and an untouched one can even leak into the next repaint.
 *
 * SGR colour is the one class worth keeping — some tools colour their own
 * output and the row should show it. Everything else addresses the terminal
 * rather than saying anything, and is dropped before the row is measured.
 */

/** A select-graphic-rendition run: `\x1b[0m`, `\x1b[1;31m`. */
const SGR_RUN = /\x1b\[[0-9;]*m/g;

/** Private-use pair that parks a kept SGR run while the rest is stripped. */
const PARKED = /\uE000(\d+)\uE001/g;
const MARK = /[\uE000\uE001]/g;

/** OSC, DCS, APC, PM and SOS strings, then any remaining escape sequence. */
const ESCAPES =
	/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c)|(?:\x1b[PX^_]|\x90)[\s\S]*?(?:\x1b\\|\x9c)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]/g;

/** C0 controls other than tab and newline, plus the whole C1 range. */
const CONTROLS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

export function plainText(value: string): string {
	const kept: string[] = [];
	const guarded = value
		.replace(MARK, "")
		.replace(SGR_RUN, (seq) => `\uE000${kept.push(seq) - 1}\uE001`);
	const cleaned = guarded
		.replace(ESCAPES, "")
		.replace(CONTROLS, "")
		.replace(/\r\n?/g, "\n");
	return cleaned.replace(PARKED, (_match, index: string) => kept[Number(index)] ?? "");
}
