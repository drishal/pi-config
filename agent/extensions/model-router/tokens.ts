/**
 * Conservative token estimates for the router decider's context gate.
 * Dense ids and punctuation often take more tokens than 4 chars each, so we
 * default to 3.25 chars/token and always round up. This is a hard safety
 * bound, not a billing meter.
 *
 * The window is NOT hardcoded at the call site: use resolveRouterContextWindow()
 * (pi registry contextWindow when present; otherwise router.json
 * routerContextWindow; otherwise 32768 for typesafe/jev — commandcode.ai/models/jev).
 */
export const JEV_CONTEXT_TOKENS = 32_768;
export const DEFAULT_CHARS_PER_TOKEN = 3.25;
export const DEFAULT_HEADROOM_TOKENS = 256;

export function estimateTokens(text: string, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
	if (!text) return 0;
	const cpt = charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN;
	return Math.ceil(text.length / cpt);
}

export function splitSpec(spec: string): { provider: string; id: string } | undefined {
	const slash = spec.trim().indexOf("/");
	if (slash <= 0) return undefined;
	return { provider: spec.trim().slice(0, slash), id: spec.trim().slice(slash + 1) };
}

/** Command Code Jev, including the canonical alias `command-code/typesafe/jev`. */
export function isJevModelId(spec: string): boolean {
	const trimmed = spec.trim().toLowerCase();
	if (!trimmed) return false;
	const parts = splitSpec(trimmed);
	const id = parts?.id ?? trimmed;
	if (id === "typesafe/jev" || id.startsWith("typesafe/jev-")) return true;
	return trimmed === "typesafe/jev" || trimmed === "jev";
}

export interface WindowResolution {
	contextTokens: number;
	/** Human-readable origin, shown by /router status and the validator. */
	source: string;
}

/**
 * Pick the decider context window.
 * 1. pi registry contextWindow, when the selected model is registered
 * 2. explicit router.json `routerContextWindow` (used for Jev / any unregistered decider)
 * 3. 32768 default for typesafe/jev (commandcode.ai/models/jev)
 * 4. 32768 conservative default for any other unregistered decider
 */
export function resolveRouterContextWindow(opts: {
	routerModel: string;
	routerContextWindow?: number;
	registryWindow?: number;
}): WindowResolution {
	if (typeof opts.registryWindow === "number" && opts.registryWindow > 0) {
		return {
			contextTokens: opts.registryWindow,
			source: `pi registry contextWindow (${opts.routerModel})`,
		};
	}
	if (typeof opts.routerContextWindow === "number" && opts.routerContextWindow > 0) {
		return {
			contextTokens: opts.routerContextWindow,
			source: "configured routerContextWindow",
		};
	}
	if (isJevModelId(opts.routerModel)) {
		return {
			contextTokens: JEV_CONTEXT_TOKENS,
			source: "default for typesafe/jev (commandcode.ai/models/jev)",
		};
	}
	return {
		contextTokens: JEV_CONTEXT_TOKENS,
		source: "default (unregistered decider; set routerContextWindow in router.json)",
	};
}

export interface BudgetInput {
	/** The markdown (or compact rendering) the decider will see as policy state. */
	policyText: string;
	/** Worst-case user prompt length in characters (usually promptChars). */
	promptChars: number;
	/** The choice question actually sent (criteria for every candidate). */
	questionText: string;
	contextTokens: number;
	headroomTokens?: number;
	charsPerToken?: number;
	windowSource?: string;
}

export interface BudgetResult {
	ok: boolean;
	contextTokens: number;
	windowSource?: string;
	charsPerToken: number;
	policyTokens: number;
	promptReserve: number;
	questionTokens: number;
	headroomTokens: number;
	total: number;
	remaining: number;
	overBy: number;
	/** Rough character cut needed from the policy text to fit. */
	trimChars: number;
	message: string;
}

export function budgetCheck(input: BudgetInput): BudgetResult {
	const contextTokens = input.contextTokens;
	const charsPerToken = input.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
	const headroomTokens = input.headroomTokens ?? DEFAULT_HEADROOM_TOKENS;
	const policyTokens = estimateTokens(input.policyText, charsPerToken);
	const promptReserve = estimateTokens("x".repeat(Math.max(0, input.promptChars)), charsPerToken);
	const questionTokens = estimateTokens(input.questionText, charsPerToken);
	const total = policyTokens + promptReserve + questionTokens + headroomTokens;
	const remaining = contextTokens - total;
	const overBy = remaining < 0 ? -remaining : 0;
	const trimChars = overBy > 0 ? Math.ceil(overBy * charsPerToken) : 0;
	const ok = overBy === 0;
	const origin = input.windowSource ? `  window:           ${contextTokens}  (${input.windowSource})` : `  window:           ${contextTokens}`;
	const message = ok
		? `Router budget ok: ${total} / ${contextTokens} tokens (policy ${policyTokens}, prompt reserve ${promptReserve}, question ${questionTokens}, headroom ${headroomTokens}; ${remaining} remaining)${input.windowSource ? ` [${input.windowSource}]` : ""}.`
		: [
			`Router context exceeded: ${total} / ${contextTokens} tokens (over by ${overBy}).`,
			origin,
			`  policy text:      ${policyTokens}`,
			`  prompt reserve:   ${promptReserve}  (${input.promptChars} chars)`,
			`  question:         ${questionTokens}`,
			`  headroom:         ${headroomTokens}`,
			`  trim about ${trimChars} characters from the policy markdown and try again.`,
			`The current router.md was not activated.`,
		].join("\n");
	return {
		ok,
		contextTokens,
		windowSource: input.windowSource,
		charsPerToken,
		policyTokens,
		promptReserve,
		questionTokens,
		headroomTokens,
		total,
		remaining,
		overBy,
		trimChars,
		message,
	};
}
