/**
 * clock — the one place time enters the transcript.
 *
 * pi repaints on change, not on a clock, so anything live (a pulsing bullet, a
 * running timer) has to arm its own repaint. One chain per component would be
 * a timer per row; here a single ticker runs while anything is live, pulses on
 * a counter (so two live rows can never disagree about the phase), and
 * invalidates every component that asked to be watched.
 */

/** When a row started being partial, per ToolExecutionComponent. */
export const RUN_STARTS = new WeakMap<object, number>();
/** When a stamped row was first rendered finished, per ToolExecutionComponent. */
export const RUN_ENDS = new WeakMap<object, number>();

/**
 * How long a call must run before the timer appears, in ms. Below this the
 * stopwatch would flash into existence for the fraction of a render —
 * everything says the call is finishing, and then it is.
 */
export const TIMER_AFTER_MS = 1500;
/** Durations under this stay off the row; a column of "0.0s" is noise. */
export const DURATION_AFTER_MS = 1000;

/** Half-period of the live pulse, in ms. Also the tick interval. */
const TICK_MS = 450;

type Watcher = { invalidate?(): void };

/** Components that asked to be repainted while they are live. */
const watchers = new Map<Watcher, number>();
let tick = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Which half of the pulse we are in right now. */
export function pulseOn(): boolean {
	return tick % 2 === 0;
}

/**
 * Keep a live component repainting.
 *
 * A component calls this from render() for as long as it is live; the next
 * tick repaints it, and if it is no longer live by then it does not call
 * `watch` again, so the entry is pruned and the ticker stops by itself.
 */
export function watch(component: Watcher): void {
	watchers.set(component, tick);
	if (timer) return;
	timer = setTimeout(beat, TICK_MS);
	// Never let an animation frame hold the process open.
	(timer as { unref?: () => void }).unref?.();
}

function beat(): void {
	timer = undefined;
	tick += 1;
	for (const [component, seen] of watchers) {
		// Not seen for a whole tick and still here: it stopped being live.
		if (tick - seen > 1) {
			watchers.delete(component);
			continue;
		}
		try {
			component.invalidate?.();
		} catch {
			/* component torn down mid-flight */
		}
	}
	if (watchers.size > 0) watch(watchers.keys().next().value as Watcher);
}

export function clearClock(): void {
	watchers.clear();
	if (timer) clearTimeout(timer);
	timer = undefined;
}

/** Elapsed since a row started running: "9s", "3m12s". */
export function elapsedLabel(start: number): string {
	const s = Math.floor(Math.max(0, Date.now() - start) / 1000);
	const m = Math.floor(s / 60);
	return m > 0 ? `${m}m${s % 60}s` : `${s}s`;
}

/** A finished call's duration: "1.4s", "3m12s". */
export function durationLabel(ms: number): string {
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const s = Math.floor(ms / 1000);
	return `${Math.floor(s / 60)}m${s % 60}s`;
}

/** How long a finished row ran, when both ends were seen. */
export function tookMs(row: object): number | undefined {
	const start = RUN_STARTS.get(row);
	const end = RUN_ENDS.get(row);
	return start !== undefined && end !== undefined ? end - start : undefined;
}
