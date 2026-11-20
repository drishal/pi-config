/**
 * model-router — virtual model `router/auto` that picks a physical model per
 * request from the markdown policy in router.md, using a configurable decider
 * (`routerModel` in router.json; default command-code/typesafe/jev).
 *
 * Opt-in: select `router/auto` with /model or `pi --model router/auto`. This
 * extension never writes defaultProvider / defaultModel.
 *
 * The decider may be Command Code Jev (HTTP /systemone — the official Command
 * Code provider does not register Jev), any other classifier in pi's registry
 * (ctx.modelRegistry.classify), or any regular chat model (strict JSON id,
 * validated against the candidate list). Fail open on errors.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRoute,
	ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import {
	buildChatPrompt,
	findCatalog,
	formatPickerOption,
	parseDeciderText,
	parsePickerOption,
	pickerEntries,
	resolveDeciderKind,
	validateRouterModel,
	type CatalogEntry,
} from "./decider.ts";
import {
	activatePolicy,
	buildRouterPromptPath,
	lastDecisionPath,
	loadMechanics,
	loadPolicy,
	routerMdPath,
	routerStagingPath,
	writeMechanics,
	type LoadedPolicy,
} from "./load.ts";
import {
	buildJevQuestion,
	renderForJev,
	type MechanicsConfig,
	type RouterPolicy,
} from "./parse.ts";
import {
	applyDecider,
	preRoute,
	type RouteDecision,
} from "./policy.ts";
import { formatReport, validatePolicy } from "./validate.ts";
import { isJevModelId, JEV_CONTEXT_TOKENS } from "./tokens.ts";

const JEV_PROVIDER = "command-code-jev";
const JEV_ID = "typesafe/jev";
const JEV_URL_DEFAULT = "https://api.commandcode.ai/provider/v1/systemone";

interface RouterState {
	pin?: string;
}

interface LastDecision {
	at: string;
	model: string;
	via: string;
	reasons: string[];
	skipped: string[];
	candidates: string[];
	reason: string;
	decider?: {
		kind?: string;
		ms?: number;
		cost?: number;
		inputTokens?: number;
		error?: string;
		choice?: string;
		confidence?: number;
	};
	promptPreview: string;
}

let cached: LoadedPolicy | undefined;
const pins = new Map<string, string>();
let last: LastDecision | undefined;

function sessionKey(ctx: ExtensionContext): string {
	const sm = ctx.sessionManager as { getSessionPath?: () => string } | undefined;
	try {
		return sm?.getSessionPath?.() || ctx.cwd || "default";
	} catch {
		return ctx.cwd || "default";
	}
}

function registryWindowFor(ctx: ExtensionContext, mechanics: MechanicsConfig): number | undefined {
	const entries = catalogEntries(ctx);
	const entry = findCatalog(mechanics.routerModel, entries);
	if (entry && entry.contextWindow > 0) return entry.contextWindow;
	return undefined;
}

function reload(ctx?: ExtensionContext): LoadedPolicy {
	const registryWindow = ctx ? registryWindowFor(ctx, loadMechanics().mechanics) : undefined;
	cached = loadPolicy(registryWindow);
	if (cached.warning) console.error(`[model-router] ${cached.warning}`);
	return cached;
}

function loaded(ctx?: ExtensionContext): LoadedPolicy {
	return cached ?? reload(ctx);
}

function lastUserText(messages: readonly Message[]): string {
	const content = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function lastUserHasImages(messages: readonly Message[]): boolean {
	for (const message of [...messages].reverse()) {
		if (message.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") return false;
		return content.some((block) => block.type === "image");
	}
	return false;
}

function contextChars(messages: readonly Message[]): number {
	let n = 0;
	for (const message of messages) {
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") n += content.length;
		else if (Array.isArray(content)) {
			for (const block of content) {
				if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
					n += block.text.length;
				}
			}
		}
	}
	return n;
}

function catalog(ctx: ExtensionContext): {
	available: Set<string>;
	modelMeta: Record<string, { contextWindow: number; images: boolean }>;
} {
	const available = new Set<string>();
	const modelMeta: Record<string, { contextWindow: number; images: boolean }> = {};
	for (const model of ctx.modelRegistry.getAvailable()) {
		if ((model as { api?: string }).api === "pi-virtual") continue;
		const id = `${model.provider}/${model.id}`;
		available.add(id);
		modelMeta[id] = {
			contextWindow: model.contextWindow ?? 0,
			images: Array.isArray(model.input) && model.input.includes("image"),
		};
	}
	return { available, modelMeta };
}

function catalogEntries(ctx: ExtensionContext): CatalogEntry[] {
	const out: CatalogEntry[] = [];
	const seen = new Set<string>();
	const push = (model: { provider: string; id: string; name?: string; contextWindow?: number; api?: string; type?: string; input?: string[] }) => {
		const spec = `${model.provider}/${model.id}`;
		if (seen.has(spec)) return;
		seen.add(spec);
		const virtual = model.api === "pi-virtual" || (model.provider === "router" && model.id === "auto");
		const kind = model.type === "classifier" ? "classifier" : "chat";
		out.push({
			spec,
			kind,
			contextWindow: model.contextWindow ?? 0,
			name: model.name,
			virtual,
		});
	};
	for (const model of ctx.modelRegistry.getAll()) push(model as never);
	try {
		for (const model of ctx.modelRegistry.getModelsOfType("classifier")) push(model as never);
	} catch {
		// older pi without getModelsOfType
	}
	return out;
}

function subagentType(): string | undefined {
	try {
		const storage = (globalThis as Record<symbol, unknown>)[
			Symbol.for("pi-subagents-lite:subagent-parent-context")
		] as { getStore?: () => { manager?: { getRecord?: (id: string) => { display?: { type?: string } } }; agentId?: string } };
		const store = storage?.getStore?.();
		if (!store?.agentId || !store.manager?.getRecord) return undefined;
		return store.manager.getRecord(store.agentId)?.display?.type;
	} catch {
		return undefined;
	}
}

function lookup(ctx: ExtensionContext, spec: string) {
	const slash = spec.indexOf("/");
	if (slash <= 0) return undefined;
	return ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
}

function writeLast(entry: LastDecision): void {
	last = entry;
	try {
		writeFileSync(lastDecisionPath(), JSON.stringify(entry, null, 2) + "\n", { mode: 0o600 });
	} catch {
		// machine-local log is best-effort
	}
	if (process.env.PI_ROUTER_VERBOSE === "1") {
		console.error(`[model-router] ${entry.via} → ${entry.model} ${entry.reasons.join("; ")}`);
	}
}

function formatDecision(entry: LastDecision): string {
	const lines = [
		`${entry.at}  ${entry.model}`,
		`via ${entry.via}  (${entry.reason} request)`,
		...entry.reasons.map((r) => `  • ${r}`),
	];
	if (entry.decider) {
		const j = entry.decider;
		if (j.error) lines.push(`  decider: failed (${j.error})${j.ms != null ? ` in ${j.ms}ms` : ""}`);
		else {
			const bits = [
				j.kind ? j.kind : "",
				j.choice ? `choice=${j.choice}` : "",
				j.confidence != null ? `p=${j.confidence.toFixed(2)}` : "",
				j.ms != null ? `${j.ms}ms` : "",
				j.inputTokens != null ? `${j.inputTokens} in` : "",
				j.cost != null ? `$${j.cost.toFixed(6)}` : "",
			].filter(Boolean);
			lines.push(`  decider: ${bits.join(" · ") || "called"}`);
		}
	}
	if (entry.candidates.length) lines.push(`  candidates: ${entry.candidates.slice(0, 12).join(", ")}${entry.candidates.length > 12 ? "…" : ""}`);
	if (entry.skipped.length) lines.push("  skipped:", ...entry.skipped.slice(0, 8).map((s) => `    – ${s}`));
	if (entry.promptPreview) lines.push(`  prompt: ${entry.promptPreview}`);
	return lines.join("\n");
}

function assistantText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => !!block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

interface DeciderCall {
	kind?: string;
	ms?: number;
	cost?: number;
	inputTokens?: number;
	error?: string;
	choice?: string;
	confidence?: number;
}

async function callDecider(
	policy: RouterPolicy,
	mechanics: MechanicsConfig,
	ctx: ExtensionContext,
	prompt: string,
	candidates: string[],
	signal: AbortSignal,
): Promise<DeciderCall> {
	const entries = catalogEntries(ctx);
	const kind = resolveDeciderKind(mechanics.routerModel, entries);
	const question = buildJevQuestion(policy.models.filter((m) => candidates.includes(m.id)));
	const policyText = renderForJev(policy, candidates);
	const truncated = prompt.slice(0, mechanics.promptChars);

	if (kind === "jev-http" || (kind === "missing" && isJevModelId(mechanics.routerModel))) {
		return callJevHttp(mechanics, policyText, truncated, question, signal);
	}
	if (kind === "classifier") {
		return callClassifier(ctx, mechanics, entries, policyText, truncated, question, signal);
	}
	if (kind === "chat") {
		return callChatModel(ctx, mechanics, entries, policyText, truncated, candidates, question.criteria, signal);
	}
	return { error: `${mechanics.routerModel} is not in the registry and is not Jev`, kind: "missing" };
}

async function callJevHttp(
	mechanics: MechanicsConfig,
	policyText: string,
	prompt: string,
	question: { instructions: string; criteria: Record<string, string> },
	signal: AbortSignal,
): Promise<DeciderCall> {
	const key = process.env.CMD_API_KEY || process.env.COMMAND_CODE_API_KEY;
	if (!key) return { kind: "jev", error: "CMD_API_KEY / COMMAND_CODE_API_KEY is not set" };
	const timeout = AbortSignal.timeout(mechanics.timeoutMs);
	const combined = AbortSignal.any([signal, timeout]);
	const started = Date.now();
	let body: Record<string, unknown>;
	try {
		const response = await fetch(mechanics.jev.url || JEV_URL_DEFAULT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: mechanics.jev.id || JEV_ID,
				state: { policy: policyText, prompt },
				questions: {
					model: {
						type: "choice",
						instructions: question.instructions,
						criteria: question.criteria,
					},
				},
			}),
			signal: combined,
		});
		body = (await response.json()) as Record<string, unknown>;
		if (!response.ok) {
			const msg =
				(typeof body.error === "string" && body.error) ||
				(typeof body.message === "string" && body.message) ||
				`HTTP ${response.status}`;
			return { kind: "jev", ms: Date.now() - started, error: msg };
		}
	} catch (err) {
		const ms = Date.now() - started;
		const name = err instanceof Error ? err.name : "";
		if (name === "TimeoutError" || name === "AbortError") return { kind: "jev", ms, error: "timeout" };
		return { kind: "jev", ms, error: err instanceof Error ? err.message : String(err) };
	}
	const ms = Date.now() - started;
	const usage = (body.usage ?? {}) as { input_tokens?: number; input?: number };
	const inputTokens = usage.input_tokens ?? usage.input;
	const cost = inputTokens != null ? (inputTokens / 1_000_000) * 0.04 : undefined;
	const answers = (body.answers ?? {}) as Record<string, Record<string, unknown>>;
	const answer = answers.model;
	if (!answer) return { kind: "jev", ms, inputTokens, cost, error: "Jev returned no model answer" };
	const choice =
		typeof answer.choice === "string"
			? answer.choice
			: pickHighest(answer.probabilities as Record<string, number> | undefined);
	const confidence =
		typeof answer.confidence === "number"
			? answer.confidence
			: choice && answer.probabilities && typeof (answer.probabilities as Record<string, number>)[choice] === "number"
				? (answer.probabilities as Record<string, number>)[choice]
				: 0;
	if (!choice) return { kind: "jev", ms, inputTokens, cost, error: `unexpected Jev answer: ${JSON.stringify(answer).slice(0, 200)}` };
	return { kind: "jev", ms, inputTokens, cost, choice, confidence };
}

async function callClassifier(
	ctx: ExtensionContext,
	mechanics: MechanicsConfig,
	entries: CatalogEntry[],
	policyText: string,
	prompt: string,
	question: { instructions: string; criteria: Record<string, string> },
	signal: AbortSignal,
): Promise<DeciderCall> {
	const entry = findCatalog(mechanics.routerModel, entries);
	const parts = (entry?.spec ?? mechanics.routerModel).split("/");
	const provider = parts[0]!;
	const id = parts.slice(1).join("/");
	const model = ctx.modelRegistry.findOfType("classifier", provider, id);
	if (!model) return { kind: "classifier", error: `classifier ${provider}/${id} not in registry` };
	const timeout = AbortSignal.timeout(mechanics.timeoutMs);
	const combined = AbortSignal.any([signal, timeout]);
	const started = Date.now();
	try {
		const result = await ctx.modelRegistry.classify(
			model,
			{
				state: { policy: policyText, prompt },
				questions: {
					model: {
						type: "choice",
						instructions: question.instructions,
						criteria: question.criteria,
					},
				},
			},
			{ signal: combined },
		);
		const ms = Date.now() - started;
		const inputTokens = result.usage?.input;
		const cost = result.usage?.cost?.total;
		if (result.stopReason !== "stop") {
			return { kind: "classifier", ms, inputTokens, cost, error: result.errorMessage || result.stopReason };
		}
		const answer = result.answers.model;
		if (!answer || answer.type !== "choice" || !answer.choice) {
			return { kind: "classifier", ms, inputTokens, cost, error: "classifier returned no choice" };
		}
		return { kind: "classifier", ms, inputTokens, cost, choice: answer.choice, confidence: answer.confidence };
	} catch (err) {
		const ms = Date.now() - started;
		const name = err instanceof Error ? err.name : "";
		if (name === "TimeoutError" || name === "AbortError") return { kind: "classifier", ms, error: "timeout" };
		return { kind: "classifier", ms, error: err instanceof Error ? err.message : String(err) };
	}
}

async function callChatModel(
	ctx: ExtensionContext,
	mechanics: MechanicsConfig,
	entries: CatalogEntry[],
	policyText: string,
	prompt: string,
	candidates: string[],
	criteria: Record<string, string>,
	signal: AbortSignal,
): Promise<DeciderCall> {
	const entry = findCatalog(mechanics.routerModel, entries);
	const spec = entry?.spec ?? mechanics.routerModel;
	const model = lookup(ctx, spec);
	if (!model) return { kind: "chat", error: `${spec} is not in the chat catalog` };
	const timeout = AbortSignal.timeout(mechanics.chatTimeoutMs);
	const combined = AbortSignal.any([signal, timeout]);
	const started = Date.now();
	try {
		const response = await ctx.modelRegistry.complete(
			model,
			{
				systemPrompt: "You are a model router. Reply with only the required JSON.",
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: buildChatPrompt(policyText, prompt, candidates, criteria) }],
						timestamp: Date.now(),
					},
				],
			},
			{ signal: combined },
		);
		const ms = Date.now() - started;
		const usage = (response as { usage?: { input?: number; cost?: { total?: number } } }).usage;
		const text = assistantText(response.content);
		if ((response as { stopReason?: string }).stopReason === "aborted") {
			return { kind: "chat", ms, inputTokens: usage?.input, cost: usage?.cost?.total, error: "aborted" };
		}
		const errorMessage = (response as { errorMessage?: string }).errorMessage;
		if (errorMessage) return { kind: "chat", ms, inputTokens: usage?.input, cost: usage?.cost?.total, error: errorMessage };
		const choice = parseDeciderText(text, candidates);
		if (!choice) {
			return {
				kind: "chat",
				ms,
				inputTokens: usage?.input,
				cost: usage?.cost?.total,
				error: `could not parse a candidate id from: ${text.replace(/\s+/g, " ").slice(0, 200)}`,
			};
		}
		return { kind: "chat", ms, inputTokens: usage?.input, cost: usage?.cost?.total, choice, confidence: 1 };
	} catch (err) {
		const ms = Date.now() - started;
		const name = err instanceof Error ? err.name : "";
		if (name === "TimeoutError" || name === "AbortError") return { kind: "chat", ms, error: "timeout" };
		return { kind: "chat", ms, error: err instanceof Error ? err.message : String(err) };
	}
}

function pickHighest(probabilities: Record<string, number> | undefined): string | undefined {
	if (!probabilities) return undefined;
	let best: string | undefined;
	let score = -1;
	for (const [key, value] of Object.entries(probabilities)) {
		if (typeof value === "number" && value > score) {
			best = key;
			score = value;
		}
	}
	return best;
}

async function routeTo(
	request: ModelRouteRequest<RouterState>,
	ctx: ExtensionContext,
	decision: RouteDecision,
	state?: RouterState,
): Promise<ModelRoute<RouterState>> {
	const model = lookup(ctx, decision.model);
	if (!model) throw new Error(`model-router: ${decision.model} is not in the catalog`);
	return { model, thinkingLevel: request.thinkingLevel, state };
}

function formatStatus(loadedNow: LoadedPolicy, ctx: ExtensionContext, pin: string | undefined): string {
	const { mechanics, window } = loadedNow;
	const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
	const kind = resolveDeciderKind(mechanics.routerModel, catalogEntries(ctx));
	const lines = [
		`router/auto is opt-in (this session: ${current})`,
		`policy: ${loadedNow.policySource}`,
		`mechanics: ${loadedNow.mechanicsSource}`,
		`decider: ${mechanics.routerModel}  (${kind})`,
		`decider context window: ${window.contextTokens}  (source: ${window.source})`,
		mechanics.buildRouterModel
			? `build-router model: ${mechanics.buildRouterModel} (override)`
			: "build-router model: inherit the main thread model",
		`pin: ${pin ?? "none (dynamic)"}`,
		`subagentPins: ${Object.keys(mechanics.subagentPins).length ? JSON.stringify(mechanics.subagentPins) : "(none — children inherit router/auto)"}`,
	];
	if (loadedNow.budget) {
		lines.push(
			`budget: ${loadedNow.budget.total} / ${loadedNow.budget.contextTokens} tokens (${loadedNow.budget.ok ? "ok" : "OVER"})`,
		);
	}
	if (loadedNow.warning) lines.push(`warning:\n${loadedNow.warning}`);
	lines.push(last ? `last:\n${formatDecision(last)}` : "last: none yet");
	return lines.join("\n");
}

function injectBuildRouter(pi: ExtensionAPI, ctx: ExtensionContext, userText: string, printOnly: boolean): void {
	let template = "";
	try {
		template = readFileSync(buildRouterPromptPath(), "utf8");
	} catch {
		ctx.ui.notify("build-router.prompt.md is missing from the extension directory", "error");
		return;
	}
	const request = userText.trim() || "Rebuild the router policy from the plans and models available on this machine.";
	const message = `${template.trim()}\n\n## User request\n\n${request}\n`;
	if (printOnly) {
		ctx.ui.notify(message, "info");
		return;
	}
	const loadedNow = loaded(ctx);
	const override = loadedNow.mechanics.buildRouterModel;
	const go = async () => {
		if (override) {
			const model = lookup(ctx, override);
			if (!model) {
				ctx.ui.notify(`buildRouterModel ${override} is not in the catalog — not injecting`, "error");
				return;
			}
			const ok = await ctx.setModel(model);
			if (!ok) {
				ctx.ui.notify(`could not switch to ${override} (provider not authenticated?)`, "error");
				return;
			}
			ctx.ui.notify(`build-router: switched this session to ${override} for the build turn`, "info");
		}
		if (!ctx.isIdle()) {
			ctx.ui.notify("a turn is in progress — injecting /build-router as a follow-up", "info");
			pi.sendUserMessage(message, { deliverAs: "followUp" });
		} else {
			pi.sendUserMessage(message);
		}
	};
	void go().catch((err) => {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
	});
}

export default function (pi: ExtensionAPI) {
	const keyRef = process.env.CMD_API_KEY
		? "$CMD_API_KEY"
		: process.env.COMMAND_CODE_API_KEY
			? "$COMMAND_CODE_API_KEY"
			: undefined;
	if (keyRef) {
		// Registered so Jev appears in the registry / /router model picker with
		// the documented 32768 context window. Classification itself uses the
		// Provider API in callJevHttp() — the official Command Code provider
		// does not list Jev or expose /systemone, and registerProvider would
		// replace command-code's whole catalog, so this is a companion provider.
		pi.registerProvider(JEV_PROVIDER, {
			name: "Command Code Jev",
			baseUrl: "https://api.commandcode.ai/provider/v1",
			apiKey: keyRef,
			api: "typesafe-system-one",
			models: [
				{
					type: "classifier",
					id: JEV_ID,
					name: "Jev (Command Code)",
					api: "typesafe-system-one",
					input: ["text"],
					cost: { input: 0.04, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: JEV_CONTEXT_TOKENS,
				},
			],
		});
	}

	const route = async (
		request: ModelRouteRequest<RouterState>,
		ctx: ExtensionContext,
	): Promise<ModelRoute<RouterState>> => {
		const snap = loaded(ctx);
		if (!snap.policy) {
			throw new Error(snap.warning || "model-router: no valid router policy is loaded");
		}
		const { available, modelMeta } = catalog(ctx);
		const prompt = lastUserText(request.messages);
		const hasImages = lastUserHasImages(request.messages);
		const pin = pins.get(sessionKey(ctx)) ?? request.state?.pin;

		const pre = preRoute(snap.policy, snap.mechanics, {
			reason: request.reason,
			prompt,
			hasImages,
			contextChars: contextChars(request.messages),
			previousId: request.previous
				? `${request.previous.model.provider}/${request.previous.model.id}`
				: undefined,
			failedId: request.failed
				? `${request.failed.model.provider}/${request.failed.model.id}`
				: undefined,
			failedError: request.failed?.message
				? String(
					(request.failed.message as { errorMessage?: string }).errorMessage ??
						(request.failed.message as { stopReason?: string }).stopReason ??
						"",
				)
				: undefined,
			now: new Date(),
			pin,
			subagentType: subagentType(),
			available,
			modelMeta,
		});

		let decision: RouteDecision;
		let deciderResult: DeciderCall | undefined;
		if (pre.final) {
			decision = pre.final;
		} else {
			deciderResult = await callDecider(snap.policy, snap.mechanics, ctx, prompt, pre.candidates, request.signal);
			if (deciderResult.choice) {
				decision = applyDecider(
					snap.policy,
					pre,
					{
						choice: deciderResult.choice,
						confidence: deciderResult.confidence ?? 0,
						via: deciderResult.kind === "classifier" ? "classifier" : deciderResult.kind === "chat" ? "chat" : "jev",
					},
					snap.mechanics.confidenceFloor,
				);
			} else {
				decision = applyDecider(
					snap.policy,
					pre,
					{ error: deciderResult.error || "decider returned no choice" },
					snap.mechanics.confidenceFloor,
				);
			}
		}

		writeLast({
			at: new Date().toISOString(),
			model: decision.model,
			via: decision.via,
			reasons: decision.reasons,
			skipped: decision.skipped,
			candidates: decision.candidates,
			reason: request.reason,
			decider: deciderResult,
			promptPreview: prompt.replace(/\s+/g, " ").slice(0, 240),
		});

		return routeTo(request, ctx, decision, { pin });
	};

	pi.registerVirtualModel<RouterState>({
		provider: "router",
		id: "auto",
		name: "Auto (markdown router)",
		thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		input: ["text", "image"],
		route,
	});

	pi.registerCommand("router", {
		description:
			"Model router: status | explain | pin [auto|free|hard|provider/id] | model [provider/id] | validate [file] | apply [file] | reload",
		handler: async (args, ctx) => {
			const argv = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const cmd = (argv[0] ?? "status").toLowerCase();
			if (cmd === "reload") {
				const snap = reload(ctx);
				ctx.ui.notify(
					`reloaded ${snap.policySource}\ndecider window: ${snap.window.contextTokens} (${snap.window.source})${snap.warning ? `\n${snap.warning}` : ""}`,
					snap.warning ? "warning" : "info",
				);
				return;
			}
			if (cmd === "explain") {
				ctx.ui.notify(last ? formatDecision(last) : "no routing decision yet in this process", "info");
				return;
			}
			if (cmd === "pin") {
				const value = argv.slice(1).join(" ").trim();
				const key = sessionKey(ctx);
				if (!value || value === "auto" || value === "off" || value === "unpin") {
					pins.delete(key);
					ctx.ui.notify("router unpinned — dynamic per-turn routing", "info");
					return;
				}
				pins.set(key, value);
				ctx.ui.notify(`router pinned to ${value}`, "info");
				return;
			}
			if (cmd === "model") {
				const entries = catalogEntries(ctx);
				const arg = argv.slice(1).join(" ").trim();
				let spec = arg;
				if (!spec) {
					const options = pickerEntries(entries).map(formatPickerOption);
					const picked = await ctx.ui.select("Router decider model", options);
					if (!picked) {
						ctx.ui.notify("cancelled — routerModel unchanged", "info");
						return;
					}
					spec = parsePickerOption(picked);
				}
				const result = validateRouterModel(spec, entries);
				if (!result.ok) {
					ctx.ui.notify(result.error, "error");
					return;
				}
				const patch: Record<string, unknown> = { routerModel: result.spec };
				if (result.contextWindow > 0) patch.routerContextWindow = result.contextWindow;
				else if (isJevModelId(result.spec)) patch.routerContextWindow = JEV_CONTEXT_TOKENS;
				writeMechanics(patch);
				cached = undefined;
				const snap = reload(ctx);
				ctx.ui.notify(
					`routerModel set to ${result.spec} (${result.kind})\ndecider context window: ${snap.window.contextTokens}  (source: ${snap.window.source})`,
					"info",
				);
				return;
			}
			if (cmd === "validate") {
				const file = argv[1] ?? routerMdPath();
				try {
					const { parseRouterMd } = await import("./parse.ts");
					const snap = loaded(ctx);
					const policy = parseRouterMd(readFileSync(file, "utf8"));
					const report = validatePolicy(policy, snap.mechanics, registryWindowFor(ctx, snap.mechanics));
					ctx.ui.notify(`${file}\n${formatReport(report)}\nwindow: ${report.budget.contextTokens} (${report.budget.windowSource})`, report.ok ? "info" : "error");
				} catch (err) {
					ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
				}
				return;
			}

			if (cmd === "apply") {
				const file = argv[1] ?? routerStagingPath();
				const snap = loaded(ctx);
				const result = activatePolicy(file, {
					mechanics: snap.mechanics,
					registryWindow: registryWindowFor(ctx, snap.mechanics),
				});
				cached = undefined;
				if (result.ok) reload(ctx);
				ctx.ui.notify(result.message + (result.ok ? `\nactivated ${result.dest}` : ""), result.ok ? "info" : "error");
				return;
			}
			const snap = loaded(ctx);
			ctx.ui.notify(formatStatus(snap, ctx, pins.get(sessionKey(ctx))), snap.warning ? "warning" : "info");
		},
	});

	pi.registerCommand("build-router", {
		description: "Draft or rebuild router.md as a regular turn on the current (or buildRouterModel) model. /build-router --print shows the prompt only.",
		handler: (args, ctx) => {
			const raw = (args ?? "").trim();
			const printOnly = raw === "--print" || raw.startsWith("--print ");
			const userText = printOnly ? raw.replace(/^--print\s*/, "") : raw;
			injectBuildRouter(pi, ctx, userText, printOnly);
		},
	});

	// Warm the policy cache (and log a budget warning) at extension load.
	try {
		reload();
	} catch (err) {
		console.error(`[model-router] load failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}
