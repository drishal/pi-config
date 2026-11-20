/**
 * Pure routing policy for router/auto. No pi imports — unit tests run this
 * with `node --experimental-strip-types --test`.
 *
 * Hard safety filters live here. Task fit, cost, promo dates, and peak
 * windows are described in router.md and decided by the configured decider
 * (Jev, another classifier, or a chat model). Retry / sticky / direct / pin
 * paths do not wait on the decider.
 */
import type { MechanicsConfig, RouterPolicy } from "./parse.ts";
import { isJevModelId } from "./tokens.ts";

export type RouteCause = "user" | "continuation" | "retry" | "direct";

export type DecisionVia =
	| "explicit"
	| "jev"
	| "classifier"
	| "chat"
	| "sticky"
	| "retry"
	| "direct"
	| "pin"
	| "subagent-pin"
	| "fallback"
	| "single";

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
	/** Set when the decider was asked. Absent means "not called". */
	decider?:
		| { choice: string; confidence: number; via: "jev" | "classifier" | "chat" }
		| { error: string };
}

export interface RouteDecision {
	model: string;
	via: DecisionVia;
	reasons: string[];
	skipped: string[];
	candidates: string[];
}

export interface PreRoute {
	final?: RouteDecision;
	candidates: string[];
	reasons: string[];
	skipped: string[];
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

const EXPLICIT =
	/\b(?:use|switch(?:\s+to)?|route(?:\s+to)?|run(?:ning)?\s+(?:on|with)|model)\s+([a-z0-9._-]+(?:\/[a-z0-9._:/-]+)?)/gi;

export function explicitModel(prompt: string, ids: readonly string[]): string | undefined {
	const mentioned: string[] = [];
	for (const match of prompt.matchAll(EXPLICIT)) {
		const raw = match[1];
		if (!raw) continue;
		const hit = resolveMention(raw, ids);
		if (hit) mentioned.push(hit);
	}
	if (mentioned.length) return mentioned[mentioned.length - 1];

	// Unique aliases derived from the policy list (last match wins).
	// Longer keys first so "glm-5.3-flash" beats "glm-5.3" / "flint-v1.0:free" beats "flint".
	const keys: [string, string][] = [];
	for (const id of ids) {
		for (const key of aliasKeys(id)) keys.push([key, id]);
	}
	keys.sort((a, b) => b[0].length - a[0].length);
	let found: string | undefined;
	const lower = prompt.toLowerCase();
	for (const [key, id] of keys) {
		if (key.length < 4) continue;
		const re = new RegExp(`\\b${escapeRe(key)}\\b`, "i");
		if (re.test(prompt)) {
			const hits = ids.filter((candidate) => aliasKeys(candidate).includes(key));
			found = hits.length === 1 ? hits[0]! : firstInList(ids, hits);
		}
	}
	// "glm-5.3" without "flash" should not be stolen by a -flash short name if
	// a non-flash id is also in the list and the prompt has no "flash".
	if (/\bglm-?5\.3\b/i.test(prompt) && !/\bflash\b/i.test(lower)) {
		const full = ids.find((id) => /glm-5\.3$/i.test(id) || /GLM-5\.3$/.test(id));
		if (full) found = full;
	}
	return found;
}

function shortName(id: string): string {
	const slash = id.lastIndexOf("/");
	return (slash >= 0 ? id.slice(slash + 1) : id).toLowerCase();
}

function aliasKeys(id: string): string[] {
	const short = shortName(id);
	const noFree = short.replace(/:free$/, "");
	const keys = new Set<string>([short, noFree]);
	const first = noFree.split(/[-_/]/)[0];
	if (first && first.length >= 4 && first !== "free") keys.add(first);
	return [...keys];
}

function resolveMention(raw: string, ids: readonly string[]): string | undefined {
	if (ids.includes(raw)) return raw;
	const lower = raw.toLowerCase();
	const hits = ids.filter((id) => {
		if (id === raw || id.endsWith(`/${raw}`)) return true;
		if (id.split("/").slice(1).join("/") === raw) return true;
		return aliasKeys(id).includes(lower);
	});
	if (hits.length === 1) return hits[0];
	if (hits.length > 1) return firstInList(ids, hits);
	return undefined;
}

function escapeRe(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstInList(order: readonly string[], ids: readonly string[]): string {
	for (const id of order) if (ids.includes(id)) return id;
	return ids[0]!;
}

export function hardFilter(
	policy: RouterPolicy,
	input: Pick<RouteInput, "hasImages" | "contextChars" | "available" | "modelMeta">,
	mechanics: MechanicsConfig,
): { candidates: string[]; skipped: string[] } {
	const skipped: string[] = [];
	const checkCatalog = input.available.size > 0;
	let kept: string[] = [];
	for (const model of policy.models) {
		if (!model.id) continue;
		if (model.trains && !model.allowTrains) {
			skipped.push(`${model.id} (trains-on-data / contributor)`);
			continue;
		}
		if (checkCatalog && !input.available.has(model.id)) {
			skipped.push(`${model.id} (not in catalog / no credentials)`);
			continue;
		}
		if (input.hasImages) {
			const catalogImages = input.modelMeta[model.id]?.images ?? false;
			if (!model.images && !catalogImages) {
				skipped.push(`${model.id} (no vision)`);
				continue;
			}
		}
		kept.push(model.id);
	}

	const needLong = input.contextChars >= mechanics.largeContextChars;
	if (needLong) {
		const longEnough = kept.filter((id) => {
			const window = policy.models.find((m) => m.id === id)?.contextWindow || input.modelMeta[id]?.contextWindow || 0;
			return window >= 900_000;
		});
		if (longEnough.length) {
			for (const id of kept) {
				if (!longEnough.includes(id)) skipped.push(`${id} (context window too small for this transcript)`);
			}
			kept = longEnough;
		}
	}
	return { candidates: kept, skipped };
}

export function walkOrder(policy: RouterPolicy, candidates: readonly string[], skip?: string): string | undefined {
	const allow = new Set(candidates);
	const order = [...policy.defaults.order, ...policy.models.map((m) => m.id)];
	const seen = new Set<string>();
	for (const id of order) {
		if (!id || seen.has(id)) continue;
		seen.add(id);
		if (id === skip) continue;
		if (allow.has(id)) return id;
	}
	return undefined;
}

function finish(
	model: string,
	via: DecisionVia,
	reasons: string[],
	skipped: string[],
	candidates: string[],
): RouteDecision {
	return { model, via, reasons, skipped, candidates };
}

function pinTarget(policy: RouterPolicy, pin: string): string | undefined {
	if (pin === "free") return policy.defaults.pinFree ?? policy.defaults.direct ?? walkOrder(policy, policy.models.map((m) => m.id));
	if (pin === "hard") return policy.defaults.pinHard ?? policy.defaults.fallback;
	if (pin.includes("/")) return pin;
	return undefined;
}

export function preRoute(policy: RouterPolicy, mechanics: MechanicsConfig, input: RouteInput): PreRoute {
	const { candidates, skipped } = hardFilter(policy, input, mechanics);
	const reasons: string[] = [];

	const pickOrFallback = (preferred: string | undefined, via: DecisionVia, why: string): RouteDecision => {
		const model =
			(preferred && candidates.includes(preferred) ? preferred : undefined) ||
			walkOrder(policy, candidates) ||
			policy.defaults.fallback;
		const extra = preferred && model !== preferred ? ` (${preferred} was not a surviving candidate)` : "";
		return finish(model, via, [why + extra, ...reasons], skipped, candidates);
	};

	if (input.reason === "continuation" && input.previousId) {
		if (candidates.includes(input.previousId)) {
			return {
				final: finish(
					input.previousId,
					"sticky",
					["sticky on tool-follow-up / continuation to keep the prompt cache", ...reasons],
					skipped,
					candidates,
				),
				candidates,
				reasons,
				skipped,
			};
		}
		reasons.push(`previous ${input.previousId} is no longer usable — re-routing`);
	}

	if (input.reason === "direct") {
		const target = policy.defaults.direct;
		return {
			final: pickOrFallback(target, "direct", "request is outside the agent loop (compaction / direct)"),
			candidates,
			reasons,
			skipped,
		};
	}

	const pin = input.pin?.trim();
	if (pin && pin !== "auto" && pin !== "off" && pin !== "unpin") {
		const target = pinTarget(policy, pin);
		return {
			final: pickOrFallback(target, "pin", `pinned to ${pin}`),
			candidates,
			reasons,
			skipped,
		};
	}

	if (input.subagentType && mechanics.subagentPins[input.subagentType]) {
		const pinned = mechanics.subagentPins[input.subagentType];
		return {
			final: pickOrFallback(pinned, "subagent-pin", `subagent type ${input.subagentType} pinned to ${pinned}`),
			candidates,
			reasons,
			skipped,
		};
	}

	const named = explicitModel(input.prompt, policy.models.map((m) => m.id));
	if (named) {
		const model = policy.models.find((m) => m.id === named);
		if (model?.trains && !model.allowTrains) {
			reasons.push(`refusing explicit ${named} (training / contributor model)`);
		} else {
			return {
				final: pickOrFallback(named, "explicit", `user named ${named}`),
				candidates,
				reasons,
				skipped,
			};
		}
	}

	if (input.reason === "retry" && input.failedId) {
		reasons.push(
			`retry after failure of ${input.failedId}${input.failedError ? `: ${input.failedError.slice(0, 160)}` : ""} (no decider wait)`,
		);
		if (isContextOverflow(input.failedError)) {
			const longer = hardFilter(policy, { ...input, contextChars: Math.max(input.contextChars, mechanics.largeContextChars) }, mechanics);
			const model = walkOrder(policy, longer.candidates, input.failedId) ?? walkOrder(policy, candidates, input.failedId) ?? policy.defaults.fallback;
			return {
				final: finish(model, "retry", reasons, [...skipped, ...longer.skipped], longer.candidates),
				candidates: longer.candidates,
				reasons,
				skipped,
			};
		}
		const model = walkOrder(policy, candidates, input.failedId) ?? policy.defaults.fallback;
		return {
			final: finish(model, "retry", reasons, skipped, candidates),
			candidates,
			reasons,
			skipped,
		};
	}

	if (candidates.length === 1) {
		return {
			final: finish(candidates[0]!, "single", ["only one candidate survived hard filters", ...reasons], skipped, candidates),
			candidates,
			reasons,
			skipped,
		};
	}

	if (candidates.length === 0) {
		return {
			final: finish(
				policy.defaults.fallback,
				"fallback",
				["no candidates survived hard filters — using defaults.fallback", ...reasons],
				skipped,
				candidates,
			),
			candidates,
			reasons,
			skipped,
		};
	}

	return { candidates, reasons, skipped };
}

export function applyDecider(
	policy: RouterPolicy,
	pre: PreRoute,
	decider: NonNullable<RouteInput["decider"]>,
	confidenceFloor: number,
): RouteDecision {
	const { candidates, reasons, skipped } = pre;
	if ("error" in decider) {
		const model = walkOrder(policy, candidates) ?? policy.defaults.fallback;
		return finish(
			model,
			"fallback",
			[`decider failed (${decider.error}) — falling open to ${model}`, ...reasons],
			skipped,
			candidates,
		);
	}
	if (!candidates.includes(decider.choice)) {
		const model = walkOrder(policy, candidates) ?? policy.defaults.fallback;
		return finish(
			model,
			"fallback",
			[`decider chose ${decider.choice}, which is not a surviving candidate — falling open to ${model}`, ...reasons],
			skipped,
			candidates,
		);
	}
	if (decider.confidence < confidenceFloor) {
		const model =
			(policy.defaults.fallback && candidates.includes(policy.defaults.fallback) && policy.defaults.fallback) ||
			walkOrder(policy, candidates) ||
			decider.choice;
		return finish(
			model,
			"fallback",
			[
				`decider confidence ${decider.confidence.toFixed(2)} below ${confidenceFloor} — falling open to ${model} (no upgrade on low confidence)`,
				...reasons,
			],
			skipped,
			candidates,
		);
	}
	const via: DecisionVia = decider.via === "jev" ? "jev" : decider.via === "classifier" ? "classifier" : "chat";
	return finish(
		decider.choice,
		via,
		[`${via} chose ${decider.choice} (confidence ${decider.confidence.toFixed(2)})`, ...reasons],
		skipped,
		candidates,
	);
}

export function failOpen(policy: RouterPolicy, pre: PreRoute, why: string): RouteDecision {
	const model = walkOrder(policy, pre.candidates) ?? policy.defaults.fallback;
	return {
		model,
		via: "fallback",
		reasons: [why, ...pre.reasons],
		skipped: pre.skipped,
		candidates: pre.candidates,
	};
}

/** @deprecated kept so older comments still grep; Jev is one of several deciders. */
export function isDefaultJev(spec: string): boolean {
	return isJevModelId(spec);
}
