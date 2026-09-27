/**
 * The model behind capture and consolidation, in one of two modes:
 *
 *   "pi"  — a minimal isolated pi session (see microcall.ts). Required for
 *           providers that only accept a real coding agent's traffic, like
 *           OpenCode Go. Inside pi it goes through the microcall extension;
 *           from the CLI it builds the same kind of session from pi's SDK.
 *           `model` is "provider/id"; unset means the microcall chain.
 *
 *   "raw" — a plain OpenAI-compatible POST /chat/completions. For endpoints you
 *           run yourself (llama-server, vLLM, LM Studio) or providers whose
 *           terms allow direct API calls. `model` is the endpoint's model id.
 *
 * Configured in model-state.json under "memory.llm" (per machine, never
 * synced), e.g.
 *
 *   { "mode": "pi" }                                          microcall chain
 *   { "mode": "pi", "model": "opencode-go/deepseek-v4.1-flash" }
 *   { "mode": "raw", "baseUrl": "http://127.0.0.1:8081/v1", "model": "qwen35",
 *     "extraBody": { "chat_template_kwargs": { "enable_thinking": false } } }
 *   { "mode": "raw", "baseUrl": "https://api.example.com/v1", "model": "x",
 *     "apiKeyEnv": "EXAMPLE_API_KEY" }
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export interface LlmConfig {
	mode: "pi" | "raw";
	model?: string;
	/** raw: OpenAI-compatible base URL ending in /v1. */
	baseUrl?: string;
	/** raw: a literal key — prefer apiKeyEnv so the key stays out of the file. */
	apiKey?: string;
	apiKeyEnv?: string;
	/** raw: merged into the request body (temperature, chat_template_kwargs, …). */
	extraBody?: Record<string, unknown>;
	timeoutMs?: number;
}

export interface CallOptions {
	label?: string;
	signal?: AbortSignal;
}

export type Complete = (system: string, prompt: string, opts?: CallOptions) => Promise<{ text: string; model: string }>;

type MicroCall = (req: {
	system: string;
	prompt: string;
	model?: string;
	label?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}) => Promise<{ text: string; model: string }>;

const DEFAULT_TIMEOUT_MS = 90_000;
/** Providers whose terms forbid anything but pi's own agent traffic. */
const PI_ONLY_HOSTS = ["opencode.ai"];

/** Remove a reasoning model's <think> block if the endpoint left it in the content. */
export function stripThinking(text: string): string {
	return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

export function describe(cfg: LlmConfig): string {
	if (cfg.mode === "raw") return `raw ${cfg.model ?? "?"} @ ${cfg.baseUrl ?? "?"}`;
	return `pi ${cfg.model ?? "microcall chain"}`;
}

function raw(cfg: LlmConfig): Complete {
	const base = (cfg.baseUrl ?? "").replace(/\/+$/, "");
	if (!base) throw new Error('memory.llm: mode "raw" needs a baseUrl');
	if (PI_ONLY_HOSTS.some((h) => base.includes(h)))
		throw new Error(`memory.llm: ${base} only accepts pi's own traffic — use mode "pi" for it`);
	return async (system, prompt, opts = {}) => {
		const key = cfg.apiKey ?? (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined);
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		const onAbort = () => ctrl.abort();
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const res = await fetch(`${base}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
				body: JSON.stringify({
					model: cfg.model ?? "default",
					temperature: 0,
					// A runaway generation must end: capture output is a few hundred tokens.
					max_tokens: 4096,
					messages: [
						{ role: "system", content: system },
						{ role: "user", content: prompt },
					],
					...cfg.extraBody,
				}),
				signal: ctrl.signal,
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
			const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
			const text = stripThinking(body.choices?.[0]?.message?.content ?? "");
			if (!text) throw new Error("empty reply");
			return { text, model: cfg.model ?? "default" };
		} finally {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
		}
	};
}

/** Inside pi: the microcall extension (same session isolation, same fallback chain). */
function viaMicrocall(cfg: LlmConfig): Complete {
	return async (system, prompt, opts = {}) => {
		const micro = (globalThis as Record<symbol, unknown>)[Symbol.for("pi.microcall")] as MicroCall | undefined;
		if (!micro) throw new Error('memory.llm: mode "pi" needs the microcall extension loaded');
		const r = await micro({
			system,
			prompt,
			model: cfg.model,
			label: opts.label ?? "memory",
			signal: opts.signal,
			timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		});
		return { text: stripThinking(r.text), model: r.model };
	};
}

// ── Outside pi (the CLI): build the isolated session from pi's own SDK ──────

type Sdk = typeof import("@earendil-works/pi-coding-agent");

/** pi's installed package, found through the `pi` on PATH — the CLI has no node_modules of its own. */
async function loadSdk(): Promise<Sdk> {
	const override = process.env.PI_SDK_PATH;
	let dir = override;
	if (!dir) {
		const bin = execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf-8" }).trim();
		let p = fs.realpathSync(bin);
		while (p !== path.dirname(p) && !fs.existsSync(path.join(p, "package.json"))) p = path.dirname(p);
		dir = p;
	}
	return (await import(pathToFileURL(path.join(dir, "dist", "index.js")).href)) as Sdk;
}

function microChain(agentDir: string): string[] {
	const env = process.env.PI_MICRO_MODEL?.trim();
	if (env) return env.split(",").map((s) => s.trim()).filter(Boolean);
	try {
		const micro = JSON.parse(fs.readFileSync(path.join(agentDir, "model-state.json"), "utf-8"))?.micro;
		return [micro?.model, ...(Array.isArray(micro?.fallbacks) ? micro.fallbacks : [])].filter(
			(s): s is string => typeof s === "string" && s.includes("/"),
		);
	} catch {
		return [];
	}
}

function standalonePi(cfg: LlmConfig, agentDir: string): Complete {
	let ready: Promise<{ sdk: Sdk; runtime: unknown }> | undefined;
	const init = () => {
		ready ??= (async () => {
			const sdk = await loadSdk();
			const runtime = await sdk.ModelRuntime.create({
				authPath: path.join(agentDir, "auth.json"),
				modelsPath: path.join(agentDir, "models.json"),
			});
			return { sdk, runtime };
		})();
		return ready;
	};

	const attempt = async (spec: string, system: string, prompt: string, signal?: AbortSignal): Promise<string> => {
		const { sdk, runtime } = await init();
		const i = spec.indexOf("/");
		const model = (runtime as { getModel(p: string, id: string): unknown }).getModel(spec.slice(0, i), spec.slice(i + 1));
		if (!model) throw new Error(`unknown model ${spec}`);
		const cwd = os.tmpdir();
		const { session } = await sdk.createAgentSession({
			cwd,
			agentDir,
			model: model as never,
			thinkingLevel: "off",
			modelRuntime: runtime as never,
			resourceLoader: {
				getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }),
				getSkills: () => ({ skills: [], diagnostics: [] }),
				getPrompts: () => ({ prompts: [], diagnostics: [] }),
				getThemes: () => ({ themes: [], diagnostics: [] }),
				getAgentsFiles: () => ({ agentsFiles: [] }),
				getSystemPrompt: () => system,
				getSystemPromptSource: () => undefined,
				getAppendSystemPrompt: () => [],
				getAppendSystemPromptSources: () => [],
				extendResources: () => {},
				reload: async () => {},
			} as never,
			tools: [],
			sessionManager: sdk.SessionManager.inMemory(cwd),
			settingsManager: sdk.SettingsManager.inMemory({
				compaction: { enabled: false },
				retry: { enabled: false },
				cacheWarming: "off",
			} as never),
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => void session.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const ms = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			await Promise.race([
				session.prompt(prompt),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						void session.abort();
						reject(new Error(`timed out after ${Math.round(ms / 1000)}s`));
					}, ms);
				}),
			]);
			const last = session.messages.at(-1) as { errorMessage?: string } | undefined;
			if (last?.errorMessage) throw new Error(last.errorMessage.split("\n")[0].slice(0, 200));
			const text = session.getLastAssistantText()?.trim();
			if (!text) throw new Error("empty reply");
			return text;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			session.dispose();
		}
	};

	return async (system, prompt, opts = {}) => {
		const chain = cfg.model ? [cfg.model] : microChain(agentDir);
		if (!chain.length) throw new Error('memory.llm: mode "pi" needs a model (or a "micro" chain in model-state.json)');
		const errors: string[] = [];
		for (const spec of chain) {
			try {
				return { text: stripThinking(await attempt(spec, system, prompt, opts.signal)), model: spec };
			} catch (err) {
				errors.push(`${spec}: ${err instanceof Error ? err.message : String(err)}`);
				if (opts.signal?.aborted) break;
			}
		}
		throw new Error(`memory llm failed — ${errors.join("; ")}`);
	};
}

/** `inPi` picks microcall over a self-built session for mode "pi". */
export function makeLlm(cfg: LlmConfig, opts: { inPi: boolean; agentDir: string }): Complete {
	if (cfg.mode === "raw") return raw(cfg);
	return opts.inPi ? viaMicrocall(cfg) : standalonePi(cfg, opts.agentDir);
}
