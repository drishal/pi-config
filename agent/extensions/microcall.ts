/**
 * microcall — one-shot model calls for other extensions, made by a tiny,
 * isolated pi session instead of a raw HTTP client.
 *
 * Extensions that need a small side answer (a YES/NO judge, a JSON fact
 * extraction) used to POST to the provider themselves. That breaks on
 * providers that only accept a real agent's traffic: OpenCode Go rejects any
 * request without pi's `x-opencode-session` header ("cannot be routed
 * efficiently"), and its terms want the client identified as itself, not as a
 * generic SDK. A microcall is a genuine pi AgentSession, so every request
 * carries exactly the headers the main session sends (pi's own
 * mergeProviderAttributionHeaders) and any provider pi can talk to works —
 * built-in, models.json, or registered by another extension (litellm-auto).
 *
 * Each call gets a fresh in-process session (~12 ms to build):
 *   - no extensions, skills, prompt templates or AGENTS.md — so memory
 *     extensions cannot recurse into their own calls
 *   - no tools unless the caller passes an explicit allow-list
 *   - the caller's system prompt verbatim, one user message
 *   - in-memory session and settings: no session file, no compaction, no
 *     retries (the fallback chain retries instead), cache warming off
 *   - thinking "off" unless asked for
 *
 * Model chain (first that answers wins; an error, timeout or empty reply
 * moves on to the next):
 *   1. request.model                         a caller override
 *   2. PI_MICRO_MODEL=p/id[,p/id…]           env, for one-off testing
 *   3. model-state.json "micro"              per machine, never synced:
 *        "micro": { "model": "p/id", "fallbacks": ["p/id", …] }
 *   4. request.defaultModel                  the caller's own default
 *   5. the session's current model
 *
 * API — other extensions look it up at call time, so load order is moot:
 *
 *   const micro = globalThis[Symbol.for("pi.microcall")];
 *   const { text, model } = await micro({ system, prompt, label: "judge" });
 *
 * /microcall          chain in effect + the last calls (model, ms, outcome)
 * /microcall test     a one-word round trip through the chain
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	createExtensionRuntime,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

type ThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

export interface MicroRequest {
	/** The whole system prompt; nothing is appended. */
	system: string;
	/** A single user message. */
	prompt: string;
	/** "provider/id" — overrides the configured chain. */
	model?: string;
	/** "provider/id" used when no chain is configured. */
	defaultModel?: string;
	/** Built-in tool allow-list; none by default. */
	tools?: string[];
	thinking?: ThinkingLevel;
	/** Per attempt, default 60 s. */
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Shown in /microcall. */
	label?: string;
}

export interface MicroResult {
	text: string;
	/** "provider/id" that answered. */
	model: string;
	ms: number;
	/** One line per model tried, including failures. */
	attempts: string[];
}

export type MicroCall = (request: MicroRequest) => Promise<MicroResult>;

export const MICROCALL = Symbol.for("pi.microcall");

const DEFAULT_TIMEOUT_MS = 60_000;
const LOG_SIZE = 20;
const STATE_PATH = path.join(getAgentDir(), "model-state.json");

interface Host {
	runtime: unknown;
	cwd: string;
	model?: { provider: string; id: string };
}

type LogEntry = { at: Date; label: string; model: string; ms: number; outcome: string };

function configuredChain(): { chain: string[]; source: string } {
	const env = process.env.PI_MICRO_MODEL?.trim();
	if (env) return { chain: env.split(",").map((s) => s.trim()).filter(Boolean), source: "PI_MICRO_MODEL" };
	try {
		const micro = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"))?.micro;
		const chain = [micro?.model, ...(Array.isArray(micro?.fallbacks) ? micro.fallbacks : [])].filter(
			(s): s is string => typeof s === "string" && s.includes("/"),
		);
		if (chain.length) return { chain, source: "model-state.json" };
	} catch {
		// No file, or no "micro" section: fall through to the caller's default.
	}
	return { chain: [], source: "" };
}

function splitSpec(spec: string): [string, string] {
	const i = spec.indexOf("/");
	return [spec.slice(0, i), spec.slice(i + 1)];
}

export default function (pi: ExtensionAPI) {
	let host: Host | undefined;
	const log: LogEntry[] = [];

	const remember = (entry: LogEntry) => {
		log.push(entry);
		if (log.length > LOG_SIZE) log.shift();
	};

	/** One attempt against one model. Throws on error, timeout or empty text. */
	async function attempt(h: Host, spec: string, req: MicroRequest): Promise<string> {
		const [provider, id] = splitSpec(spec);
		const runtime = h.runtime as { getModel(p: string, id: string): unknown };
		const model = runtime.getModel(provider, id);
		if (!model) throw new Error("unknown model");

		const system = req.system;
		const { session } = await createAgentSession({
			cwd: h.cwd,
			agentDir: getAgentDir(),
			model: model as never,
			thinkingLevel: req.thinking ?? "off",
			modelRuntime: runtime as never,
			resourceLoader: {
				getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
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
			},
			tools: req.tools ?? [],
			sessionManager: SessionManager.inMemory(h.cwd),
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: false },
				retry: { enabled: false },
				cacheWarming: "off",
			}),
		});

		let timer: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => void session.abort();
		req.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			await Promise.race([
				session.prompt(req.prompt),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						void session.abort();
						reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`));
					}, timeoutMs);
					timer.unref?.();
				}),
			]);
			if (req.signal?.aborted) throw new Error("aborted");
			const last = session.messages.at(-1) as { errorMessage?: string; stopReason?: string } | undefined;
			if (last?.errorMessage) throw new Error(last.errorMessage.split("\n")[0].slice(0, 200));
			const text = session.getLastAssistantText()?.trim();
			if (!text) throw new Error(`empty reply (${last?.stopReason ?? "no message"})`);
			return text;
		} finally {
			clearTimeout(timer);
			req.signal?.removeEventListener("abort", onAbort);
			session.dispose();
		}
	}

	const microcall: MicroCall = async (req) => {
		const h = host;
		if (!h) throw new Error("microcall: no session yet");
		const configured = req.model ? [req.model] : configuredChain().chain;
		const current = h.model ? `${h.model.provider}/${h.model.id}` : undefined;
		const chain = configured.length
			? configured
			: [req.defaultModel, current].filter((s): s is string => !!s?.includes("/"));
		if (!chain.length) throw new Error("microcall: no model configured");

		const label = req.label ?? "call";
		const attempts: string[] = [];
		const t0 = performance.now();
		for (const spec of chain) {
			const t = performance.now();
			try {
				const text = await attempt(h, spec, req);
				const ms = Math.round(performance.now() - t);
				attempts.push(`${spec}: ok ${ms}ms`);
				remember({ at: new Date(), label, model: spec, ms, outcome: "ok" });
				return { text, model: spec, ms: Math.round(performance.now() - t0), attempts };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				const ms = Math.round(performance.now() - t);
				attempts.push(`${spec}: ${msg}`);
				remember({ at: new Date(), label, model: spec, ms, outcome: msg });
				if (req.signal?.aborted) break;
			}
		}
		throw new Error(`microcall failed — ${attempts.join("; ")}`);
	};

	(globalThis as Record<symbol, unknown>)[MICROCALL] = microcall;

	const track = (ctx: ExtensionContext) => {
		host = {
			runtime: (ctx.modelRegistry as unknown as { runtime: unknown }).runtime,
			cwd: ctx.cwd,
			model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
		};
	};
	pi.on("session_start", async (_event, ctx) => track(ctx));
	pi.on("model_select", async (_event, ctx) => track(ctx));

	pi.registerCommand("microcall", {
		description: "Isolated one-shot model calls: status | test",
		handler: async (args, ctx) => {
			track(ctx);
			const { chain, source } = configuredChain();
			const head = chain.length
				? `chain (${source}): ${chain.join(" → ")}`
				: `chain: caller default, else the session model${host?.model ? ` (${host.model.provider}/${host.model.id})` : ""}`;
			if ((args ?? "").trim().toLowerCase() === "test") {
				try {
					const r = await microcall({
						system: "Reply with exactly one word: pong",
						prompt: "ping",
						label: "test",
						timeoutMs: 30_000,
					});
					ctx.ui.notify(`microcall ok — ${r.model} said "${r.text.slice(0, 40)}" in ${r.ms}ms\n${r.attempts.join("\n")}`, "info");
				} catch (err) {
					ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
				}
				return;
			}
			const lines = log
				.slice(-8)
				.reverse()
				.map((e) => `${e.at.toTimeString().slice(0, 8)} ${e.label} · ${e.model} · ${e.ms}ms · ${e.outcome.slice(0, 80)}`);
			ctx.ui.notify([head, ...(lines.length ? lines : ["no calls yet this session"])].join("\n"), "info");
		},
	});
}
