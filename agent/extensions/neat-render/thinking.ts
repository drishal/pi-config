/**
 * thinking — one line for a reasoning block, not a wall of italic prose.
 *
 *   ● Thinking 3s │ …let me do one more round of distinct tools
 *   ▸ Thought 2.1s — The bug is in the batch commit path…
 *   ▾ Thought 2.1s
 *     │ The bug is in the batch commit path: the last member carries the
 *     │ combined diff, so the earlier rows render nothing.
 *
 * While the block is still streaming the line rolls with the latest thought,
 * so a live turn shows what is happening now rather than everything so far.
 *
 * Nothing about visibility changes: pi still decides what is open (Ctrl+T for
 * all blocks, a click for one) and still owns each block's MouseRegion. After
 * pi rebuilds the message this only swaps what the region draws, so clicks and
 * Ctrl+T keep working and no pi logic is duplicated.
 */

import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	factText,
	fit,
	glyph,
	noteText,
	oneLine,
	paint,
	state,
} from "./style.ts";
import { durationLabel, pulseOn, watch } from "./clock.ts";
import type { Renderable } from "./row.ts";

export const THINK_PATCH = Symbol.for("dr.pi.neatRender.thinking.v1");

export type ContentBlock = { type?: string; thinking?: string };
export type ThinkingRun = { text: string; done: boolean };
export type AssistantInternals = {
	contentContainer?: { children?: unknown[] };
	hideThinkingBlock?: boolean;
	thinkingVisibilityOverrides?: Map<number, boolean>;
	isStreaming?: boolean;
	outputPad?: number;
};
export type Region = { child: Renderable & { invalidate?(): void }; onMouse?: unknown; handleMouse?: unknown };

/** Thinking runs exactly as pi groups them: consecutive blocks, empty ones skipped. */
export function thinkingRuns(content: ContentBlock[]): ThinkingRun[] {
	const runs: ThinkingRun[] = [];
	for (let i = 0; i < content.length; i++) {
		if (content[i]?.type !== "thinking") continue;
		const parts: string[] = [];
		for (; i < content.length && content[i]?.type === "thinking"; i++) {
			const t = (content[i]?.thinking ?? "").trim();
			if (t) parts.push(t);
		}
		// Anything after the run means the model has moved on: it is finished.
		const followed = i < content.length;
		i--;
		if (parts.length) runs.push({ text: parts.join("\n\n"), done: followed });
	}
	return runs;
}

/**
 * When each reasoning run started and stopped, per assistant component.
 *
 * pi rebuilds the content container on every streaming update, so the region
 * objects (and any view hanging off them) are short-lived. The component is
 * not, so the stopwatch lives there: `Thought 2.1s` has to survive the rebuild
 * that clears the ThinkingView which measured it.
 */
const TIMES = new WeakMap<object, Map<number, { start: number; end?: number }>>();

function timeFor(host: object, index: number): { start: number; end?: number } {
	let times = TIMES.get(host);
	if (!times) {
		times = new Map();
		TIMES.set(host, times);
	}
	let entry = times.get(index);
	if (!entry) {
		entry = { start: Date.now() };
		times.set(index, entry);
	}
	return entry;
}

/** The first sentence of a thought, which is what the collapsed line shows. */
function firstSentence(text: string): string {
	const flat = text.replace(/```[\s\S]*?(```|$)/g, " ").replace(/\s+/g, " ").trim();
	const cut = flat.search(/[.!?](\s|$)/);
	return cut > 20 ? flat.slice(0, cut + 1) : flat;
}

/** The newest line of a live thought: the rolling preview. */
function latestLine(text: string): string {
	const rows = text.split("\n").map((l) => l.replace(/^[\s>*\-|#`]+/, "").trim()).filter(Boolean);
	return rows[rows.length - 1] ?? "";
}

/** Human duration of a run, when one was measured. */
function runDuration(start: number, end: number | undefined): string {
	const ms = (end ?? Date.now()) - start;
	return ms >= 250 ? durationLabel(ms) : "";
}

export class ThinkingView {
	private readonly run: ThinkingRun;
	private readonly body: (Renderable & { invalidate?(): void }) | undefined;
	private readonly pad: number;
	private readonly start: number;
	private readonly end: number | undefined;

	constructor(
		run: ThinkingRun,
		body: (Renderable & { invalidate?(): void }) | undefined,
		pad: number,
		times: { start: number; end?: number },
	) {
		this.run = run;
		this.body = body;
		this.pad = pad;
		this.start = times.start;
		this.end = times.end;
	}

	render(width: number): string[] {
		const theme = state.theme;
		if (!theme) return this.body?.render(width) ?? [];
		const pad = " ".repeat(this.pad);
		const elapsed = runDuration(this.start, this.run.done ? (this.end ?? Date.now()) : undefined);

		if (!this.run.done) {
			// Live: the header says how long it has been thinking, then the
			// newest line of the thought, so the turn shows what is happening
			// now instead of a growing wall.
			watch(this);
			const dot = theme.fg(pulseOn() ? "warning" : "dim", glyph.bullet);
			const head = `${dot} ${paint(theme, "thought", "Thinking")}${elapsed ? ` ${factText(theme, elapsed)}` : ""}`;
			const bar = paint(theme, "rule", glyph.bar);
			const room = Math.max(8, width - visibleWidth(head) - 4);
			const preview = oneLine(latestLine(this.run.text), room);
			return [fit(`${pad}${head}${preview ? ` ${bar} ${noteText(theme, preview)}` : ""}`, width)];
		}

		// ▾ when the reasoning hangs below, ▸ when folded away.
		const arrow = paint(theme, "fact", this.body ? glyph.open : glyph.shut);
		const head = `${arrow} ${paint(theme, "thought", "Thought")}${elapsed ? ` ${factText(theme, elapsed)}` : ""}`;
		const lines: string[] = [];
		if (this.body) {
			lines.push(fit(`${pad}${head}`, width));
			const bar = paint(theme, "rule", glyph.bar);
			const room = Math.max(8, width - pad.length - 2);
			for (const line of this.body.render(room)) lines.push(fit(`${pad}${bar} ${line}`, width));
			return lines;
		}
		const summary = oneLine(firstSentence(this.run.text), Math.max(8, width - visibleWidth(head) - 4));
		lines.push(fit(`${pad}${head}${summary ? ` ${paint(theme, "fact", "—")} ${summary}` : ""}`, width));
		return lines;
	}

	invalidate(): void {
		this.body?.invalidate?.();
	}
}

export function decorateThinking(host: AssistantInternals, message: { content?: ContentBlock[] }): void {
	const kids = host.contentContainer?.children;
	if (!Array.isArray(kids) || !Array.isArray(message?.content)) return;
	const runs = thinkingRuns(message.content);
	let index = 0;
	for (const kid of kids) {
		// Only thinking runs are wrapped in a MouseRegion, one per run, in order.
		const region = kid as Region;
		if (!region || typeof region.handleMouse !== "function" || !region.child) continue;
		const run = runs[index];
		const hidden = host.thinkingVisibilityOverrides?.get(index) ?? host.hideThinkingBlock ?? false;
		const times = timeFor(host as object, index);
		index++;
		if (!run) break;
		const done = run.done || !host.isStreaming;
		if (done && times.end === undefined) times.end = Date.now();
		region.child = new ThinkingView(
			{ ...run, done },
			hidden ? undefined : region.child,
			host.outputPad ?? 1,
			times,
		);
	}
}

type UpdateFn = (this: unknown, message: unknown, isStreaming?: boolean) => void;
type ThinkingPatchable = { updateContent: UpdateFn; [key: symbol]: unknown };

export function installThinking(): ThinkingPatchable | undefined {
	const proto = (AssistantMessageComponent as unknown as { prototype?: ThinkingPatchable } | undefined)?.prototype;
	if (!proto || typeof proto.updateContent !== "function" || proto[THINK_PATCH]) return undefined;
	const original = proto.updateContent;
	proto.updateContent = function (message: unknown, isStreaming?: boolean) {
		original.call(this, message, isStreaming);
		try {
			decorateThinking(this as AssistantInternals, message as { content?: ContentBlock[] });
		} catch {
			/* keep pi's own rendering */
		}
	} as UpdateFn;
	proto[THINK_PATCH] = original;
	return proto;
}

export function uninstallThinking(proto: ThinkingPatchable | undefined): void {
	if (!proto) return;
	const original = proto[THINK_PATCH];
	if (typeof original === "function") proto.updateContent = original as UpdateFn;
	delete proto[THINK_PATCH];
}

/* ── perspective on long reasoning ─────────────────────────────────────── */

const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;

/**
 * Elide fenced code out of a thinking block, leaving a trailing ellipsis.
 *
 * A reasoning trace that quotes a config file or a diff buries its own
 * argument: the prose is the part worth reading, and the code is usually
 * something already on screen. Folding it to "…" keeps the trace scannable.
 * Ported from omp's prose-only thinking mode (packages/tui/src/chat/
 * thinking-display.ts), which appends the ellipsis to the preceding line
 * rather than emitting a placeholder, so the result reads as prose trailing
 * off instead of a collapsed region.
 *
 * An unterminated fence — the common case mid-stream — folds too, so the
 * block does not flash open as it arrives. Only the *display* is folded;
 * the transcript, the session file and the model's context are untouched.
 */
export function foldThinkingFences(md: string): string {
	if (!md || (!md.includes("```") && !md.includes("~~~"))) return md;

	const out: string[] = [];
	let inFence = false;
	let fenceChar = "";
	let fenceLen = 0;
	let elided = false;

	/** Trail the previous non-blank line off, rather than adding a marker. */
	const addEllipsis = (): void => {
		for (let i = out.length - 1; i >= 0; i--) {
			const t = out[i].trimEnd();
			if (t === "") continue;
			if (t.endsWith("...") || t.endsWith("…")) out[i] = t;
			else out[i] = t.endsWith(".") ? `${t.slice(0, -1)}...` : `${t}...`;
			return;
		}
		out.push("...");
	};

	for (const line of md.split("\n")) {
		const m = FENCE_RE.exec(line);
		if (inFence) {
			// A closing fence is the same char, at least as long, alone on the
			// line — so a shorter ``` inside a ```` block does not close it.
			if (m && m[2][0] === fenceChar && m[2].length >= fenceLen && m[3].trim() === "") {
				inFence = false;
				fenceChar = "";
				fenceLen = 0;
			}
			continue;
		}
		if (m) {
			inFence = true;
			fenceChar = m[2][0];
			fenceLen = m[2].length;
			addEllipsis();
			elided = true;
			continue;
		}
		out.push(line);
	}
	return elided ? out.join("\n") : md;
}
