/**
 * neat-render — compact, Claude-Code-shaped transcript chrome for pi.
 *
 * One turn:
 *
 *   ❯ In a batch, launch a few read/grep commands.
 *
 *   Let me check how pi loads extensions…
 *   ▾ 3 tool calls · 1.4s
 *   ├─ ● Read    agent/extensions/eval/index.ts   48 lines
 *   ├─ ● Run     $ ls ~/.pi/agent/extensions        12 lines
 *   └─ ● Search  "index.ts" in agent/extensions     4 results
 *
 *   └─ Thinking 2.1s ~140 tokens
 *      A directory extension is loaded through its index.ts, so the entry
 *      point is the thing to read.
 *
 *   ● Pi loads a directory extension from its index.ts.
 *
 * Nothing folds: a call is a row, a run of calls is a tree, and the reasoning
 * hangs under its own label. pi's Ctrl+O still opens every call at full size,
 * and its Ctrl+T still decides whether reasoning is shown.
 *
 * ── Files ─────────────────────────────────────────────────────────────────
 * style.ts palette and glyphs · tools.ts the per-tool registry · row.ts one
 * call · turn.ts prompt, spacing and the answer · thinking.ts reasoning lines
 * · table.ts compact markdown tables · clock.ts the shared ticker.
 *
 * ── Why this is a renderer, not a tool wrapper ─────────────────────────────
 * The obvious way to get compact rows is to re-register `read`/`bash` with
 * custom `renderCall`/`renderResult` (this is what @vanillagreen/pi-tool-
 * renderer does). That is unusable here for two reasons: pi hard-errors on the
 * name clash with pi-hashline-edit-pro (`read`) and sudo-session.ts (`bash`),
 * and the wrapper delegates to the *built-in* tool, which would route around
 * hashline's anchored reads and sudo-session's elevation entirely.
 *
 * So nothing here registers, wraps, or deactivates a single tool. It patches
 * the exported TUI components' render methods and reads what the row already
 * knows (`toolName`, `args`, `result`). Tool ownership is untouched, and the
 * compact rows work for every tool — including ones from extensions this
 * directory has never heard of.
 *
 * Patches are keyed by `Symbol.for`, so a double install is a no-op and each
 * is reverted on `session_shutdown`.
 *
 * ── Conflicts ─────────────────────────────────────────────────────────────
 * Do NOT run this alongside @pi-kaush/pi-tool-call-markers, @pi-kaush/pi-
 * content-layout, or pi-cc-extensions: all of them patch the same prototypes,
 * and whichever loads last silently wins.
 *
 * ── Config (env) ──────────────────────────────────────────────────────────
 *   NEAT_RENDER=0        disable entirely
 *   NEAT_RENDER_INSET=n  left inset for tool rows (default 1, matching pi's
 *                        message output pad; set 0 to hug the left edge)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installRows, uninstallRows } from "./row.ts";
import { CARD_PATCH, GROUP_PATCH, installCard, installTurns } from "./turn.ts";
import { foldThinkingFences, installThinking, uninstallThinking } from "./thinking.ts";
import { clearClock } from "./clock.ts";
import { installTable, uninstallTable } from "./table.ts";
import { installBackgroundMessages } from "./background.ts";
import { type Patchable, type RenderFn, type ThemeLike, off, state } from "./style.ts";

/* ── wiring ────────────────────────────────────────────────────────────── */

export function uninstall(proto: Patchable | undefined, key: symbol): void {
	if (!proto) return;
	const original = proto[key];
	if (typeof original === "function") proto.render = original as RenderFn;
	delete proto[key];
}

export default function (pi: ExtensionAPI) {
	if (off("NEAT_RENDER")) return;

	pi.registerMarkdownTransformer((markdown, context) =>
		context.messageType === "assistant-thinking" ? foldThinkingFences(markdown) : markdown,
	);

	const card = installCard();
	const thinking = installThinking();
	const rows = installRows();
	const table = installTable();

	installBackgroundMessages(pi);
	// The turn renderer composes the row renderer; both fall back to pi's own
	// output on their own if pi's internals do not look the way they expect.
	const turns = installTurns();

	pi.on("session_start", (_event, ctx) => {
		state.theme = ctx.ui.theme as unknown as ThemeLike;
	});

	let released = false;
	pi.on("session_shutdown", () => {
		if (released) return;
		released = true;
		clearClock();
		uninstall(turns, GROUP_PATCH);
		uninstallRows(rows);
		uninstall(card, CARD_PATCH);
		uninstallThinking(thinking);
		uninstallTable(table);
	});
}
