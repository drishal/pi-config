/**
 * Pure routing policy for router/auto. No pi imports — unit tests run this
 * with `node --experimental-strip-types --test`.
 *
 * Hard rules first, then a task guess (heuristic or Jev), then a walk of the
 * configured first/fallback lists. The extension (index.ts) supplies catalog
 * availability, Jev's answer, and the clock.
 */

export type TaskKind =
	| "render_loop"
	| "routine_fix"
	| "hard_debug"
	| "ui_review"
	| "long_context"
	| "micro";

export type RouteCause = "user" | "continuation" | "retry" | "direct";

export type DecisionVia =
	| "explicit"
	| "heuristic"
	| "jev"
	| "sticky"
	| "retry"
	| "direct"
	| "pin"
	| "subagent-pin"
	| "default";

export interface HardDebugConfig {
	/** Inclusive last day of the GLM-5.3 OpenCode Go promo, YYYY-MM-DD, Asia/Calcutta. */
	promoUntil: string;
	duringPromo: string;
	afterPromo: string;
	afterPromoEscalate: string;
}

export interface TaskTargets {
	first: string[];
	fallback: string[];
}

export interface RouterConfig {
	hardDebug: HardDebugConfig;
	tasks: Record<TaskKind, TaskTargets>;
	never: string[];
	/** Avoid unless the user named the model, or a harder task has no other choice. */
	lowCap: string[];
	visionPreferred: string[];
	/** Models treated as 1M-class for long-context routing (ids, not windows). */
	longContextPreferred: string[];
	/** Character count (all message text) above which we prefer 1M-class models. */
	largeContextChars: number;
	jev: {
		provider: string;
		id: string;
		timeoutMs: number;
		promptChars: number;
		confidenceFloor: number;
	};
	/** Optional per-type pins: "Explore" -> "provider/id". Empty by default. */
	subagentPins: Record<string, string>;
	deepSeekPeak: {
		/** Substring match against "provider/id", case-insensitive. */
		idIncludes: string[];
		/** Weekday windows in Asia/Calcutta, HH:MM 24h, start inclusive, end exclusive. */
		windowsIst: [string, string][];
	};
}

export interface ModelMeta {
	contextWindow: number;
	images: boolean;
}

export interface RouteInput {
	reason: RouteCause;
	prompt: string;
	hasImages: boolean;
	contextChars: number;
	previousId?: string;
	failedId?: string;
	failedError?: string;
	now: Date;
	/** "free" | "hard" | a "provider/id". */
	pin?: string;
	subagentType?: string;
	available: ReadonlySet<string>;
	modelMeta: Readonly<Record<string, ModelMeta>>;
	/** Set when Jev was asked. Absent means "not called". */
	jev?: { task: TaskKind; confidence: number } | { error: string };
	/** Test/debug: skip heuristics and wait for Jev (or default if Jev is missing). */
	forceJev?: boolean;
	/** Task recorded on the previous route of this session branch, used on retry. */
	previousTask?: TaskKind;
}

export interface RouteDecision {
	model: string;
	task: TaskKind;
	via: DecisionVia;
	reasons: string[];
	skipped: string[];
}

export const TASKS: TaskKind[] = [
	"render_loop",
	"routine_fix",
	"hard_debug",
	"ui_review",
	"long_context",
	"micro",
];

export function isTaskKind(value: string): value is TaskKind {
	return (TASKS as string[]).includes(value);
}

/** Promo is active through the end of `promoUntil` in Asia/Calcutta. */
export function promoActive(promoUntil: string, now: Date): boolean {
	const end = new Date(`${promoUntil}T23:59:59.999+05:30`);
	if (Number.isNaN(end.getTime())) return false;
	return now.getTime() <= end.getTime();
}

export function hardDebugFirst(cfg: RouterConfig, now: Date): string {
	return promoActive(cfg.hardDebug.promoUntil, now)
		? cfg.hardDebug.duringPromo
		: cfg.hardDebug.afterPromo;
}

export function isDeepSeekPeak(now: Date, windowsIst: [string, string][]): boolean {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: "Asia/Calcutta",
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(now);
	const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
	if (["Sat", "Sun"].includes(weekday)) return false;
	const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
	const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
	const mins = hour * 60 + minute;
	return windowsIst.some(([start, end]) => {
		const a = parseHm(start);
		const b = parseHm(end);
		return mins >= a && mins < b;
	});
}

function parseHm(hm: string): number {
	const [h, m] = hm.split(":").map((n) => Number(n));
	return (h || 0) * 60 + (m || 0);
}

const RATE_LIMIT = /429|rate.?limit|quota|overloaded|resource.?exhausted|too many requests|capacity|temporarily unavailable/i;
const CONTEXT_OVERFLOW = /context (length|window|overflow)|too many tokens|maximum context|prompt is too long/i;

export function isRetryableError(message: string | undefined): boolean {
	if (!message) return false;
	return RATE_LIMIT.test(message) || CONTEXT_OVERFLOW.test(message);
}

export function isContextOverflow(message: string | undefined): boolean {
	return !!message && CONTEXT_OVERFLOW.test(message);
}

/** Guess a task from the latest user prompt. Undefined = ask Jev (or default). */
export function heuristicTask(
	prompt: string,
	hasImages: boolean,
): { task: TaskKind; confidence: number; why: string } | undefined {
	const text = prompt.trim();
	const lower = text.toLowerCase();

	if (hasImages) {
		return { task: "ui_review", confidence: 0.9, why: "the turn includes images" };
	}

	if (
		/\b(flicker|garbled|artifact|typecheck|vitest|render(?:ing)? loop|test loop|run the tests|npm test|npm run test)\b/i.test(
			text,
		)
	) {
		return { task: "render_loop", confidence: 0.85, why: "test/render-loop wording" };
	}

	if (
		/\b(hard debug|root[- ]cause|heisenbug|race condition|architecture|subtle bug|cross-cutting)\b/i.test(
			text,
		)
	) {
		return { task: "hard_debug", confidence: 0.8, why: "hard-debug wording" };
	}

	if (
		/\b(screenshot|ui review|visual(?:ly)? review|look at this (?:ui|screen|layout|component))\b/i.test(
			text,
		)
	) {
		return { task: "ui_review", confidence: 0.8, why: "UI-review wording" };
	}

	if (
		/\b(whole (?:codebase|repo|tree)|large (?:codebase|repo|tree)|million[- ]token|long[- ]context)\b/i.test(
			text,
		)
	) {
		return { task: "long_context", confidence: 0.8, why: "long-context wording" };
	}

	if (text.length > 0 && text.length <= 80 && /^(ok|okay|thanks|thank you|ping|hi|hello|yes|no|yep|nope)[!.]?$/i.test(text)) {
		return { task: "micro", confidence: 0.9, why: "tiny chit-chat" };
	}

	if (
		/\b(reply with (?:the )?(?:single|one) word|say (?:just )?ok|one-word (?:reply|answer))\b/i.test(
			text,
		)
	) {
		return { task: "micro", confidence: 0.9, why: "one-word / micro request" };
	}

	if (/\b(fix|bug|typo|regression|failing test|doesn't compile|does not compile)\b/i.test(text) && lower.length < 4000) {
		return { task: "routine_fix", confidence: 0.7, why: "routine-fix wording" };
	}

	return undefined;
}

const EXPLICIT =
	/\b(?:use|switch(?:\s+to)?|route(?:\s+to)?|run(?:ning)?\s+(?:on|with)|model)\s+([a-z0-9._-]+(?:\/[a-z0-9._:/-]+)?)/gi;

const ALIASES: [RegExp, string][] = [
	[/\bflint(?:-v1\.0)?(?::free)?\b/i, "command-code/recursive/flint-v1.0:free"],
	[/\bglyph-cluster\b/i, "command-code/stealth/glyph-cluster:free"],
	[/\bbeam-free\b/i, "opencode-go/beam-free"],
	[/\blongcat-2\.5-free\b/i, "opencode-go/longcat-2.5-free"],
	[/\bglm-?5\.3-flash\b/i, "opencode-go/glm-5.3-flash"],
	[/\bglm\s*5\.3\s*flash\b/i, "opencode-go/glm-5.3-flash"],
	[/\bopencode-go\/glm-5\.3\b/i, "opencode-go/glm-5.3"],
	[/\bcommand-code\/zai-org\/GLM-5\.3\b/i, "command-code/zai-org/GLM-5.3"],
	[/\bcommand-code\/z-ai\/glm-5\.3-flash\b/i, "command-code/z-ai/glm-5.3-flash"],
	[/\bdeepseek-v4\.1-flash\b/i, "opencode-go/deepseek-v4.1-flash"],
];

export function explicitModel(prompt: string, available: ReadonlySet<string>): string | undefined {
	const mentioned: string[] = [];
	for (const match of prompt.matchAll(EXPLICIT)) {
		const raw = match[1];
		if (!raw) continue;
		if (available.has(raw)) mentioned.push(raw);
		else {
			const hit = [...available].find((id) => id === raw || id.endsWith(`/${raw}`) || id.split("/")[1] === raw);
			if (hit) mentioned.push(hit);
		}
	}
	if (mentioned.length) return mentioned[mentioned.length - 1];

	// Bare aliases, last match wins, longer patterns already ordered with flash before full GLM.
	let found: string | undefined;
	for (const [re, id] of ALIASES) {
		if (re.test(prompt) && available.has(id)) found = id;
	}
	// "use glm-5.3" without flash: only if they didn't also say flash (flash alias runs too).
	if (/\bglm-?5\.3\b/i.test(prompt) && !/\bflash\b/i.test(prompt) && available.has("opencode-go/glm-5.3")) {
		found = "opencode-go/glm-5.3";
	}
	return found;
}

export function decide(cfg: RouterConfig, input: RouteInput): RouteDecision {
	const reasons: string[] = [];
	const skipped: string[] = [];
	const peak = isDeepSeekPeak(input.now, cfg.deepSeekPeak.windowsIst);
	if (peak) reasons.push("DeepSeek 2x peak window (Asia/Calcutta) — skip DeepSeek first");

	const constraints = {
		cfg,
		input,
		peak,
		needImages: input.hasImages,
		needLong: input.contextChars >= cfg.largeContextChars,
		skipped,
	};

	if (input.reason === "continuation" && input.previousId) {
		const keep = accept(input.previousId, constraints, { allowLowCap: true, allowPeak: true });
		if (keep) {
			return {
				model: input.previousId,
				task: inferTaskFromModel(cfg, input.previousId, input.now) ?? "routine_fix",
				via: "sticky",
				reasons: ["sticky on tool-follow-up / continuation to keep the prompt cache", ...reasons],
				skipped,
			};
		}
		reasons.push(`previous ${input.previousId} is no longer usable — re-routing`);
	}

	if (input.reason === "direct") {
		const task: TaskKind = "micro";
		const model = pick(chain(cfg, task, input.now), constraints, input.failedId);
		return finish(model, task, "direct", ["request is outside the agent loop (compaction / direct)", ...reasons], skipped);
	}

	const pin = input.pin?.trim();
	if (pin && pin !== "auto" && pin !== "off") {
		if (pin === "free") {
			const model = pick(chain(cfg, "render_loop", input.now), constraints, input.failedId);
			return finish(model, "render_loop", "pin", ["pinned to free/cheap (render_loop)", ...reasons], skipped);
		}
		if (pin === "hard") {
			const task: TaskKind = "hard_debug";
			const model = pick(hardChain(cfg, input.now, input.reason === "retry"), constraints, input.failedId);
			return finish(model, task, "pin", ["pinned to hard_debug", ...reasons], skipped);
		}
		if (pin.includes("/")) {
			const model = accept(pin, constraints, { allowLowCap: true, allowPeak: true })
				? pin
				: pick(chain(cfg, "routine_fix", input.now), constraints, input.failedId);
			return finish(
				model,
				inferTaskFromModel(cfg, model, input.now) ?? "routine_fix",
				"pin",
				[`pinned to ${pin}`, ...reasons],
				skipped,
			);
		}
	}

	if (input.subagentType && cfg.subagentPins[input.subagentType]) {
		const pinned = cfg.subagentPins[input.subagentType];
		const model = accept(pinned, constraints, { allowLowCap: true, allowPeak: false })
			? pinned
			: pick(chain(cfg, "routine_fix", input.now), constraints, input.failedId);
		return finish(
			model,
			inferTaskFromModel(cfg, model, input.now) ?? "routine_fix",
			"subagent-pin",
			[`subagent type ${input.subagentType} pinned to ${pinned}`, ...reasons],
			skipped,
		);
	}

	const named = explicitModel(input.prompt, input.available);
	if (named && !cfg.never.includes(named)) {
		const model = accept(named, constraints, { allowLowCap: true, allowPeak: true })
			? named
			: pick(chain(cfg, "routine_fix", input.now), constraints, input.failedId);
		return finish(
			model,
			inferTaskFromModel(cfg, model, input.now) ?? "routine_fix",
			"explicit",
			[`user named ${named}`, ...reasons],
			skipped,
		);
	}
	if (named && cfg.never.includes(named)) {
		reasons.push(`refusing explicit ${named} (training / contributor model)`);
	}

	let task: TaskKind = "routine_fix";
	let via: DecisionVia = "default";

	if (input.reason === "retry" && input.failedId) {
		reasons.push(`retry after failure of ${input.failedId}${input.failedError ? `: ${input.failedError.slice(0, 160)}` : ""}`);
		const previousTask = input.previousTask ?? inferTaskFromModel(cfg, input.failedId, input.now) ?? "routine_fix";
		const escalate = previousTask === "hard_debug" || /low.?quality|poor quality|not following|looping/i.test(input.failedError ?? "");
		const list = escalate
			? hardChain(cfg, input.now, true)
			: chain(cfg, previousTask, input.now);
		if (isContextOverflow(input.failedError)) constraints.needLong = true;
		const model = pick(list, constraints, input.failedId);
		return finish(model, previousTask, "retry", reasons, skipped);
	}

	const guessed = input.forceJev ? undefined : heuristicTask(input.prompt, input.hasImages);
	if (guessed && guessed.confidence >= 0.7) {
		task = guessed.task;
		via = "heuristic";
		reasons.unshift(`heuristic: ${guessed.why} (confidence ${guessed.confidence})`);
	} else if (input.jev && "task" in input.jev) {
		if (input.jev.confidence >= cfg.jev.confidenceFloor) {
			task = input.jev.task;
			via = "jev";
			reasons.unshift(`Jev chose ${input.jev.task} (confidence ${input.jev.confidence.toFixed(2)})`);
		} else {
			task = guessed?.task ?? "routine_fix";
			via = guessed ? "heuristic" : "default";
			reasons.unshift(
				`Jev confidence ${input.jev.confidence.toFixed(2)} below ${cfg.jev.confidenceFloor} — ${via === "heuristic" ? "keeping the heuristic" : "defaulting to routine_fix"}`,
			);
		}
	} else if (input.jev && "error" in input.jev) {
		task = guessed?.task ?? "routine_fix";
		via = guessed ? "heuristic" : "default";
		reasons.unshift(`Jev failed (${input.jev.error}) — fail open to ${via}`);
	} else if (guessed) {
		task = guessed.task;
		via = "heuristic";
		reasons.unshift(`heuristic: ${guessed.why} (confidence ${guessed.confidence})`);
	} else {
		task = "routine_fix";
		via = "default";
		reasons.unshift("no heuristic or Jev answer — default to routine_fix");
	}

	if (constraints.needLong && task !== "hard_debug") {
		task = task === "ui_review" ? "ui_review" : "long_context";
		reasons.push(`context is large (${input.contextChars} chars) — prefer 1M-class models`);
	}
	if (input.hasImages && task !== "ui_review") {
		// Keep the task, but pick() will require vision.
		reasons.push("images present — only vision-capable models");
	}

	const list = task === "hard_debug" ? hardChain(cfg, input.now, false) : chain(cfg, task, input.now);
	const model = pick(list, constraints, input.failedId);
	return finish(model, task, via, reasons, skipped);
}

function finish(
	model: string,
	task: TaskKind,
	via: DecisionVia,
	reasons: string[],
	skipped: string[],
): RouteDecision {
	return { model, task, via, reasons, skipped };
}

function chain(cfg: RouterConfig, task: TaskKind, now: Date): string[] {
	if (task === "hard_debug") return hardChain(cfg, now, false);
	const t = cfg.tasks[task];
	return unique([...(t?.first ?? []), ...(t?.fallback ?? [])]);
}

function hardChain(cfg: RouterConfig, now: Date, escalate: boolean): string[] {
	const first = hardDebugFirst(cfg, now);
	const extra = escalate || !promoActive(cfg.hardDebug.promoUntil, now)
		? [cfg.hardDebug.afterPromoEscalate]
		: [];
	const t = cfg.tasks.hard_debug;
	return unique([first, ...(t?.first ?? []), ...extra, ...(t?.fallback ?? []), cfg.hardDebug.afterPromo, cfg.hardDebug.afterPromoEscalate]);
}

type Constraints = {
	cfg: RouterConfig;
	input: RouteInput;
	peak: boolean;
	needImages: boolean;
	needLong: boolean;
	skipped: string[];
};

function pick(ids: string[], c: Constraints, failedId?: string): string {
	const rest = failedId ? ids.filter((id) => id !== failedId) : ids;
	for (const id of rest) {
		if (accept(id, c, { allowLowCap: false, allowPeak: false })) return id;
	}
	// Relax low-cap, then peak, then vision if nothing else is left.
	for (const id of rest) {
		if (accept(id, c, { allowLowCap: true, allowPeak: false })) return id;
	}
	for (const id of rest) {
		if (accept(id, c, { allowLowCap: true, allowPeak: true })) return id;
	}
	for (const id of [...c.input.available]) {
		if (accept(id, c, { allowLowCap: true, allowPeak: true, allowAny: true })) return id;
	}
	// Last resort: first available, even if we would rather not.
	const any = [...c.input.available].find((id) => !c.cfg.never.includes(id));
	if (any) {
		c.skipped.push(`fell through to ${any}`);
		return any;
	}
	throw new Error("model-router: no available models");
}

function accept(
	id: string,
	c: Constraints,
	opts: { allowLowCap: boolean; allowPeak: boolean; allowAny?: boolean },
): boolean {
	const skip = (why: string) => {
		if (!c.skipped.includes(`${id}: ${why}`)) c.skipped.push(`${id}: ${why}`);
		return false;
	};
	if (!c.input.available.has(id)) return skip("not in catalog / no credentials");
	if (c.cfg.never.includes(id)) return skip("never (training / contributor)");
	if (!opts.allowAny && c.needImages) {
		const meta = c.input.modelMeta[id];
		if (meta && !meta.images) return skip("no image input");
		// If we have no meta, be conservative and only allow visionPreferred.
		if (!meta && !c.cfg.visionPreferred.includes(id)) return skip("unknown image support");
	}
	if (!opts.allowAny && c.needLong) {
		const meta = c.input.modelMeta[id];
		const preferred = c.cfg.longContextPreferred.includes(id);
		if (meta && meta.contextWindow < 900_000 && !preferred) return skip(`context window ${meta.contextWindow} < 1M`);
	}
	if (!opts.allowLowCap && c.cfg.lowCap.includes(id)) return skip("low-cap ($15-class) — skip unless needed");
	if (!opts.allowPeak && c.peak && c.cfg.deepSeekPeak.idIncludes.some((s) => id.toLowerCase().includes(s.toLowerCase()))) {
		return skip("DeepSeek peak hours");
	}
	return true;
}

function inferTaskFromModel(cfg: RouterConfig, id: string, now: Date): TaskKind | undefined {
	if (
		id === hardDebugFirst(cfg, now) ||
		id === cfg.hardDebug.afterPromo ||
		id === cfg.hardDebug.afterPromoEscalate
	) {
		return "hard_debug";
	}
	for (const task of TASKS) {
		if (cfg.tasks[task].first.includes(id)) return task;
	}
	for (const task of TASKS) {
		if (cfg.tasks[task].fallback.includes(id)) return task;
	}
	return undefined;
}

function unique(ids: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of ids) {
		if (!id || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}
