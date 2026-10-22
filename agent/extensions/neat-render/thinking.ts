/**
 * thinking — one line for a reasoning block, not a wall of italic prose.
 *
 *   ▸ Thought 2.1s — first sentence…   collapsed
 *   ▾ Thought 2.1s                     expanded, reasoning under a │ bar
 *
 * While the block is still streaming the line rolls with the latest thought,
 * so a live turn shows what is happening now rather than everything so far.
 */

import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { off, state } from "./style.ts";
import { pulseOn } from "./clock.ts";
import type { Renderable } from "./row.ts";

export const THINK_PATCH = Symbol.for("dr.pi.neatRender.thinking.v1");

/* ── thinking blocks: opencode-style disclosure ─────────────────────────── */

/**
 * pi draws a collapsed thinking block as the same "Thinking..." for every
 * block, and an expanded one as a wall of dim italic text. This gives each
 * block one line that says what it was about, the way opencode does:
 *
 *   ● Thinking · ~340 tokens         while it streams (pulsing)
 *   ▸ Thinking · ~340 tokens         collapsed
 *   ▾ Thinking · ~340 tokens         expanded, then the reasoning,
 *       indented under it             text itself
 *
 * The arrow tells you whether the reasoning is shown: ▾ pointing down means
 * the content hangs below the header, ▸ means it is folded away.
 *
 * Nothing about visibility changes: pi still decides what is open (Ctrl+T for
 * all blocks, a click for one) and still owns each block's MouseRegion. After
 * pi rebuilds the message this only swaps what the region draws, so clicks
 * and Ctrl+T keep working and no pi logic is duplicated.
 */

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


export function tokenCount(chars: number): string {
	const n = Math.max(1, Math.round(chars / 4));
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}


export class ThinkingView {
	private readonly run: ThinkingRun;
	private readonly body: (Renderable & { invalidate?(): void }) | undefined;
	private readonly pad: number;

	constructor(run: ThinkingRun, body: (Renderable & { invalidate?(): void }) | undefined, pad: number) {
		this.run = run;
		this.body = body;
		this.pad = pad;
	}

	render(width: number): string[] {
		const theme = state.theme;
		if (!theme) return this.body?.render(width) ?? [];
		const tokens = theme.fg("dim", `· ~${tokenCount(this.run.text.length)} tokens`);
		let head: string;
		if (!this.run.done) {
			const dot = theme.fg(pulseOn() && !off("NEAT_RENDER_PULSE") ? "warning" : "dim", "●");
			head = `${dot} ${theme.fg("thinkingText", "Thinking")} ${tokens}`;
		} else {
			// ▾ when the reasoning hangs below, ▸ when folded away.
			const arrow = theme.fg("dim", this.body ? "▾" : "▸");
			head = `${arrow} ${theme.fg("thinkingText", "Thinking")} ${tokens}`;
		}
		const lines = [truncateToWidth(" ".repeat(this.pad) + head, width)];
		if (this.body) {
			// pi's markdown keeps its own pad, so the text hangs under the header.
			const indent = "  ";
			for (const line of this.body.render(Math.max(8, width - indent.length))) lines.push(indent + line);
		}
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
		index++;
		if (!run) break;
		const done = run.done || !host.isStreaming;
		region.child = new ThinkingView({ ...run, done }, hidden ? undefined : region.child, host.outputPad ?? 1);
	}
}

export type UpdateFn = (this: unknown, message: unknown, isStreaming?: boolean) => void;
export type ThinkingPatchable = { updateContent: UpdateFn; [key: symbol]: unknown };

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

export const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;

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
 *
 * NEAT_RENDER_FOLD_THINKING=0 shows thinking verbatim.
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
