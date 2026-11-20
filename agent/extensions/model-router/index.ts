/**
 * model-router — virtual model `router/auto` that picks a physical model per
 * request from the OpenCode Go + Command Code GOAT routing table.
 *
 * Opt-in: select `router/auto` with /model or `pi --model router/auto`. This
 * extension never writes defaultProvider / defaultModel.
 *
 * Jev (`typesafe/jev` via Command Code /provider/v1/systemone) is asked only
 * when the prompt is unclear. Failures time out in ~2.5s and fall open to
 * heuristics.
 */
import { writeFileSync } from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRoute,
	ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import { describeHardDebug, lastDecisionPath, loadConfig } from "./config.ts";
import {
	decide,
	heuristicTask,
	isTaskKind,
	type RouteDecision,
	type RouterConfig,
	type TaskKind,
} from "./policy.ts";

const JEV_PROVIDER = "command-code-jev";
const JEV_ID = "typesafe/jev";
const JEV_URL = "https://api.commandcode.ai/provider/v1/systemone";

interface RouterState {
	pin?: string;
	task?: TaskKind;
}

interface LastDecision {
	at: string;
	model: string;
	task: string;
	via: string;
	reasons: string[];
	skipped: string[];
	reason: string;
	jev?: { ms?: number; cost?: number; inputTokens?: number; error?: string; task?: string; confidence?: number };
	promptPreview: string;
}

let cached: { config: RouterConfig; source: string } | undefined;
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

function reload(): { config: RouterConfig; source: string } {
	cached = loadConfig();
	return cached;
}

function config(): { config: RouterConfig; source: string } {
	return cached ?? reload();
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
		console.error(
			`[model-router] ${entry.via} → ${entry.model} (${entry.task}) ${entry.reasons.join("; ")}`,
		);
	}
}

function formatDecision(entry: LastDecision): string {
	const lines = [
		`${entry.at}  ${entry.model}`,
		`task ${entry.task}  via ${entry.via}  (${entry.reason} request)`,
		...entry.reasons.map((r) => `  • ${r}`),
	];
	if (entry.jev) {
		const j = entry.jev;
		if (j.error) lines.push(`  Jev: failed (${j.error})${j.ms != null ? ` in ${j.ms}ms` : ""}`);
		else {
			const bits = [
				j.task ? `task=${j.task}` : "",
				j.confidence != null ? `p=${j.confidence.toFixed(2)}` : "",
				j.ms != null ? `${j.ms}ms` : "",
				j.inputTokens != null ? `${j.inputTokens} in` : "",
				j.cost != null ? `$${j.cost.toFixed(6)}` : "",
			].filter(Boolean);
			lines.push(`  Jev: ${bits.join(" · ") || "called"}`);
		}
	}
	if (entry.skipped.length) lines.push("  skipped:", ...entry.skipped.slice(0, 8).map((s) => `    – ${s}`));
	if (entry.promptPreview) lines.push(`  prompt: ${entry.promptPreview}`);
	return lines.join("\n");
}

async function classify(
	cfg: RouterConfig,
	_ctx: ExtensionContext,
	prompt: string,
	signal: AbortSignal,
): Promise<NonNullable<LastDecision["jev"]> & { task?: TaskKind; confidence?: number; error?: string }> {
	// The official Command Code pi provider does not register /systemone, and
	// pi's built-in typesafe-system-one classify implementation is not importable
	// from a local extension (package subpath does not resolve). Call the
	// documented Provider API directly with the already-loaded key.
	const key = process.env.CMD_API_KEY || process.env.COMMAND_CODE_API_KEY;
	if (!key) return { error: "CMD_API_KEY / COMMAND_CODE_API_KEY is not set" };
	const timeout = AbortSignal.timeout(cfg.jev.timeoutMs);
	const combined = AbortSignal.any([signal, timeout]);
	const started = Date.now();
	let body: Record<string, unknown>;
	try {
		const response = await fetch(JEV_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: cfg.jev.id,
				state: { prompt: prompt.slice(0, cfg.jev.promptChars) },
				questions: {
					task: {
						type: "choice",
						instructions:
							"What kind of software-engineering work does `prompt` ask for? Pick the closest label.",
						criteria: {
							render_loop: "Running tests, render or flicker repros, typechecks, or other cheap tight loops",
							routine_fix: "Ordinary bug fixes, small features, refactors, or questions",
							hard_debug: "Subtle design, cross-cutting changes, architecture, or hard debugging",
							ui_review: "Reviewing a UI, screenshot, or visual layout (images may be present)",
							long_context: "Reading a large codebase or a long tree that needs a 1M-class window",
							micro: "A tiny one-shot: a short reply, a yes/no, or a one-word check",
						},
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
			return { ms: Date.now() - started, error: msg };
		}
	} catch (err) {
		const ms = Date.now() - started;
		const name = err instanceof Error ? err.name : "";
		if (name === "TimeoutError" || name === "AbortError") return { ms, error: "timeout" };
		return { ms, error: err instanceof Error ? err.message : String(err) };
	}
	const ms = Date.now() - started;
	const usage = (body.usage ?? {}) as { input_tokens?: number; input?: number };
	const inputTokens = usage.input_tokens ?? usage.input;
	const cost = inputTokens != null ? (inputTokens / 1_000_000) * 0.04 : undefined;
	const base = { ms, inputTokens, cost };
	const answers = (body.answers ?? {}) as Record<string, Record<string, unknown>>;
	const answer = answers.task;
	if (!answer) return { ...base, error: "Jev returned no task answer" };
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
	if (!choice || !isTaskKind(choice)) return { ...base, error: `unexpected Jev answer: ${JSON.stringify(answer).slice(0, 200)}` };
	return { ...base, task: choice, confidence };
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

export default function (pi: ExtensionAPI) {
	const keyRef = process.env.CMD_API_KEY
		? "$CMD_API_KEY"
		: process.env.COMMAND_CODE_API_KEY
			? "$COMMAND_CODE_API_KEY"
			: undefined;
	if (keyRef) {
		// Registered so /router status can see the classifier id. Classification
		// itself uses the Provider API in classify() — pi does not attach a
		// System One implementation to a custom provider from a local extension.
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
					contextWindow: 32_000,
				},
			],
		});
	}

	const route = async (
		request: ModelRouteRequest<RouterState>,
		ctx: ExtensionContext,
	): Promise<ModelRoute<RouterState>> => {
		const { config: cfg } = config();
		const { available, modelMeta } = catalog(ctx);
		const prompt = lastUserText(request.messages);
		const hasImages = lastUserHasImages(request.messages);
		const pin = pins.get(sessionKey(ctx)) ?? request.state?.pin;
		const forceJev = process.env.PI_ROUTER_FORCE_JEV === "1";

		let jevResult: LastDecision["jev"] | undefined;
		const guessed = forceJev ? undefined : heuristicTask(prompt, hasImages);
		const needsJev =
			request.reason === "user" &&
			!pin &&
			!subagentType() &&
			(forceJev || !guessed || guessed.confidence < 0.7);

		if (needsJev) {
			jevResult = await classify(cfg, ctx, prompt, request.signal);
		}

		const jevInput =
			jevResult && !jevResult.error && jevResult.task && jevResult.confidence != null
				? { task: jevResult.task as TaskKind, confidence: jevResult.confidence }
				: jevResult?.error
					? { error: jevResult.error }
					: undefined;

		const decision = decide(cfg, {
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
			jev: jevInput,
			forceJev,
			previousTask: request.state?.task,
		});

		writeLast({
			at: new Date().toISOString(),
			model: decision.model,
			task: decision.task,
			via: decision.via,
			reasons: decision.reasons,
			skipped: decision.skipped,
			reason: request.reason,
			jev: jevResult,
			promptPreview: prompt.replace(/\s+/g, " ").slice(0, 240),
		});

		const state: RouterState = { pin, task: decision.task };
		return routeTo(request, ctx, decision, state);
	};

	pi.registerVirtualModel<RouterState>({
		provider: "router",
		id: "auto",
		name: "Auto (plan-aware router)",
		thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		input: ["text", "image"],
		route,
	});

	pi.registerCommand("router", {
		description: "Model router: status | explain | pin [auto|free|hard|provider/id] | reload",
		handler: async (args, ctx) => {
			const argv = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const cmd = (argv[0] ?? "status").toLowerCase();
			if (cmd === "reload") {
				const loaded = reload();
				ctx.ui.notify(`reloaded ${loaded.source}\n${describeHardDebug(loaded.config, new Date())}`, "info");
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
			const loaded = config();
			const key = sessionKey(ctx);
			const pin = pins.get(key);
			const jevOk = !!(process.env.CMD_API_KEY || process.env.COMMAND_CODE_API_KEY);
			const lines = [
				`router/auto is opt-in (this session: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"})`,
				`config: ${loaded.source}`,
				describeHardDebug(loaded.config, new Date()),
				`Jev: ${jevOk ? `${loaded.config.jev.provider}/${loaded.config.jev.id} via Command Code /systemone` : "no CMD_API_KEY — heuristics only"}`,
				`pin: ${pin ?? "none (dynamic)"}`,
				`subagentPins: ${Object.keys(loaded.config.subagentPins).length ? JSON.stringify(loaded.config.subagentPins) : "(none — children inherit router/auto)"}`,
				last ? `last:\n${formatDecision(last)}` : "last: none yet",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
