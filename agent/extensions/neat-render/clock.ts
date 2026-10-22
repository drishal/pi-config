/**
 * clock — the one place time enters the transcript.
 *
 * pi repaints on change, not on a clock, so anything live (a pulsing bullet,
 * a running timer) has to arm its own repaint. One chain per component would
 * mean a timer per row; here a single ticker runs while anything is live and
 * invalidates every watching component.
 */

import { off } from "./style.ts";

/* ── in-flight pulse ───────────────────────────────────────────────────── */

/** Half-period of the bullet pulse, in ms. */
export const PULSE_MS = 450;
/** Timer handle parked on a component so only one is ever in flight. */
export const PULSE_TIMER = Symbol.for("dr.pi.neatRender.pulse.v1");
/** Every live timer, so session shutdown can cancel them. */
export const pulseTimers = new Set<ReturnType<typeof setTimeout>>();

/** Which half of the pulse we are in right now. */
export function pulseOn(): boolean {
	return Math.floor(Date.now() / PULSE_MS) % 2 === 0;
}

/* ── elapsed timer on running rows ─────────────────────────────────────── */

/**
 * When a row started being partial, per ToolExecutionComponent. pi recreates
 * those between turns, and an execution only goes partial when it actually
 * starts running, so the stamp is taken on the first partial render.
 */
export const RUN_STARTS = new WeakMap<object, number>();
/** Partial rows whose elapsed is past the timer threshold. */
export const timedRows = new WeakSet<object>();

/**
 * How long a call must run before the timer appears, in ms. Below this the
 * stopwatch would flash into existence for the fraction of a render —
 * everything says the call is finishing, and then it is.
 */
export const TIMER_AFTER_MS = 1500;
/** How often a timed row invalidates while pulse is off. */
export const TIMER_TICK_MS = 500;

/** When a stamped row was first rendered finished, per ToolExecutionComponent. */
export const RUN_ENDS = new WeakMap<object, number>();

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

/** Durations under this stay off the row; a column of "0.0s" is noise. */
export const DURATION_AFTER_MS = 1000;

/**
 * Keep a running row repainting so its bullet can pulse.
 *
 * pi repaints on change, not on a clock, so a phase computed from Date.now()
 * would sit frozen on a long tool call — exactly when the feedback matters.
 * ToolExecutionComponent exposes `invalidate()`, so each render of a partial
 * row arms one unref'd timer that invalidates it, and the next render arms
 * the next. The chain stops on its own the moment the row stops being
 * partial, because only a partial row arms a timer.
 *
 * NEAT_RENDER_PULSE=0 turns it off and leaves a static bullet.
 */
export function armPulse(component: unknown): void {
	if (off("NEAT_RENDER_PULSE")) return;
	const host = component as {
		invalidate?: () => void;
		[key: symbol]: unknown;
	};
	if (typeof host.invalidate !== "function") return;
	if (host[PULSE_TIMER]) return; // one in flight is enough

	const timer = setTimeout(() => {
		pulseTimers.delete(timer);
		host[PULSE_TIMER] = undefined;
		try {
			host.invalidate?.();
		} catch {
			/* component torn down mid-flight */
		}
	}, PULSE_MS);
	// Never let an animation frame hold the process open.
	(timer as { unref?: () => void }).unref?.();
	pulseTimers.add(timer);
	host[PULSE_TIMER] = timer;
}

export function clearPulses(): void {
	for (const t of pulseTimers) clearTimeout(t);
	pulseTimers.clear();
}
