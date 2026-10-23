/**
 * turn — the shape of one exchange.
 *
 *   ❯ Read the container patch, then mark the answer.
 *
 *   Let me read the container patch first.
 *   ▾ 3 tool calls · 1.4s
 *   ├─ ● Read   agent/extensions/neat-render/turn.ts   525 lines
 *   └─ ● Search "chatContainer" in modes/interactive     3 results
 *
 *   └─ Thinking 2.1s
 *      A turn runs from one prompt to the next, so the fold has to live in
 *      Container.render.
 *
 *   ● A turn is the prompt plus everything up to the next prompt.
 *
 * Nothing is collapsed here: a call is a row, a run of calls is a tree, and
 * the reasoning hangs under its own label. pi's Ctrl+O still opens every call
 * at full size. Spacing is owned here: exactly one blank line between the
 * prompt, the work and the answer, and none inside the activity block.
 */

import { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	type Patchable,
	type RenderFn,
	type ThemeLike,
	type ToolRow,
	glyph,
	inset,
	noteText,
	paint,
	state,
} from "./style.ts";
import { summarize } from "./tools.ts";
import {
	DURATION_AFTER_MS,
	RUN_ENDS,
	RUN_STARTS,
	durationLabel,
	pulseOn,
} from "./clock.ts";
import { GROUPED, LEAD_LINES, bullet, isBlank, padVerbs, trimBlank } from "./row.ts";

/* ── the prompt: a `❯` quote over a full-width fill strip ──────────────── */

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const OSC133_ZONE_RE = /\x1b\]133;[ABC]\x07/g;

export const CARD_PATCH = Symbol.for("dr.pi.neatRender.card.v1");

export function installCard(): Patchable | undefined {
	const proto = UserMessageComponent?.prototype as unknown as Patchable | undefined;
	if (!proto || typeof proto.render !== "function" || proto[CARD_PATCH]) return undefined;
	const original = proto.render;

	proto.render = function (width: number): string[] {
		const theme = state.theme;
		if (!theme || width < 12) return original.call(this, width);
		// `text` is TS-private but a plain field at runtime.
		const text = (this as unknown as { text?: unknown }).text;
		if (typeof text !== "string" || !text.trim()) return original.call(this, width);

		// Claude Code draws the prompt as a `❯` quote over a plain full-width
		// fill strip: no borders, so no box geometry to break. The raw text is
		// wrapped and quoted directly, then each line is padded out to the
		// full width and painted. Every painted line measures exactly `width`,
		// which is all pi requires.
		const mark = noteText(theme, glyph.prompt);
		const room = Math.max(8, width - 2);
		// The `❯` opens the quote once, Claude-style: wrapped lines and later
		// paragraphs indent under it instead of repeating the marker.
		const rows: string[] = [];
		let opened = false;
		for (const para of text.replace(/\n+$/, "").split("\n")) {
			if (!para.trim()) {
				rows.push("");
				continue;
			}
			wrapTextWithAnsi(para, room).forEach((line) => {
				rows.push(opened ? `  ${line}` : `${mark} ${line}`);
				opened = true;
			});
		}
		if (rows.length === 0) return original.call(this, width);
		const out = rows.map((line) =>
			theme.bg("userMessageBg", line + " ".repeat(Math.max(0, width - visibleWidth(line)))),
		);
		// Keep the shell-integration zone pi's own render emits.
		out[0] = `${OSC133_ZONE_START}${out[0]}`;
		out[out.length - 1] = `${out[out.length - 1]}${OSC133_ZONE_END}${OSC133_ZONE_FINAL}`;
		return out;
	} as RenderFn;

	proto[CARD_PATCH] = original;
	return proto;
}

/* ── reading the parts of a turn ───────────────────────────────────────── */

type Renderable = { render(width: number): string[] };
type AssistantInternals = {
	contentContainer?: { children?: unknown[] };
	isStreaming?: boolean;
	lastMessage?: Message;
	hiddenThinkingLabel?: string;
};
type Message = {
	content?: Array<{ type?: string; text?: string; thinking?: string }>;
};

/** One legible piece of a turn, in the order it happened. */
type Block =
	| { kind: "activity"; rows: ToolRow[] }
	| { kind: "assistant"; comp: AssistantInternals; answer: boolean }
	| { kind: "other"; comp: unknown; lines: string[] };

/** A tool call or a streaming message means the turn is still running. */
function isLive(parts: unknown[]): boolean {
	return parts.some((kid) => {
		if (kid instanceof ToolExecutionComponent) return (kid as unknown as ToolRow).isPartial === true;
		if (kid instanceof AssistantMessageComponent) return (kid as unknown as AssistantInternals).isStreaming === true;
		return false;
	});
}

/**
 * Split a turn into blocks.
 *
 * A run of adjacent tool calls is one activity block; a thinking-only or
 * tool-call-only assistant message renders no lines of its own and therefore
 * does not break that run. Everything else that is not an assistant message
 * passes through untouched.
 */
function blocksOf(parts: unknown[], width: number, keepThinking: boolean): Block[] {
	const blocks: Block[] = [];
	let activity: ToolRow[] | undefined;
	const closeActivity = () => {
		if (activity && activity.length > 0) blocks.push({ kind: "activity", rows: activity });
		activity = undefined;
	};

	for (const kid of parts) {
		if (kid instanceof ToolExecutionComponent) {
			(activity ??= []).push(kid as unknown as ToolRow);
			continue;
		}
		if (kid instanceof AssistantMessageComponent) {
			const host = kid as unknown as AssistantInternals;
			const content = host.lastMessage?.content ?? [];
			const hasText = content.some((c) => c.type === "text" && c.text?.trim());
			const hasCalls = content.some((c) => c.type === "toolCall");
			// A message that is only reasoning renders no text of its own — but
			// while the turn is live it carries the rolling thought line.
			const hasThinking = content.some((c) => c.type === "thinking" && c.thinking?.trim());
			if (!hasText && !(keepThinking && hasThinking)) continue;
			closeActivity();
			blocks.push({ kind: "assistant", comp: host, answer: hasText && !hasCalls });
			continue;
		}
		const comp = kid as Renderable;
		if (typeof comp?.render !== "function") continue;
		const lines = trimBlank(comp.render(width));
		// A spacer between the prompt and the answer says nothing; this
		// renderer owns the gaps between blocks.
		if (lines.length === 0) continue;
		closeActivity();
		blocks.push({ kind: "other", comp, lines });
	}
	closeActivity();

	// Only the last text-only message is the answer; an earlier one is
	// narration, however it ended.
	let answer: Block | undefined;
	for (const b of blocks) if (b.kind === "assistant" && b.answer) answer = b;
	for (const b of blocks) if (b.kind === "assistant" && b !== answer) b.answer = false;
	return blocks;
}

/**
 * A finished message: pi's own render (so reasoning shows exactly as Ctrl+T
 * says, with its working clicks), the hidden thinking label taken back out,
 * and — for the answer — the accent bullet on the first line of text, with
 * every line under it indented to match.
 *
 * Rendering through the component keeps its internal line count, and therefore
 * pi's mouse hit-testing, exactly right.
 */
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").trim();

/** A line the reasoning drew: its header, or one of its `│` body lines. */
const isThought = (line: string) => {
	const text = plain(line);
	return text.startsWith(`${glyph.open} Thought`) || text.startsWith(`${glyph.shut} Thought`) || text.startsWith(glyph.bar);
};

function finishedMessage(
	host: AssistantInternals & Renderable,
	theme: ThemeLike,
	width: number,
	bullet: boolean,
): string[] {
	const label = host.hiddenThinkingLabel;
	const room = bullet ? Math.max(8, width - 2) : width;
	const lines = trimBlank(host.render(room))
		// With thinking hidden, pi draws a bare label instead of the block.
		.filter((line) => !label || plain(line) !== label)
		// A collapsed reasoning run leaves its spacer behind; keep one blank.
		.filter((line, index, all) => !(isBlank(line) && index > 0 && isBlank(all[index - 1])));
	if (!bullet) return lines;
	const dot = paint(theme, "answer", glyph.bullet);
	let marked = false;
	return lines.map((line) => {
		if (isBlank(line)) return line;
		// Reasoning keeps its own indent above the answer.
		if (!marked && isThought(line)) return line;
		if (marked) return `  ${line}`;
		marked = true;
		return `${dot} ${line}`;
	});
}

/* ── folding a finished turn ───────────────────────────────────────────── */

/* ── patch: turns ──────────────────────────────────────────────────────── */

export const GROUP_PATCH = Symbol.for("dr.pi.neatRender.turn.v1");

/**
 * Container.render is a plain concat of child renders, so it is safe to
 * reimplement: a `UserMessageComponent` opens a turn, and everything up to the
 * next one belongs to it.
 *
 * pi records a mouse layout while it renders so clicks can be routed back to
 * the component under the cursor. This patch renders the same content in a
 * different shape, so it rebuilds that layout too — a turn's lines belong to
 * the component that drew them, and the summary and footer belong to nobody
 * (clicking them should do nothing at all).
 */
export function installTurns(): Patchable | undefined {
	const proto = Container?.prototype as unknown as Patchable | undefined;
	if (!proto || typeof proto.render !== "function" || proto[GROUP_PATCH]) return undefined;
	const original = proto.render;

	proto.render = function (width: number): string[] {
		const theme = state.theme;
		const kids = (this as { children?: unknown[] }).children;
		if (!theme || !Array.isArray(kids) || kids.length === 0) {
			return original.call(this, width);
		}
		// Every container renders through this patch; only the chat transcript
		// holds turns, so everything else passes straight through.
		if (!kids.some((k) => k instanceof UserMessageComponent)) {
			return original.call(this, width);
		}

		const lines: string[] = [];
		const mouse: MouseEntry[] = [];
		const emit = (rendered: string[], source: unknown) => {
			if (rendered.length === 0) return;
			lines.push(...rendered);
			mouse.push({ component: source, height: rendered.length });
		};

		for (let i = 0; i < kids.length; ) {
			const kid = kids[i] as Renderable;
			if (!(kid instanceof UserMessageComponent)) {
				emit(kid.render(width), kid);
				i += 1;
				continue;
			}
			// The turn runs to the next prompt, or to the end of the transcript.
			let end = i + 1;
			while (end < kids.length && !(kids[end] instanceof UserMessageComponent)) end++;
			for (const fragment of renderTurn(kid, kids.slice(i + 1, end), theme, width)) {
				emit(fragment.lines, fragment.source);
			}
			i = end;
		}
		(this as { mouseLayout?: unknown }).mouseLayout = { width, children: mouse };
		return lines;
	} as RenderFn;

	proto[GROUP_PATCH] = original;
	return proto;
}

export function uninstallTurns(proto: Patchable | undefined): void {
	if (!proto) return;
	const original = proto[GROUP_PATCH];
	if (typeof original === "function") proto.render = original as RenderFn;
	delete proto[GROUP_PATCH];
}

/** One run of emitted lines, and the child that drew them (or nobody). */
type Fragment = { lines: string[]; source: unknown };
/** Mouse layout entry, shaped the way pi-tui's Container records it. */
type MouseEntry = { component: unknown; height: number };

/** Not a click target, for lines that belong to no component. */
const NOWHERE = { render: () => [], handleMouse: () => undefined };

/**
 * Lay out one turn: prompt, work, answer.
 *
 * Nothing is ever collapsed: the calls show as a tree, the reasoning as its
 * hung block, and the answer carries the accent bullet. This renderer only
 * decides order and spacing — pi still draws every child.
 */
function renderTurn(prompt: Renderable, parts: unknown[], theme: ThemeLike, width: number): Fragment[] {
	const live = isLive(parts);
	const blocks = blocksOf(parts, width, true);

	const out: Fragment[] = [{ lines: prompt.render(width), source: prompt }];
	/** One blank line between blocks; it belongs to whatever came before. */
	const push = (lines: string[], source: unknown) => {
		if (lines.length === 0) return;
		const previous = out[out.length - 1];
		out.push({ lines: [""], source: previous?.source ?? prompt }, { lines, source });
	};
	const pushAll = (fragments: Fragment[]) => {
		const filled = fragments.filter((fragment) => fragment.lines.length > 0);
		if (filled.length === 0) return;
		const previous = out[out.length - 1];
		out.push({ lines: [""], source: previous?.source ?? prompt }, ...filled);
	};

	const draw = (block: Block) => {
		if (block.kind === "activity") {
			pushAll(renderRun(block.rows, theme, width));
			return;
		}
		if (block.kind === "assistant") {
			const host = block.comp as unknown as AssistantInternals & Renderable;
			// A finished message always renders the same way; only a live one
			// is left entirely to pi.
			push(live ? trimBlank(host.render(width)) : finishedMessage(host, theme, width, block.answer), block.comp);
			return;
		}
		push(block.lines, block.comp);
	};

	// The answer closes the turn. Anything pi appends afterwards — a startup
	// warning, a compaction notice — is emitted after it, not inside the work
	// it is reporting on.
	const answerIndex = blocks.findIndex((block) => block.kind === "assistant" && block.answer);
	const cut = answerIndex >= 0 ? answerIndex : blocks.length - 1;
	blocks.forEach((block, index) => {
		if (index <= cut) draw(block);
	});
	blocks.forEach((block, index) => {
		if (index > cut) draw(block);
	});
	// pi brackets an assistant message in OSC 133 zones for shell integration;
	// the prompt already carries the pair, so the body drops them.
	for (const fragment of out.slice(1)) fragment.lines = fragment.lines.map((line) => line.replace(OSC133_ZONE_RE, ""));
	return out;
}

/**
 * Render a run of adjacent tool calls.
 *
 * A lone call is a bulleted row; continuation lines align under its text:
 *
 *   ● Bash $ grep -rniE '(api[_-]?key|secret|token)' .
 *     └ 80 lines
 *
 * Two or more calls fired together hang off one disclosure header, drawn in
 * the same grammar as a thinking block (`●` pulsing while live, `▾` once
 * done), with each call on one line and its outcome in a right-hand column:
 *
 *   ▾ 3 tool calls · 1.4s
 *   ├─ ● Read    agent/skills/pi-config-sync/SKILL.md   115 lines
 *   ├─ ● Run     $ ls -la ~/dotfiles/config/pi/           14 lines
 *   └─ ● Search  "defaultTools" in agent/settings.json    18 results
 *
 * The header only says what the rows cannot: how many, how long overall, and
 * how many failed. Calls from consecutive assistant messages group too, as
 * long as nothing visible sits between them.
 */
export function renderRun(run: ToolRow[], theme: ThemeLike, width: number): Fragment[] {
	const render = (r: ToolRow, w: number) => (r as unknown as { render(x: number): string[] }).render(w);

	const pad = inset();

	/** One call as a bulleted row; continuation lines align under the text. */
	const bulleted = (r: ToolRow): string[] => {
		GROUPED.delete(r as unknown as object);
		// An expanded (ctrl+o) row is a frame — or pi's box — which carries its
		// own chrome. A bullet there sat alone on the box's blank first line.
		if (r.expanded) return render(r, Math.max(8, width - pad.length)).map((l) => (l ? pad + l : l));
		const lines = render(r, Math.max(8, width - pad.length - 2));
		const lead = LEAD_LINES.get(r) ?? 0;
		return lines.map((l, idx) =>
			idx < lead ? `${pad}${l}` : idx === lead ? `${pad}${bullet(r, theme)} ${l}` : `${pad}  ${l}`,
		);
	};

	// Batch members that render nothing (a commit's siblings) neither count
	// nor take a tree slot.
	const shown = run.filter((r) => {
		try {
			return !summarize(r).hidden;
		} catch {
			return true;
		}
	});
	if (shown.length < 2) {
		return run.map((row) => ({ lines: bulleted(row), source: row }));
	}

	// Rows first: drawing a row is what stamps its end time, which the
	// header's total needs on the very frame the group finishes. Each row's
	// lines keep that row as their click target, so a click still opens one
	// call inside the turn.
	const body: Fragment[] = [];
	const branch = (s: string) => paint(theme, "rule", s);
	const verbPad = Math.max(0, ...shown.map((r) => summarize(r).verb.length));
	// Every row draws through its own render(), so the verb column is passed
	// down through the row module instead of per call.
	padVerbs(verbPad, () => {
		shown.forEach((child, idx) => {
			const last = idx === shown.length - 1;
			const fork = branch(last ? "└─ " : "├─ ");
			const trunk = branch(last ? "   " : "│  ");
			const node = child as unknown as object;
			GROUPED.add(node);
			if (child.expanded) {
				// A frame brings its own chrome; just hang it off the tree.
				const framed = render(child, Math.max(8, width - pad.length - 3)).map(
					(line, li) => pad + (li === 0 ? fork : trunk) + line,
				);
				if (framed.length > 0) body.push({ lines: framed, source: child });
				return;
			}
			const lines = render(child, Math.max(8, width - pad.length - 5));
			const callLine = LEAD_LINES.get(child) ?? 0;
			const drawn = lines.map((line, li) => {
				// A `# remark` sits above its call, on the trunk it belongs to.
				const lead =
					li < callLine
						? branch("│  ")
						: li === callLine
							? `${fork}${bullet(child, theme)} `
							: `${trunk}  `;
				return pad + lead + line;
			});
			if (drawn.length > 0) body.push({ lines: drawn, source: child });
		});
	});

	// ── header ──────────────────────────────────────────────────────────────
	const running = shown.some((r) => r.isPartial);
	const failures = shown.filter((r) => r.result?.isError === true).length;
	const sep = paint(theme, "fact", " · ");
	const starts = shown
		.map((r) => RUN_STARTS.get(r as unknown as object))
		.filter((s): s is number => s !== undefined);
	const first = starts.length > 0 ? Math.min(...starts) : undefined;
	let clock = "";
	if (first !== undefined) {
		if (running) {
			if (Date.now() - first >= DURATION_AFTER_MS) clock = durationLabel(Date.now() - first);
		} else {
			// Wall time of the whole group. A member with no stamps finished
			// before it was ever drawn running, so it cannot be the last one.
			const ends = shown
				.map((r) => RUN_ENDS.get(r as unknown as object))
				.filter((e): e is number => e !== undefined);
			const total = ends.length > 0 ? Math.max(...ends) - first : 0;
			if (total >= DURATION_AFTER_MS) clock = durationLabel(total);
		}
	}

	const mark = running
		? theme.fg(pulseOn() ? "warning" : "dim", glyph.bullet)
		: paint(theme, "fact", glyph.open);
	let header = `${pad}${mark} ${paint(theme, "fact", `${shown.length} tool calls`)}`;
	if (running) header += sep + paint(theme, "live", "running");
	if (clock) header += sep + paint(theme, "fact", clock);
	if (failures > 0) header += sep + theme.fg("error", `${failures} failed`);

	return [{ lines: [truncateToWidth(header, width)], source: NOWHERE }, ...body];
}
