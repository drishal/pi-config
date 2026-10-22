/**
 * neat-render — compact, Claude-Code-shaped transcript chrome for pi.
 *
 * One turn, folded:
 *
 *   ❯ In a batch, launch a few read/grep commands.
 *
 *   Let me check how pi loads extensions…
 *   ▸ Worked 18s · read 2 files, ran 3 commands, 1 search · 1 failed
 *   ● Pi loads a directory extension from its index.ts.
 *
 * ── What Ctrl+O means now ─────────────────────────────────────────────────
 * pi's tool-output toggle opens every turn at once: each call drawn as a full
 * omp-style frame. With it off, a finished turn folds its *calls* into one
 * summary line; the prose, the reasoning and the answer stay exactly as pi
 * draws them. A running turn shows its calls as a live tree.
 *
 * Reasoning follows pi's own Ctrl+T, untouched: visible means the block is
 * shown at length (under a `│` bar), hidden means one `▸ Thought 2.1s — …`
 * disclosure line.
 *
 * ── Files ─────────────────────────────────────────────────────────────────
 * style.ts palette and glyphs · tools.ts the per-tool registry · row.ts one
 * call · turn.ts the fold and the answer · thinking.ts reasoning lines ·
 * table.ts compact markdown tables · clock.ts the shared ticker.
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
 *   NEAT_RENDER_FOLD=0   leave every turn expanded
 *   NEAT_RENDER_INSET=n  left inset for tool rows (default 1, matching pi's
 *                        message output pad; set 0 to hug the left edge)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ROW_PATCH, installRows } from "./row.ts";
import { CARD_PATCH, GROUP_PATCH, installCard, installTurns } from "./turn.ts";
import { foldThinkingFences, installThinking, uninstallThinking } from "./thinking.ts";
import { clearClock } from "./clock.ts";
import { installTable, uninstallTable } from "./table.ts";
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
	// The turn renderer composes the row renderer; both fall back to pi's own
	// output on their own if pi's internals do not look the way they expect.
	const turns = installTurns();

	pi.on("session_start", (_event, ctx) => {
		state.theme = ctx.ui.theme as unknown as ThemeLike;
		state.ui = ctx.ui;
	});

	let released = false;
	pi.on("session_shutdown", () => {
		if (released) return;
		released = true;
		clearClock();
		uninstall(turns, GROUP_PATCH);
		uninstall(rows, ROW_PATCH);
		uninstall(card, CARD_PATCH);
		uninstallThinking(thinking);
		uninstallTable(table);
	});
}
