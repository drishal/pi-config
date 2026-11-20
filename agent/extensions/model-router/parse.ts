/**
 * Parse a compact router.md into a structured policy, and render the
 * text Jev actually sees. The format is documented in
 * build-router.prompt.md and docs/extensions/model-router.md.
 */
import {
	budgetCheck,
	DEFAULT_CHARS_PER_TOKEN,
	DEFAULT_HEADROOM_TOKENS,
	resolveRouterContextWindow,
	type BudgetResult,
	type WindowResolution,
} from "./tokens.ts";

export interface RouterModel {
	id: string;
	name?: string;
	plan?: string;
	tier?: string;
	cost?: string;
	context?: string;
	contextWindow: number;
	images: boolean;
	trains: boolean;
	allowTrains: boolean;
	strengths?: string;
	weaknesses?: string;
	fit?: string;
}

export interface RouterDefaults {
	fallback: string;
	direct?: string;
	pinFree?: string;
	pinHard?: string;
	order: string[];
}

export interface RouterPolicy {
	title?: string;
	plans: string;
	notes: string;
	defaults: RouterDefaults;
	models: RouterModel[];
}

export interface MechanicsConfig {
	/** Decider model as a pi `provider/id`, e.g. `command-code/typesafe/jev`. */
	routerModel: string;
	/**
	 * Explicit context window used when the decider is not in pi's registry
	 * (Jev, or any other unregistered model). Ignored when the registry has a
	 * contextWindow for `routerModel`.
	 */
	routerContextWindow?: number;
	/** Optional model for `/build-router`. Unset = inherit the main thread model. */
	buildRouterModel?: string;
	timeoutMs: number;
	chatTimeoutMs: number;
	promptChars: number;
	confidenceFloor: number;
	headroomTokens: number;
	charsPerToken: number;
	largeContextChars: number;
	subagentPins: Record<string, string>;
	jev: {
		url: string;
		id: string;
	};
}

export const DEFAULT_MECHANICS: MechanicsConfig = {
	routerModel: "command-code/typesafe/jev",
	timeoutMs: 2500,
	chatTimeoutMs: 15_000,
	promptChars: 16_000,
	confidenceFloor: 0.45,
	headroomTokens: DEFAULT_HEADROOM_TOKENS,
	charsPerToken: DEFAULT_CHARS_PER_TOKEN,
	largeContextChars: 200_000,
	subagentPins: {},
	jev: {
		url: "https://api.commandcode.ai/provider/v1/systemone",
		id: "typesafe/jev",
	},
};

export function mechanicsWindow(
	mechanics: MechanicsConfig,
	registryWindow?: number,
): WindowResolution {
	return resolveRouterContextWindow({
		routerModel: mechanics.routerModel,
		routerContextWindow: mechanics.routerContextWindow,
		registryWindow,
	});
}

const ID_RE = /^[a-z0-9._-]+\/[a-z0-9._:/-]+$/i;

export function isModelId(value: string): boolean {
	return ID_RE.test(value.trim());
}

export function parseContextWindow(value: string | undefined): number {
	if (!value) return 0;
	const text = value.trim().replace(/,/g, "").toLowerCase();
	const match = text.match(/^(\d+(?:\.\d+)?)\s*(m|k|million|thousand)?\b/);
	if (!match) {
		const n = Number.parseInt(text, 10);
		return Number.isFinite(n) ? n : 0;
	}
	const n = Number(match[1]);
	const unit = match[2] ?? "";
	if (unit === "m" || unit === "million") return Math.round(n * 1_000_000);
	if (unit === "k" || unit === "thousand") return Math.round(n * 1_000);
	return Math.round(n);
}

function stripTicks(value: string): string {
	return value.trim().replace(/^`+|`+$/g, "").trim();
}

function parseYesNo(value: string | undefined): boolean | undefined {
	if (value == null) return undefined;
	const t = value.trim().toLowerCase();
	if (/^(yes|y|true|1)\b/.test(t)) return true;
	if (/^(no|n|false|0)\b/.test(t)) return false;
	return undefined;
}

function parseTrains(value: string | undefined): { trains: boolean; allowTrains: boolean } {
	if (value == null) return { trains: false, allowTrains: false };
	const t = value.trim().toLowerCase();
	const allowed = /\ballow(?:ed)?\b/.test(t);
	if (/^(no|n|false|0)\b/.test(t)) return { trains: false, allowTrains: false };
	if (/^(yes|y|true|1)\b/.test(t) || allowed) return { trains: true, allowTrains: allowed };
	return { trains: false, allowTrains: false };
}

function field(line: string): { key: string; value: string } | undefined {
	const m = line.match(/^\s*[-*]\s*([^:]+):\s*(.*)$/);
	if (!m) return undefined;
	return { key: m[1].trim().toLowerCase(), value: m[2].trim() };
}

function splitIds(value: string): string[] {
	return value
		.split(/[,;\n]/)
		.map((part) => stripTicks(part))
		.filter(Boolean);
}

function headingId(title: string): { id?: string; name?: string } {
	const tick = title.match(/`([^`]+)`/);
	if (tick && isModelId(tick[1])) {
		const rest = title.replace(tick[0], "").trim().replace(/^[\s:\-—–]+/, "");
		return { id: tick[1], name: rest || undefined };
	}
	const trimmed = title.trim();
	if (isModelId(trimmed)) return { id: trimmed };
	return { name: trimmed || undefined };
}

/**
 * Parse router markdown. Throws only on empty input; structural problems
 * are left for the validator so the caller can report them together.
 */
export function parseRouterMd(source: string): RouterPolicy {
	const lines = source.replace(/\r\n/g, "\n").split("\n");
	let title: string | undefined;
	const sectionLines: Record<string, string[]> = {};
	let current = "notes";
	const models: RouterModel[] = [];
	let currentModel: Partial<RouterModel> & { _lines?: string[] } | undefined;

	const flushModel = () => {
		if (!currentModel) return;
		const trains = {
			trains: currentModel.trains ?? false,
			allowTrains: currentModel.allowTrains ?? false,
		};
		models.push({
			id: currentModel.id ?? "",
			name: currentModel.name,
			plan: currentModel.plan,
			tier: currentModel.tier,
			cost: currentModel.cost,
			context: currentModel.context,
			contextWindow: currentModel.contextWindow ?? parseContextWindow(currentModel.context),
			images: currentModel.images ?? false,
			trains: trains.trains,
			allowTrains: trains.allowTrains,
			strengths: currentModel.strengths,
			weaknesses: currentModel.weaknesses,
			fit: currentModel.fit,
		});
		currentModel = undefined;
	};

	for (const raw of lines) {
		const line = raw;
		const h1 = line.match(/^#\s+(.+)$/);
		if (h1 && !title) {
			title = h1[1].trim();
			continue;
		}
		const h2 = line.match(/^##\s+(.+)$/);
		if (h2) {
			flushModel();
			const name = h2[1].trim().toLowerCase();
			if (name.startsWith("plan")) current = "plans";
			else if (name.startsWith("default")) current = "defaults";
			else if (name.startsWith("model")) current = "models";
			else current = "notes";
			continue;
		}
		if (current === "models") {
			const h3 = line.match(/^###\s+(.+)$/);
			if (h3) {
				flushModel();
				const heading = headingId(h3[1]);
				currentModel = { id: heading.id, name: heading.name };
				continue;
			}
			if (currentModel) {
				const f = field(line);
				if (f) {
					if (f.key === "id" && isModelId(stripTicks(f.value))) currentModel.id = stripTicks(f.value);
					else if (f.key === "name") currentModel.name = stripTicks(f.value);
					else if (f.key === "plan") currentModel.plan = f.value;
					else if (f.key === "tier") currentModel.tier = f.value;
					else if (f.key === "cost") currentModel.cost = f.value;
					else if (f.key === "context") {
						currentModel.context = f.value;
						currentModel.contextWindow = parseContextWindow(f.value);
					} else if (f.key === "images") currentModel.images = parseYesNo(f.value) ?? false;
					else if (f.key === "trains") {
						const t = parseTrains(f.value);
						currentModel.trains = t.trains;
						currentModel.allowTrains = t.allowTrains;
					} else if (f.key === "strengths" || f.key === "strength") currentModel.strengths = f.value;
					else if (f.key === "weaknesses" || f.key === "weakness") currentModel.weaknesses = f.value;
					else if (f.key === "fit" || f.key === "task fit") currentModel.fit = f.value;
				}
			}
			continue;
		}
		(sectionLines[current] ??= []).push(line);
	}
	flushModel();

	const defaultsRaw = (sectionLines.defaults ?? []).join("\n");
	const defaults: RouterDefaults = { fallback: "", order: [] };
	for (const line of sectionLines.defaults ?? []) {
		const f = field(line);
		if (!f) continue;
		if (f.key === "fallback") defaults.fallback = stripTicks(f.value);
		else if (f.key === "direct") defaults.direct = stripTicks(f.value);
		else if (f.key === "pin-free" || f.key === "pinfree" || f.key === "pin free") defaults.pinFree = stripTicks(f.value);
		else if (f.key === "pin-hard" || f.key === "pinhard" || f.key === "pin hard") defaults.pinHard = stripTicks(f.value);
		else if (f.key === "order" || f.key === "fallback-order") defaults.order = splitIds(f.value);
	}

	const plans = (sectionLines.plans ?? []).join("\n").trim();
	const notes = (sectionLines.notes ?? []).join("\n").trim();
	if (!defaults.order.length) defaults.order = models.map((m) => m.id).filter(Boolean);

	return { title, plans, notes, defaults, models };
}

export function modelById(policy: RouterPolicy, id: string): RouterModel | undefined {
	return policy.models.find((m) => m.id === id);
}

export function modelCriteriaLine(model: RouterModel): string {
	const flags = [
		model.images ? "images" : "no-images",
		model.trains ? (model.allowTrains ? "trains-allowed" : "trains") : "no-train",
		model.context || (model.contextWindow ? String(model.contextWindow) : undefined),
	];
	return [model.plan, model.tier, model.cost, ...flags, model.fit, model.strengths, model.weaknesses ? `weak: ${model.weaknesses}` : ""]
		.filter(Boolean)
		.join("; ");
}

export const JEV_CHOICE_INSTRUCTIONS =
	"Pick the best physical model id for this user prompt, given the policy and candidate list in state. Prefer free or high-limit models when quality is adequate. Honour plan notes (peak windows, promo dates, caps). Never pick a model that is not in the candidate list.";

export function buildJevQuestion(models: RouterModel[]): {
	instructions: string;
	criteria: Record<string, string>;
	text: string;
} {
	const criteria: Record<string, string> = {};
	for (const model of models) {
		if (model.id) criteria[model.id] = modelCriteriaLine(model) || model.id;
	}
	const text = [
		"model: choice",
		`instructions: ${JEV_CHOICE_INSTRUCTIONS}`,
		"criteria:",
		...Object.entries(criteria).map(([id, line]) => `  ${id}: ${line}`),
	].join("\n");
	return { instructions: JEV_CHOICE_INSTRUCTIONS, criteria, text };
}

/** Compact rendering of the policy Jev receives as state (candidates only). */
export function renderForJev(policy: RouterPolicy, candidateIds?: readonly string[]): string {
	const allow = candidateIds ? new Set(candidateIds) : undefined;
	const models = allow ? policy.models.filter((m) => allow.has(m.id)) : policy.models;
	const lines: string[] = [];
	if (policy.title) lines.push(`# ${policy.title}`, "");
	if (policy.plans) lines.push("## Plans", policy.plans, "");
	if (policy.notes) lines.push("## Notes", policy.notes, "");
	const d = policy.defaults;
	lines.push(
		"## Defaults",
		`- fallback: ${d.fallback}`,
		d.direct ? `- direct: ${d.direct}` : "",
		d.order.length ? `- order: ${d.order.join(", ")}` : "",
		"",
		"## Candidates",
	);
	for (const model of models) {
		lines.push(`- \`${model.id}\`: ${modelCriteriaLine(model)}`);
	}
	return lines.filter((line, i, arr) => !(line === "" && arr[i - 1] === "")).join("\n").trim() + "\n";
}

export function policyBudget(
	policy: RouterPolicy,
	mechanics: MechanicsConfig = DEFAULT_MECHANICS,
	registryWindow?: number,
): BudgetResult {
	// Worst case: every model in the file survives hard filters and is a candidate.
	const window = mechanicsWindow(mechanics, registryWindow);
	return budgetCheck({
		policyText: renderForJev(policy),
		promptChars: mechanics.promptChars,
		questionText: buildJevQuestion(policy.models).text,
		contextTokens: window.contextTokens,
		headroomTokens: mechanics.headroomTokens,
		charsPerToken: mechanics.charsPerToken,
		windowSource: window.source,
	});
}
