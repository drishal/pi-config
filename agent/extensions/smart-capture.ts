/**
 * smart-capture — a write gate in front of mem0's automatic capture.
 *
 * pi-memory-mem0's own autoCapture sends a user/assistant pair to the mem0
 * extractor after every prompt, and the extractor stores whatever it finds —
 * plans, one-off debugging state, restated answers. This extension owns
 * capture instead (set `"autoCapture": false` on pi-memory-mem0) and only
 * hands a turn to mem0 when it is worth it:
 *
 *   1. Skip the obvious (free): slash commands, acknowledgements ("ok",
 *      "thanks", "go ahead"), empty or aborted replies.
 *   2. Judge (cheap): "does this exchange contain a durable fact?" — answered
 *      YES or NO, about 100 tokens.
 *   3. Store: YES goes to mem0 through its own provider, with its own config
 *      (customInstructions, scoping, dedup), so the write is identical to a
 *      normal capture.
 *
 * It judges the whole prompt, once, at agent_end: your message plus the
 * FINAL assistant answer — not the first streamed turn, which is usually
 * "let me check…" in front of a tool call.
 *
 * Both model calls — the judge and mem0's fact extraction — go through
 * microcall.ts (an isolated one-shot pi session), never a raw HTTP client:
 * mem0's extractor is handed an adapter through mem0ai's "langchain" LLM hook
 * (needs @langchain/core, which bootstrap.sh installs). So any provider pi
 * can reach works, including OpenCode Go, which rejects SDK traffic. The
 * model is microcall's chain (model-state.json "micro"), else mem0's own llm
 * from settings.json. mem0's embedder is unchanged: it is not a chat call.
 *
 * The provider, settings loader, project scoping and redaction are imported
 * from pi-memory-mem0 itself rather than re-implemented, so the gate writes to
 * exactly the namespace mem0 recalls from and cannot drift from it.
 * (pi-memory-mem0's own instance — its mem0_memory "add" and /mem0 add — still
 * builds its LLM from settings.json; recall and search need only embeddings.)
 *
 * Failure policy: if the judge errors or gives no clear answer, the turn is
 * stored anyway (mem0's extractor still filters). The gate's own mem0
 * instance starts on the first store, not at session start (see
 * session_start); if that fails — say llama-embed is down — it warns in the
 * TUI once, counts the turn as failed, and retries on the next store, since
 * with mem0's autoCapture off nothing else would save it.
 *
 * Commands:
 *   /mem0gate          status: why it is on/off, judge model, counters
 *   /mem0gate on|off   toggle for this session
 *   /mem0gate last     the most recent decision and why
 *
 * Config (env):
 *   MEM0_GATE=off         disable the gate (turn mem0's autoCapture back on
 *                         if you still want automatic capture)
 *   MEM0_GATE_MODEL=p/id  judge with this model instead of microcall's chain
 *   MEM0_GATE_DEBUG=1     log each decision to stderr
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";

/** microcall.ts publishes itself here (see its header for the contract). */
const MICROCALL = Symbol.for("pi.microcall");
type MicroCall = (req: {
	system: string;
	prompt: string;
	model?: string;
	defaultModel?: string;
	timeoutMs?: number;
	label?: string;
}) => Promise<{ text: string; model: string }>;

const SETTINGS_KEY = "pi-memory-mem0";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const PKG = join(AGENT_DIR, "npm", "node_modules", "@amaster.ai");
// pi loads extensions through jiti rooted in pi's own install, so bare
// "@amaster.ai/..." specifiers do not resolve from ~/.pi/agent/npm. Absolute
// paths do, and they keep working when this file is a symlink into dotfiles.
const MEM0_PROVIDER = join(PKG, "pi-memory-mem0", "dist", "provider.js");
const MEM0_PRIVACY = join(PKG, "pi-memory-mem0", "dist", "privacy.js");
const PI_SETTINGS = join(PKG, "pi-shared", "dist", "settings.js");

/** Per model in microcall's chain. mem0's extraction prompt is ~8k tokens. */
const JUDGE_TIMEOUT_MS = 30_000;
const EXTRACT_TIMEOUT_MS = 90_000;
const SHUTDOWN_WAIT_MS = 10_000;

const JUDGE_SYSTEM = "You gate long-term memory writes for a coding agent. Answer with exactly one word: YES or NO.";
const JUDGE_PROMPT = `Does this exchange contain a DURABLE fact worth remembering in future sessions?

DURABLE: the user's preferences and standing instructions, corrections ("no, use X not Y"), machine/environment setup, project layout or names, decisions the user made, where things live (never secret values).
NOT DURABLE: plans or intentions of the assistant, research in progress, one-off task details, transient debugging state, answers to a passing question, summaries of what was just done, file contents.

<user>
{user}
</user>
<assistant>
{assistant}
</assistant>`;

/** Messages that never carry a durable fact. */
const ACK = /^(ok(ay)?|k|thanks?( you)?|thx|ty|yes|yep|yeah|no|nope|sure|go( ahead)?|continue|proceed|do it|nice|cool|great|perfect|lgtm|done|(hi|hello|hey)( there| all)?)\b[\s!.,]*$/i;

type Registry = {
	getAll?(): Array<{ provider: string; id: string; baseUrl?: string; api?: string }>;
	getApiKeyForProvider?(provider: string): Promise<string | undefined>;
};
/** The slice of a LangChain message mem0ai's "langchain" LLM hands over. */
type LcMessage = { content: unknown; type?: string; _getType?(): string; getType?(): string };
type Provider = { add(messages: unknown[], opts: Record<string, unknown>): Promise<{ results?: unknown[] }> };
type Decision = { verdict: string; reason: string; user: string };

const stats = () => ({ seen: 0, skipped: 0, no: 0, yes: 0, unsure: 0, stored: 0, failed: 0 });

export default function (pi: ExtensionAPI) {
	const g = {
		enabled: (process.env.MEM0_GATE ?? "on").toLowerCase() !== "off",
		debug: process.env.MEM0_GATE_DEBUG === "1",
		/** Why the gate is idle, when it is. */
		idle: "not started" as string | undefined,
		provider: undefined as Provider | undefined,
		/** Deferred heavy mem0 init; armed at session_start, runs on first store. */
		ensure: undefined as undefined | (() => Promise<Provider | undefined>),
		/** Surfaces a failure where the user will see it (TUI notice, else stderr). */
		warn: (msg: string) => console.error(`[smart-capture] ${msg}`),
		redact: (t: string) => t,
		scope: {} as Record<string, string>,
		micro: undefined as MicroCall | undefined,
		/** mem0's own llm as "provider/id": microcall's fallback default. */
		llm: "",
		/** Model that answered the most recent judge call. */
		judgedBy: "",
		pending: Promise.resolve() as Promise<unknown>,
		last: undefined as Decision | undefined,
		stats: stats(),
		epoch: 0,
	};
	let lastUser = "";

	const log = (msg: string) => {
		if (g.debug) console.error(`[smart-capture] ${msg}`);
	};

	pi.on("session_start", async (_event, ctx) => {
		const epoch = ++g.epoch;
		g.provider = undefined;
		g.ensure = undefined;
		g.idle = "starting";
		g.stats = stats();
		g.last = undefined;
		lastUser = "";
		if (!g.enabled) {
			g.idle = "disabled (MEM0_GATE=off)";
			return;
		}
		let config: Record<string, any> = {};
		try {
			const settings = await import(PI_SETTINGS);
			config = settings.loadPiSettings(SETTINGS_KEY, {
				cwd: ctx.cwd,
				projectTrusted: settings.isProjectTrusted(ctx),
			});
			const memoryMode = config.memoryMode ?? "hybrid";
			if (config.autoCapture ?? memoryMode !== "active") {
				// mem0 captures on its own; gating as well would store twice.
				g.idle = 'mem0 autoCapture is on (set "autoCapture": false to gate)';
				return;
			}

			const micro = (globalThis as Record<symbol, unknown>)[MICROCALL] as MicroCall | undefined;
			if (!micro) throw new Error("microcall.ts is not loaded");
			const llmProvider = config.oss?.llm?.provider;
			const llmModel = config.oss?.llm?.config?.model;
			const llm = typeof llmProvider === "string" && typeof llmModel === "string" && llmProvider && llmModel
				? `${llmProvider}/${llmModel}`
				: "";

			// The embedder still resolves its key/base URL through pi's registry.
			const registry = ctx.modelRegistry as unknown as Registry;
			const resolveProvider = async (name: string) => {
				if (!registry.getApiKeyForProvider) return undefined;
				const model = registry.getAll?.().find((m) => m.provider === name);
				const apiKey = await registry.getApiKeyForProvider(name);
				if (!apiKey && !model) return undefined;
				return {
					...(apiKey ? { apiKey } : {}),
					...(model?.baseUrl ? { baseUrl: model.baseUrl } : {}),
					...(model?.api ? { api: model.api } : {}),
				};
			};
			// mem0ai's "langchain" LLM takes any object with invoke() and reads
			// `.content` back; this one answers through microcall.
			const extractor = {
				modelId: "pi-microcall",
				invoke: async (messages: LcMessage[]) => {
					const roleOf = (m: LcMessage) => m._getType?.() ?? m.getType?.() ?? m.type ?? "human";
					const text = (m: LcMessage) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
					const r = await micro({
						system: messages.filter((m) => roleOf(m) === "system").map(text).join("\n\n"),
						prompt: messages.filter((m) => roleOf(m) !== "system").map(text).join("\n\n"),
						defaultModel: llm || undefined,
						timeoutMs: EXTRACT_TIMEOUT_MS,
						label: "mem0 extract",
					});
					return { content: r.text };
				},
			};
			const gated = {
				...config,
				oss: { ...config.oss, llm: { provider: "langchain", config: { model: extractor } } },
			};
			const [{ createMem0Provider }, privacy] = await Promise.all([
				import(MEM0_PROVIDER),
				import(MEM0_PRIVACY),
			]);

			if (epoch !== g.epoch) return; // a newer session_start won
			const base = config.userId?.trim() || process.env.USER || process.env.USERNAME || "default-user";
			g.scope = {
				userId: privacy.scopeMemoryUserId(base, ctx.cwd, config.userIdScope),
				...(config.agentId?.trim() ? { agentId: config.agentId.trim() } : {}),
			};
			g.redact = privacy.redactMemoryText;
			g.micro = micro;
			g.llm = llm;
			g.idle = undefined;
			g.warn = (msg) => {
				if (epoch !== g.epoch) return; // that session's context is gone
				if (ctx.hasUI) ctx.ui.notify(`mem0gate: ${msg}`, "warning");
				else console.error(`[smart-capture] ${msg}`);
			};
			// Heavy init (~2s: sqlite, telemetry, embedding warmup) runs on the
			// first store, not here: pi awaits every session_start hook before
			// showing the TUI, and two mem0 instances initialising at once block
			// each other on the same SQLite files. Single-flight while running;
			// a failure is not cached, so the next store retries (e.g. once
			// llama-embed is back), and only the first failure in a row warns.
			let inflight: Promise<Provider | undefined> | undefined;
			let warned = false;
			g.ensure = () =>
				(inflight ??= (async () => {
					try {
						const provider = (await createMem0Provider({ config: gated, resolveProvider })) as Provider;
						if (epoch !== g.epoch) return undefined;
						g.provider = provider;
						g.idle = undefined;
						warned = false;
						return provider;
					} catch (err) {
						inflight = undefined;
						if (epoch !== g.epoch) return undefined;
						g.idle = `mem0 unavailable: ${err instanceof Error ? err.message : String(err)}`;
						// autoCapture is off, so without the gate nothing is saved at all.
						if (!warned) g.warn(`${g.idle} — memories are not being saved (retries on the next one)`);
						warned = true;
						return undefined;
					}
				})());
		} catch (err) {
			if (epoch !== g.epoch) return;
			g.idle = `init failed: ${err instanceof Error ? err.message : String(err)}`;
			// autoCapture is off, so without the gate nothing is saved at all.
			if (ctx.hasUI) ctx.ui.notify(`mem0gate ${g.idle} — memories are not being saved`, "warning");
			else console.error(`[smart-capture] ${g.idle}`);
		}
	});

	pi.on("input", async (event) => {
		const text = (event as { text?: string }).text?.trim();
		if (text) lastUser = text;
	});

	/** YES / NO / undefined (no clear answer). */
	async function judge(user: string, assistant: string): Promise<boolean | undefined> {
		if (!g.micro) return undefined;
		const r = await g.micro({
			system: JUDGE_SYSTEM,
			prompt: JUDGE_PROMPT.replace("{user}", user.slice(0, 2000)).replace("{assistant}", assistant.slice(-2000)),
			model: process.env.MEM0_GATE_MODEL?.includes("/") ? process.env.MEM0_GATE_MODEL : undefined,
			defaultModel: g.llm || undefined,
			timeoutMs: JUDGE_TIMEOUT_MS,
			label: "mem0 judge",
		});
		g.judgedBy = r.model;
		// The reply is answer text only; take the last YES/NO in case it explains.
		const words = r.text.toUpperCase().match(/\b(YES|NO)\b/g);
		return words ? words[words.length - 1] === "YES" : undefined;
	}

	pi.on("agent_end", async (event) => {
		const user = lastUser;
		lastUser = "";
		if (!user) return;
		// Not armed (disabled, autoCapture on, or init failed with no retry): nothing to do.
		if (!g.micro && !g.provider && !g.ensure) return;

		// The final answer: the last assistant message that has text.
		const messages = ((event as { messages?: unknown[] }).messages ?? []) as Array<{
			role?: string;
			stopReason?: string;
			content?: unknown;
		}>;
		const final = [...messages].reverse().find((m) => m.role === "assistant" && textOf(m.content));
		const assistant = final ? textOf(final.content) : "";
		g.stats.seen++;

		const skip = user.startsWith("/")
			? "slash command"
			: user.length < 6 || ACK.test(user)
				? "acknowledgement"
				: !assistant
					? "no answer"
					: final?.stopReason === "aborted" || final?.stopReason === "error"
						? `reply ${final.stopReason}`
						: undefined;
		if (skip) {
			g.stats.skipped++;
			g.last = { verdict: "skipped", reason: skip, user };
			log(`skip: ${skip}`);
			return;
		}

		// Heavy mem0 init starts only on a store verdict (YES/unsure), so NO
		// turns pay nothing. Store latency is background-only.
		const u = g.redact(user);
		const a = g.redact(assistant);
		let verdict: boolean | undefined;
		try {
			verdict = await judge(u, a);
		} catch (err) {
			log(`judge error: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (verdict === false) {
			g.stats.no++;
			g.last = { verdict: "not stored", reason: "judge: NO", user };
			log("judge: NO");
			return;
		}
		if (verdict === true) g.stats.yes++;
		else g.stats.unsure++;
		const decision: Decision = { verdict: "storing", reason: verdict ? "judge: YES" : "judge unsure (fail-open)", user };
		g.last = decision;
		log(decision.reason);

		const scope = g.scope;
		const ensure = g.ensure;
		g.pending = g.pending
			.catch(() => {})
			.then(async () => {
				const provider = g.provider ?? (await ensure?.());
				if (!provider) {
					// ensure() has already warned about why.
					g.stats.failed++;
					decision.verdict = "not stored";
					decision.reason += ` · ${g.idle ?? "mem0 unavailable"}`;
					return;
				}
				const result = await provider.add(
					[
						{ role: "user", content: u },
						{ role: "assistant", content: a },
					],
					scope,
				);
				const n = result?.results?.length ?? 0;
				if (n > 0) g.stats.stored++;
				decision.verdict = n > 0 ? "stored" : "nothing extracted";
			})
			.catch((err) => {
				const msg = err instanceof Error ? err.message : String(err);
				g.stats.failed++;
				decision.verdict = "not stored";
				decision.reason += ` · store failed: ${msg}`;
				g.warn(`store failed: ${msg}`);
			});
	});

	pi.on("session_shutdown", async () => {
		// pi waits on shutdown handlers with no timeout; never hang the exit.
		await Promise.race([g.pending, new Promise((r) => setTimeout(r, SHUTDOWN_WAIT_MS).unref?.())]);
	});

	pi.registerCommand("mem0gate", {
		description: "Smart memory gate: status | on | off | last",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();
			if (sub === "on" || sub === "off") {
				g.enabled = sub === "on";
				ctx.ui.notify(`mem0gate ${g.enabled ? "on" : "off"} for this session`, "info");
				return;
			}
			if (sub === "last") {
				const d = g.last;
				ctx.ui.notify(d ? `${d.verdict} — ${d.reason}\n» ${d.user.slice(0, 160)}` : "no decisions yet this session", "info");
				return;
			}
			const s = g.stats;
			const via = g.judgedBy || `microcall chain, else ${g.llm || "the session model"}`;
			const state = !g.enabled ? "OFF" : g.idle ? `idle: ${g.idle}` : `ON · judge ${via}`;
			ctx.ui.notify(
				`mem0gate ${state}\nprompts ${s.seen} · skipped ${s.skipped} · judged no ${s.no} · yes ${s.yes} · unsure ${s.unsure} · stored ${s.stored} · failed ${s.failed}`,
				"info",
			);
		},
	});

	function textOf(content: unknown): string {
		if (typeof content === "string") return content.trim();
		if (!Array.isArray(content)) return "";
		return content
			.filter((c) => c?.type === "text" && typeof c.text === "string")
			.map((c) => c.text)
			.join("\n")
			.trim();
	}
}
