/**
 * turn — the shape of one exchange.
 *
 *   ❯ Read the container patch, then mark the answer.
 *
 *   Let me read the container patch first.
 *   ├─ ● Read   agent/extensions/neat-render/turn.ts   525 lines
 *   └─ ● Search "chatContainer" in modes/interactive     3 results
 *
 *   ◇ Thinking 2.1s
 *      A turn runs from one prompt to the next, so the fold has to live in
 *      Container.render.
 *
 *   ● A turn is the prompt plus everything up to the next prompt.
 *
 *   Σ 2 calls · 1.4s · ~140 thought
 *
 * Nothing is collapsed here: a call is a row, a run of calls is a tree, and
 * the reasoning hangs under its own marker. pi's Ctrl+O still opens every
 * call at full size. Spacing is owned here: exactly one blank line between
 * the prompt, the work and the answer, and none inside the activity block.
 */

import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	keyText,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import {
	type Patchable,
	type RenderFn,
	type ThemeLike,
	type ToolRow,
	fit,
	glyph,
	inset,
	isHovered,
	noteText,
	paint,
	sameKey,
	setHovered,
	state,
} from "./style.ts";
import { summarize } from "./tools.ts";
import { tokenCount } from "./thinking.ts";
import {
	DURATION_AFTER_MS,
	RUN_ENDS,
	RUN_STARTS,
	durationLabel,
} from "./clock.ts";
import { GROUPED, LEAD_LINES, bullet, isBlank, trimBlank } from "./row.ts";

/* ── the prompt: a `❯` quote over a full-width fill strip ──────────────── */

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const OSC133_ZONE_RE = /\x1b\]133;[ABC]\x07/g;
const stripZones = (line: string) => line.replace(OSC133_ZONE_RE, "");

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

		// pi's own Markdown draws the prompt — syntax, links, lists and the
		// registered user-markdown transformers — and paints the fill strip.
		// Taking its lines instead of re-wrapping the raw text keeps all of
		// that; the child only gets the two-column gutter the `❯` sits in.
		const children = (this as unknown as { children?: unknown[] }).children;
		const body = children?.[0] as
			| (Renderable & { paddingX?: number; paddingY?: number; invalidate?(): void })
			| undefined;
		if (!body || typeof body.render !== "function") return original.call(this, width);

		if (body.paddingX !== 2 || body.paddingY !== 0) {
			body.paddingX = 2;
			body.paddingY = 0;
			body.invalidate?.();
		}

		// The `❯` opens the quote once: wrapped lines and later paragraphs
		// keep the gutter and indent under it instead of repeating the marker.
		let opened = false;
		const out = body.render(width).map((line) => {
			if (opened || isBlank(line)) return line;
			// Replace the gutter's first two columns, so the line stays `width`
			// wide and the marker inherits the strip's background.
			const marked = line.replace(/^((?:\x1b\[[0-9;]*m)*) {2}/, `$1${noteText(theme, glyph.prompt)} `);
			if (marked !== line) opened = true;
			return marked;
		});
		if (out.length === 0) return original.call(this, width);

		// Markdown keeps a strip line for every trailing newline; the card ends
		// where the prompt does.
		while (out.length > 1 && isBlank(out[out.length - 1])) out.pop();

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

/** How a message's own text is marked: bare, indented by the answer gutter, or bulleted. */
type Mark = "none" | "gutter" | "bullet";

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
			// A zero-width-only text block is a model placeholder, not an answer.
			const hasText = content.some((c) => c.type === "text" && !isBlank(c.text ?? ""));
			const hasCalls = content.some((c) => c.type === "toolCall");
			// A message that is only reasoning renders no text of its own — but
			// while the turn is live it carries the rolling thought line.
			const hasThinking = content.some((c) => c.type === "thinking" && !isBlank(c.thinking ?? ""));
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
 * One assistant message: pi's own render (so reasoning shows exactly as
 * Ctrl+T says, with its working clicks), the hidden thinking label taken back
 * out, and — for the answer — the accent bullet on the first line of text.
 * While the answer streams it keeps the same gutter with a space where the
 * bullet will land, so its text never re-wraps when the turn finishes.
 *
 * Rendering through the component keeps its internal line count, and therefore
 * pi's mouse hit-testing, exactly right.
 */
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").trim();

/**
 * How many of the message's rendered lines belong to reasoning (and to the
 * blank spacers pi puts around it), i.e. where its own text starts. Worked out
 * from the component's children rather than from the drawn glyphs, because the
 * reasoning body is hung by spaces and cannot be told from a paragraph.
 */
function thinkingPrefix(host: AssistantInternals, width: number): number {
	const kids = host.contentContainer?.children ?? [];
	let count = 0;
	for (const kid of kids) {
		const child = kid as Renderable & { handleMouse?: unknown };
		if (typeof child?.render !== "function") continue;
		const lines = child.render(width);
		const thinking = typeof child.handleMouse === "function";
		// A spacer draws nothing; it belongs to whatever comes next.
		const blank = lines.every(isBlank);
		if (!thinking && !blank) return count;
		count += lines.length;
	}
	return count;
}

function finishedMessageUncached(
	host: AssistantInternals & Renderable,
	theme: ThemeLike,
	width: number,
	mark: Mark,
): string[] {
	const label = host.hiddenThinkingLabel;
	// The answer's gutter: the row inset plus the marker column, before the
	// message's own leading pad. Reserving it while the message streams keeps
	// the text from re-wrapping when the bullet appears at the end.
	const pad = inset();
	const gutter = mark === "none" ? 0 : pad.length + 1;
	const room = mark === "none" ? width : Math.max(8, width - gutter);
	// Which lines are the reasoning's, decided from the component's children
	// before any line is dropped — so filtering and trimming cannot shift it.
	const prefix = thinkingPrefix(host, room);
	type Row = { text: string; thinking: boolean };
	let rows: Row[] = host.render(room).map((text, index) => ({ text, thinking: index < prefix }));
	// With thinking hidden, pi draws a bare label instead of the block.
	if (label) rows = rows.filter((row) => plain(row.text) !== label);
	// A collapsed reasoning run leaves its spacer behind; keep one blank.
	rows = rows.filter((row, index, all) => !(isBlank(row.text) && index > 0 && isBlank(all[index - 1].text)));
	// Drop the blank padding pi puts around a message.
	let from = 0;
	let to = rows.length;
	while (from < to && isBlank(rows[from].text)) from++;
	while (to > from && isBlank(rows[to - 1].text)) to--;
	rows = rows.slice(from, to);

	const dot = mark === "bullet" ? paint(theme, "answer", glyph.bullet) : "";
	let marked = false;
	const out = rows.map((row) => {
		// Reasoning keeps its own shape; the marker lands on the message's own
		// text, and everything from there indents under it.
		if (isBlank(row.text) || row.thinking) return row.text;
		if (mark === "none") return row.text;
		if (mark === "gutter") return `${pad} ${row.text}`;
		if (marked) return `${pad} ${row.text}`;
		marked = true;
		return `${pad}${dot}${row.text}`;
	});
	// pi brackets an assistant message in OSC 133 zones; the prompt carries the
	// pair, so the body drops them. Stripped here, once, because this result is
	// memoized — a turn-level scan would repeat it on every frame.
	return out.map(stripZones);
}

/**
 * Finished messages are memoized the same way their children cache their own
 * lines. A repaint walks the whole transcript, and one finished message costs
 * a double render of its children plus an ANSI scan of every reasoning line;
 * with hundreds of messages that is a large share of a frame. pi rebuilds the
 * content container (replacing its children array) whenever the message, its
 * thinking visibility or the theme changes, so that array is the invalidation
 * key.
 */
type MessageCacheEntry = { key: readonly unknown[]; lines: string[] };
const MESSAGE_CACHE = new WeakMap<object, MessageCacheEntry>();

function finishedMessage(
	host: AssistantInternals & Renderable,
	theme: ThemeLike,
	width: number,
	mark: Mark,
): string[] {
	const hidden = host as unknown as { hideThinkingBlock?: boolean };
	const key = [
		theme,
		width,
		mark,
		host.hiddenThinkingLabel,
		host.isStreaming === true,
		hidden.hideThinkingBlock === true,
		host.contentContainer?.children,
		host.lastMessage,
	] as const;
	const hit = MESSAGE_CACHE.get(host as object);
	if (hit && sameKey(hit.key, key)) return hit.lines;
	const lines = finishedMessageUncached(host, theme, width, mark);
	MESSAGE_CACHE.set(host as object, { key, lines });
	return lines;
}

/* ── patch: turns ──────────────────────────────────────────────────────── */

/** Marks the instance-level mouse fallback installed on the chat container. */
const HOVER_BOUNDARY = Symbol.for("dr.pi.neatRender.hoverBoundary.v1");

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

		// The transcript container is also the mouse fallback: a move that lands
		// on anything other than a row clears the hovered row's glow. Installed
		// on this instance only, so other Containers keep pi's handler.
		const self = this as unknown as {
			handleMouse?: (event: { type?: string }) => unknown;
			[key: symbol]: unknown;
		};
		if (!self[HOVER_BOUNDARY]) {
			const inherited = self.handleMouse;
			const parent = inherited
				? inherited.bind(self)
				: (Container.prototype as unknown as { handleMouse: (event: unknown) => unknown }).handleMouse.bind(self);
			self.handleMouse = (event) => {
				if (event?.type === "move" && setHovered(undefined)) state.renderer?.requestRender?.();
				return parent(event);
			};
			self[HOVER_BOUNDARY] = true;
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
			// A blank line above the prompt separates this turn from the one it
			// follows, the way there is one between the prompt and its work.
			if (i > 0) emit([""], NOWHERE);
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
 * The turn's own stopwatch, per prompt component. Tool rows carry start/end
 * stamps already; a turn that made no calls has no other source for its
 * elapsed time. A replayed turn was never live, so it gets no stopwatch.
 */
const TURN_CLOCK = new WeakMap<object, { start: number; end?: number }>();

function turnElapsed(prompt: object, live: boolean): number | undefined {
	let clock = TURN_CLOCK.get(prompt);
	if (live) {
		if (!clock) {
			clock = { start: Date.now() };
			TURN_CLOCK.set(prompt, clock);
		}
		return undefined;
	}
	if (!clock) return undefined;
	if (clock.end === undefined) clock.end = Date.now();
	return clock.end - clock.start;
}

/**
 * Lay out one turn: prompt, work, answer.
 *
 * Nothing is ever collapsed: the calls show as a tree, the reasoning as its
 * hung block, and the answer carries the accent bullet. This renderer only
 * decides order and spacing — pi still draws every child.
 */
function renderTurn(prompt: Renderable, parts: unknown[], theme: ThemeLike, width: number): Fragment[] {
	const live = isLive(parts);
	const elapsed = turnElapsed(prompt, live);
	const blocks = blocksOf(parts, width, true);

	// The prompt renders first; `push` adds a blank line before the first block,
	// which serves as the prompt → work gap.
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
			// The answer keeps the same two-column gutter while it streams; the
			// bullet replaces the leading space when the turn finishes, so its
			// text never re-wraps.
			const mark: Mark = block.answer ? (live ? "gutter" : "bullet") : "none";
			push(finishedMessage(host, theme, width, mark), block.comp);
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
	// A finished turn closes with its Σ total: the calls, the time, the
	// reasoning — or just the time, when it did no work.
	if (!live) {
		const f = sigmaFooter(blocks, theme, width, elapsed);
		if (f) push(f.lines, f.source);
	}
	// Every assistant message goes through finishedMessage, which strips pi's
	// OSC 133 brackets; the prompt carries the pair for the turn.
	return out;
}

/**
 * The Σ footer: one line under the answer when the turn did measurable work —
 * calls, wall time, reasoning and failures. It is not a tree node, so it uses
 * its own marker instead of the tool `└`.
 *
 *   Σ 3 calls · 7.5s · ~640 thought
 */
function sigmaFooter(
	blocks: Block[],
	theme: ThemeLike,
	width: number,
	elapsed: number | undefined,
): Fragment | undefined {
	const pad = inset();
	const sep = paint(theme, "fact", " · ");
	const mark = paint(theme, "meta", "Σ");
	const parts: string[] = [];

	let calls = 0;
	let expanded = false;
	let failures = 0;
	let first = Number.POSITIVE_INFINITY;
	let last = 0;
	let thoughtChars = 0;
	for (const block of blocks) {
		if (block.kind === "activity") {
			for (const row of block.rows) {
				calls++;
				if (row.result?.isError) failures++;
				if (row.expanded) expanded = true;
				const s = RUN_STARTS.get(row as unknown as object);
				const e = RUN_ENDS.get(row as unknown as object);
				if (s !== undefined && s < first) first = s;
				if (e !== undefined && e > last) last = e;
			}
		} else if (block.kind === "assistant") {
			for (const part of block.comp.lastMessage?.content ?? []) {
				if (part.type === "thinking") thoughtChars += (part.thinking ?? "").length;
			}
		}
	}

	if (calls > 0) parts.push(paint(theme, "fact", `${calls} call${calls === 1 ? "" : "s"}`));
	const span =
		first !== Number.POSITIVE_INFINITY && last > first && last - first >= DURATION_AFTER_MS
			? durationLabel(last - first)
			: undefined;
	// Calls are timed by their own stamps; only a turn without them falls back
	// to the prompt's stopwatch.
	const took = span ?? (elapsed !== undefined && elapsed >= DURATION_AFTER_MS ? durationLabel(elapsed) : undefined);
	if (took) parts.push(paint(theme, "fact", took));
	if (thoughtChars > 0) parts.push(paint(theme, "fact", `~${tokenCount(thoughtChars)} thought`));
	if (failures > 0) parts.push(paint(theme, "fail", `${failures} failed`));
	// One hint per turn, and only while the calls are still compact. Ctrl+O
	// expands every call; clicking a row opens just that one.
	if (calls > 0 && !expanded) {
		const key = keyText("app.tools.expand");
		if (key) parts.push(noteText(theme, `${key} expand`));
	}
	if (parts.length === 0) return undefined;
	return { lines: [fit(`${pad}${mark} ${parts.join(sep)}`, width)], source: NOWHERE };
}

/**
 * Render a run of adjacent tool calls.
 *
 * A lone call is a bulleted row; continuation lines align under its text:
 *
 *   ● Bash $ grep -rniE '(api[_-]?key|secret|token)' .
 *     └ 80 lines
 *
 * Two or more calls fired together hang off a shared tree, each call on one
 * line with its outcome in a right-hand column:
 *
 *   ├─ ● Read    agent/skills/pi-config-sync/SKILL.md   115 lines
 *   ├─ ● Run     $ ls -la ~/dotfiles/config/pi/           14 lines
 *   └─ ● Search  "defaultTools" in agent/settings.json    18 results
 *
 * The tree is the summary: how many is the branch count, and the per-call
 * outcomes sit on their rows. What the rows cannot say — turns' totals,
 * durations, failures — goes on the turn's Σ footer. Calls from consecutive
 * assistant messages group too, as long as nothing visible sits between them.
 */
/**
 * A row's click target. pi routes a click to the component the turn renderer
 * recorded for those lines; a compact row's own child regions never rendered,
 * so the component itself would drop the click. This proxy toggles that row's
 * expanded state instead — the per-call version of Ctrl+O.
 */
const CLICK_TARGETS = new WeakMap<object, unknown>();

function clickTarget(row: ToolRow): unknown {
	const cached = CLICK_TARGETS.get(row as object);
	if (cached) return cached;
	const target = {
		render: () => [],
		handleMouse: (event: { type?: string; button?: string }) => {
			// A pointer over the row lights its margin marker; the transcript
			// container clears it when the pointer moves off the rows.
			if (event?.type === "move") {
				if (setHovered(row as object)) state.renderer?.requestRender?.();
				return { handled: true };
			}
			if (event?.type !== "click" || event.button !== "left") return undefined;
			setHovered(row as object);
			const r = row as { expanded?: boolean };
			r.expanded = !r.expanded;
			state.renderer?.requestRender?.();
			return { handled: true };
		},
	};
	CLICK_TARGETS.set(row as object, target);
	return target;
}

export function renderRun(run: ToolRow[], theme: ThemeLike, width: number): Fragment[] {
	const render = (r: ToolRow, w: number) => (r as unknown as { render(x: number): string[] }).render(w);

	const pad = inset();

	/** The row's inset, with the hover marker in its first column. */
	const leadPad = (r: ToolRow): string =>
		isHovered(r as object) && !r.expanded && pad.length > 0
			? `${paint(theme, "verb", glyph.shut)}${pad.slice(1)}`
			: pad;

	/** One call as a bulleted row; continuation lines align under the text. */
	const bulleted = (r: ToolRow): string[] => {
		GROUPED.delete(r as unknown as object);
		// An expanded (ctrl+o) row is a frame — or pi's box — which carries its
		// own chrome. A bullet there sat alone on the box's blank first line.
		if (r.expanded) return render(r, Math.max(8, width - pad.length)).map((l) => (l ? pad + l : l));
		const lines = render(r, Math.max(8, width - pad.length - 2));
		const lead = LEAD_LINES.get(r) ?? 0;
		const callPad = leadPad(r);
		return lines.map((l, idx) =>
			idx === lead ? `${callPad}${bullet(r, theme)} ${l}` : `${pad}${idx < lead ? "" : "  "}${l}`,
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
		return run.map((row) => ({ lines: bulleted(row), source: clickTarget(row) }));
	}

	// Rows first: drawing a row is what stamps its end time, which the
	// header's total needs on the very frame the group finishes. Each row's
	// lines keep a click target that opens that one call inside the turn.
	const body: Fragment[] = [];
	const branch = (s: string) => paint(theme, "rule", s);
	// Every row draws through its own render(); GROUPED tells each it is hanging
	// off a tree connector so its facts stay on the call line.
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
			if (framed.length > 0) body.push({ lines: framed, source: clickTarget(child) });
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
			const prefix = li === callLine ? leadPad(child) : pad;
			return prefix + lead + line;
		});
		if (drawn.length > 0) body.push({ lines: drawn, source: clickTarget(child) });
	});

	// No header: the tree is the summary. The turn footer (Σ) carries what the
	// rows cannot — totals, durations, failures — once, at the end of the turn.
	return body;
}
