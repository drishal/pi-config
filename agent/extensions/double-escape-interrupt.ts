/**
 * double-escape-interrupt — require two Esc presses to abort a running turn.
 *
 * One Esc aborts instantly, which is easy to hit in the wrong tmux pane.
 * keybindings.json takes single keys only, so `app.interrupt` cannot become a
 * sequence. Instead this extension swallows the first Esc while the agent is
 * busy and lets the second one through to the built-in handler, which still
 * does the real abort (restoring queued messages, cancelling retries, ...).
 *
 * Idle presses are untouched: double-Esc tree/fork, autocomplete dismiss,
 * bash mode, selectors and dialogs behave as before. Release events are
 * ignored so Kitty-protocol terminals do not count one press twice.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";

const WINDOW_MS = 500;
const STATUS = "double-escape-interrupt";

export default function (pi: ExtensionAPI) {
	let armedAt = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let unsubscribe: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		unsubscribe?.();
		unsubscribe = undefined;
		if (timer) clearTimeout(timer);
		timer = undefined;
		armedAt = 0;
		if (ctx.mode !== "tui") return;

		const disarm = () => {
			if (timer) clearTimeout(timer);
			timer = undefined;
			if (armedAt === 0) return;
			armedAt = 0;
			ctx.ui.setStatus(STATUS, undefined);
		};

		unsubscribe = ctx.ui.onTerminalInput((data) => {
			if (isKeyRelease(data)) return; // one physical press, one Esc
			if (!matchesKey(data, "escape") || ctx.isIdle()) {
				disarm();
				return;
			}
			const now = Date.now();
			if (now - armedAt < WINDOW_MS) {
				disarm();
				return; // second Esc: fall through to the built-in interrupt
			}
			armedAt = now;
			ctx.ui.setStatus(STATUS, "Esc again to interrupt");
			if (timer) clearTimeout(timer);
			timer = setTimeout(disarm, WINDOW_MS);
			return { consume: true };
		});
	});

	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = undefined;
		if (timer) clearTimeout(timer);
		timer = undefined;
		armedAt = 0;
	});
}
