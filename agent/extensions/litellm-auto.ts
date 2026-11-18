/**
 * litellm-auto — native LiteLLM provider with login and dynamic discovery.
 *
 * /login asks for the complete /v1 gateway URL and API key, validates the
 * gateway, then pi saves both in auth.json as an api_key credential with
 * env.LITELLM_BASE_URL. /logout removes that pair. No setup script is needed.
 *
 * Existing setups stay compatible: environment variables, followed by stored
 * auth and legacy secrets files, supply the endpoint/key. A customized endpoint
 * uses only keys from the same configuration source (never another gateway's).
 * The model cache binds each snapshot to its URL so an endpoint change cannot
 * briefly offer models from the old gateway.
 *
 * caches: ~/.pi/agent/litellm-models-cache.json (metadata only, no secrets).
 * Env: LITELLM_PROVIDER, LITELLM_CACHE_PATH, LITELLM_CACHE_TTL_MS (default 30m),
 * LITELLM_TIMEOUT_MS (default 4000), LITELLM_EXCLUDE, LITELLM_VERBOSE.
 *
 * Every chat model gets reasoning: true, the full off..max thinking map, plus
 * compat.supportsReasoningEffort. models.json modelOverrides remains the final
 * per-model override layer; do not add a models array there.
 *
 * Requires pi 1.5+ native-provider authentication. OpenAI-compatible request
 * handling stays in pi; this file owns endpoint/key resolution and discovery.
 */

import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ApiKeyCredential, AuthContext, Model, Provider, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SECRETS_DIR = join(homedir(), ".pi", "secrets");
const BASE_URL_ENV = "LITELLM_BASE_URL";
const DEFAULT_PROVIDER = "litellm";
const FALLBACK_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_TOKENS = 32000;
const DEFAULT_CACHE_TTL_MS = 30 * 60_000;
const DEFAULT_TIMEOUT_MS = 4000;

type DiscoveredModel = Model<"openai-completions">;
type DiscoveryResult = {
	models: DiscoveredModel[];
	skipped: string[];
	source: string;
};
type CacheFile = {
	version: 2;
	fetchedAt: string;
	source: string;
	baseUrl: string;
	models: DiscoveredModel[];
	skipped: string[];
};

interface ModelInfoEntry {
	model_name: string;
	litellm_params?: { model?: string };
	model_info?: {
		max_model_len?: number | null;
		supports_vision?: boolean | null;
		mode?: string | null;
	} | null;
}

const NON_CHAT_PATTERNS = [/embed/i, /rerank/i, /\bbge\b/i, /retriev/i, /sentence/i];
const THINKING_LEVEL_MAP = {
	off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max",
} as const;

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

async function readSecret(name: string): Promise<string | undefined> {
	try {
		return (await readFile(join(SECRETS_DIR, name), "utf8")).trim() || undefined;
	} catch {
		return undefined;
	}
}

async function readStoredCredential(provider: string): Promise<ApiKeyCredential | undefined> {
	try {
		const parsed = JSON.parse(await readFile(join(agentDir(), "auth.json"), "utf8"))?.[provider];
		const credential = typeof parsed === "string" ? { key: parsed } : parsed;
		if (credential?.type && credential.type !== "api_key") return undefined;
		return { type: "api_key", key: credential?.key, env: credential?.env };
	} catch {
		return undefined;
	}
}

function normalizeBaseUrl(value: string): string {
	const trimmed = value.trim().replace(/\/+$/, "");
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error("Enter the complete gateway URL, including /v1 (for example http://gateway.example.com:8085/v1)");
	}
	if (!/^https?:$/.test(url.protocol) || !url.hostname || url.search || url.hash || url.password || url.username) {
		throw new Error("The gateway must be an HTTP(S) URL without credentials, query, or fragment");
	}
	if (!url.pathname.replace(/\/+$/, "").endsWith("/v1")) {
		throw new Error("The gateway URL must end in /v1 (for example http://gateway.example.com:8085/v1)");
	}
	return trimmed;
}

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const commandKeyCache = new Map<string, string | undefined>();
/** Match pi auth.json resolution for keys: literal, !command, and $ENV. */
async function resolveKeyField(value: string): Promise<string | undefined> {
	if (value.startsWith("$$")) return `$${value.slice(2)}` || undefined;
	if (value.startsWith("$!")) return `!${value.slice(2)}` || undefined;
	if (value.startsWith("!")) {
		const command = value.slice(1);
		if (commandKeyCache.has(command)) return commandKeyCache.get(command);
		let output: string | undefined;
		try {
			const { execFile } = await import("node:child_process");
			const { promisify } = await import("node:util");
			const { stdout } = await promisify(execFile)(process.env.SHELL || "/bin/sh", ["-c", command], {
				timeout: 10_000,
				maxBuffer: 1 << 20,
			});
			output = stdout.trim() || undefined;
		} catch {
			output = undefined;
		}
		commandKeyCache.set(command, output);
		return output;
	}
	if (value.includes("$")) {
		let unresolved = false;
		const result = value.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (_match, braced?: string, bare?: string) => {
			const replacement = process.env[(braced ?? bare) as string];
			if (replacement === undefined) unresolved = true;
			return replacement ?? "";
		});
		return unresolved ? undefined : result.trim() || undefined;
	}
	return value || undefined;
}

let excludeCache: RegExp[] | undefined;
function excludePatterns(): RegExp[] {
	if (excludeCache) return excludeCache;
	excludeCache = (process.env.LITELLM_EXCLUDE ?? "").split(",").map((value) => value.trim()).filter(Boolean).map(
		(pattern) => new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}$`, "i"),
	);
	return excludeCache;
}

function toModelConfig(entry: ModelInfoEntry, provider: string, baseUrl: string): DiscoveredModel {
	const length = entry.model_info?.max_model_len;
	const contextWindow = typeof length === "number" && length > 0 ? length : FALLBACK_CONTEXT_WINDOW;
	return {
		id: entry.model_name,
		name: entry.model_name,
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: true,
		thinkingLevelMap: THINKING_LEVEL_MAP,
		input: entry.model_info?.supports_vision === true ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: Math.min(DEFAULT_MAX_TOKENS, Math.floor(contextWindow / 4)),
		compat: { maxTokensField: "max_tokens", supportsReasoningEffort: true },
	};
}

async function fetchJson<T>(url: string, key: string, timeoutMs: number, signal: AbortSignal) {
	try {
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.any([signal, ...(timeoutMs > 0 ? [AbortSignal.timeout(timeoutMs)] : [])]),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
		return { ok: true, data: await response.json() as T } as const;
	} catch (error) {
		if (signal.aborted) throw error;
		return { ok: false, error: error instanceof Error ? error.message : String(error) } as const;
	}
}

async function discover(
	root: string, key: string, timeoutMs: number, signal: AbortSignal, provider: string,
): Promise<{ ok: true; result: DiscoveryResult } | { ok: false; error: string }> {
	// info has real windows/vision; the standard ID list may include extra teams.
	const [info, list] = await Promise.all([
		fetchJson<{ data?: ModelInfoEntry[] }>(`${root}/model/info`, key, timeoutMs, signal),
		fetchJson<{ data?: { id: string }[] }>(`${root}/models`, key, timeoutMs, signal),
	]);
	if (!info.ok && !list.ok) return { ok: false, error: `gateway rejected configuration (model/info: ${info.error}; models: ${list.error})` };

	const byName = new Map<string, ModelInfoEntry>();
	for (const entry of info.ok ? info.data.data ?? [] : []) if (entry.model_name) byName.set(entry.model_name, entry);
	for (const model of list.ok ? list.data.data ?? [] : []) {
		if (model.id && !byName.has(model.id)) byName.set(model.id, { model_name: model.id });
	}
	const excluded = process.env.LITELLM_INCLUDE_DEAD === "1" ? [] : excludePatterns();
	const skipped: string[] = [];
	const models = [...byName.values()].filter((entry) => {
		const mode = entry.model_info?.mode;
		if (typeof mode === "string" && mode.length > 0) return mode === "chat";
		return !NON_CHAT_PATTERNS.some((pattern) => pattern.test(entry.model_name) || pattern.test(entry.litellm_params?.model ?? ""));
	}).map((entry) => toModelConfig(entry, provider, root)).filter((model) => {
		if (!model.id) return false;
		if (!excluded.some((pattern) => pattern.test(model.id))) return true;
		skipped.push(model.id);
		return false;
	});
	if (!models.length) return { ok: false, error: "no chat models discovered" };
	return {
		ok: true,
		result: { models, skipped, source: `${info.ok ? "model/info" : ""}${info.ok && list.ok ? "+" : ""}${list.ok ? "models" : ""}` },
	};
}

function snapshotKey(models: readonly DiscoveredModel[]): string {
	// Plain comparison avoids localeCompare's ~8ms ICU initialization at startup.
	return JSON.stringify([...models].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(
		(model) => [model.id, model.reasoning, model.thinkingLevelMap, model.input, model.contextWindow, model.maxTokens],
	));
}

function cacheAgeMs(timestamp: string | undefined): number {
	const time = timestamp ? Date.parse(timestamp) : NaN;
	return Number.isFinite(time) ? Date.now() - time : Number.POSITIVE_INFINITY;
}

export function buildLitellmProvider(providerId: string): Provider<"openai-completions"> {
	const cachePath = process.env.LITELLM_CACHE_PATH ?? join(agentDir(), "litellm-models-cache.json");
	const ttlMs = envInt("LITELLM_CACHE_TTL_MS", DEFAULT_CACHE_TTL_MS);
	const timeoutMs = envInt("LITELLM_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
	let models: DiscoveredModel[] = [];
	let currentUrl: string | undefined;
	let cachedKey: string | undefined;
	let fetchedAt: string | undefined;
	let refreshInFlight: Promise<void> | undefined;

	type Resolved = { baseUrl: string; apiKey: string; source: string };
	async function resolveConfig(ctx: AuthContext, credential: ApiKeyCredential | undefined, signal: AbortSignal): Promise<Resolved | undefined> {
		signal.throwIfAborted();
		const savedKey = credential?.key;
		const storedKey = savedKey && (savedKey.startsWith("!") || savedKey.includes("$")) ? await resolveKeyField(savedKey) : savedKey;
		const envUrl = (await ctx.env(BASE_URL_ENV))?.trim();
		const envKey = (await ctx.env("LITELLM_API_KEY"))?.trim();
		const secretUrl = await readSecret("litellm.url");
		const secretKey = await readSecret("litellm.key");
		const baseUrl = envUrl || credential?.env?.[BASE_URL_ENV] || secretUrl;
		// Preserve existing installations: env URL/key first, then stored auth
		// (including its /login endpoint), finally the legacy secrets files.
		const apiKey = envKey || storedKey || secretKey;
		if (!baseUrl || !apiKey) return undefined;
		return {
			baseUrl: normalizeBaseUrl(baseUrl),
			apiKey,
			source: envUrl || envKey ? "environment LiteLLM config" : "stored LiteLLM config",
		};
	}

	async function loadCache(baseUrl: string, legacy: boolean): Promise<DiscoveredModel[]> {
		try {
			const raw = JSON.parse(await readFile(cachePath, "utf-8")) as CacheFile;
			if (!Array.isArray(raw.models) || !raw.models.length) return [];
			// v2 matches its endpoint. v1 only migrates the legacy env/file setup;
			// it is not carried into a newly saved /login credential.
			if (raw.version === 2 ? raw.baseUrl !== baseUrl : !legacy) return [];
			if (raw.models.some((model) => model.provider && model.provider !== providerId)) return [];
			models = raw.models.map((model) => ({ ...model, provider: providerId, baseUrl }));
			cachedKey = snapshotKey(models);
			fetchedAt = raw.fetchedAt;
			return models;
		} catch {
			return [];
		}
	}

	async function writeCache(baseUrl: string, result: DiscoveryResult): Promise<void> {
		const cache: CacheFile = { version: 2, fetchedAt: new Date().toISOString(), baseUrl, ...result };
		const temporary = `${cachePath}.tmp`;
		await writeFile(temporary, JSON.stringify(cache, null, "\t"), { mode: 0o600 });
		await rename(temporary, cachePath);
		cachedKey = snapshotKey(result.models);
		fetchedAt = cache.fetchedAt;
	}

	async function refreshModels(context: RefreshModelsContext): Promise<void> {
		const stored = await readStoredCredential(providerId);
		const refreshed = context.credential?.type === "api_key" ? context.credential : undefined;
		// pi's refresh layer deliberately gives providers a reconstructed key-only
		// credential. Retain our endpoint metadata during that network discovery.
		const credential: ApiKeyCredential | undefined = refreshed
			? { ...refreshed, env: refreshed.env ?? stored?.env }
			: stored;
		const resolved = await resolveConfig({ env: async (name) => process.env[name], fileExists: async () => false }, credential, context.signal);
		if (!resolved) {
			currentUrl = undefined;
			models = [];
			await context.publish({});
			return;
		}

		const cached = await loadCache(resolved.baseUrl, Boolean(process.env[BASE_URL_ENV]) || !credential?.env?.[BASE_URL_ENV]);
		models = cached;
		currentUrl = resolved.baseUrl;
		await context.publish({});
		if (!context.allowNetwork || context.signal.aborted) return;
		if (!context.force && cached.length > 0 && cacheAgeMs(fetchedAt) < ttlMs) return;

		if (!refreshInFlight) {
			refreshInFlight = (async () => {
				const fetched = await discover(resolved.baseUrl, resolved.apiKey, timeoutMs, context.signal, providerId);
				if (!fetched.ok) {
					if (context.force) throw new Error(fetched.error);
					console.error(`[litellm-auto] refresh failed: ${fetched.error} — keeping ${models.length} cached models`);
					return;
				}
				// A newer login wins if the endpoint changes during a slow fetch.
				if (currentUrl !== resolved.baseUrl) return;
				if (cachedKey !== snapshotKey(fetched.result.models) || !fetchedAt) await writeCache(resolved.baseUrl, fetched.result);
				models = fetched.result.models;
				await context.publish({});
				if (process.env.LITELLM_VERBOSE === "1") {
					console.log(`[litellm-auto] ${models.length} models discovered (${fetched.result.source})`);
				}
			})();
		}
		try {
			await refreshInFlight;
		} finally {
			refreshInFlight = undefined;
		}
	}

	const completions = openAICompletionsApi();
	return {
		id: providerId,
		name: "LiteLLM",
		auth: {
			apiKey: {
				name: "LiteLLM gateway URL and API key",
				async login(interaction) {
					const url = await interaction.prompt({
						type: "text",
						message: "LiteLLM gateway URL (including /v1)",
						placeholder: "http://gateway.example.com:8085/v1",
					});
					const baseUrl = normalizeBaseUrl(url);
					const key = (await interaction.prompt({ type: "secret", message: "LiteLLM API key" })).trim();
					if (!key) throw new Error("LiteLLM API key cannot be empty");
					interaction.notify({ type: "progress", message: `Checking ${baseUrl}/models…` });
					const result = await discover(baseUrl, key, timeoutMs, interaction.signal, providerId);
					if (!result.ok) throw new Error(result.error);
					interaction.notify({ type: "info", message: `Verified gateway; found ${result.result.models.length} chat models` });
					return { type: "api_key", key, env: { [BASE_URL_ENV]: baseUrl } };
				},
				async resolve({ ctx, credential, signal }) {
					const resolved = await resolveConfig(ctx, credential, signal);
					if (!resolved) {
						// /logout makes the stored setup unavailable immediately.
						currentUrl = undefined;
						models = [];
						return undefined;
					}
					if (currentUrl && currentUrl !== resolved.baseUrl) models = [];
					currentUrl = resolved.baseUrl;
					return {
						auth: { apiKey: resolved.apiKey, baseUrl: resolved.baseUrl },
						env: { [BASE_URL_ENV]: resolved.baseUrl },
						source: resolved.source,
					};
				},
			},
		},
		getModels: () => models,
		refreshModels,
		stream: (model, context, options) => completions.stream(model, context, options),
		streamSimple: (model, context, options) => completions.streamSimple(model, context, options),
	};
}

async function publishInitialization(): Promise<boolean> {
	return true;
}

export default async function (pi: ExtensionAPI): Promise<void> {
	const providerId = process.env.LITELLM_PROVIDER ?? DEFAULT_PROVIDER;
	const provider = buildLitellmProvider(providerId);
	const offline = /^(?:1|true|yes)$/i.test(process.env.PI_OFFLINE ?? "");
	// Load legacy file/environment configuration before registering, so cached
	// models are available from the first provider snapshot. First-run discovery
	// is bounded and uses the same native refresh contract as later refreshes.
	await provider.refreshModels?.({
		credential: await readStoredCredential(providerId),
		allowNetwork: !offline,
		publish: publishInitialization,
		signal: new AbortController().signal,
	});
	pi.registerProvider(provider);

	pi.registerCommand("reload-local", {
		description: "Re-fetch LiteLLM model list and update the provider cache",
		handler: async (_args, ctx) => {
			const result = await ctx.modelRegistry.refresh({ providers: [providerId], force: true });
			const error = result.errors.get(providerId);
			if (error) ctx.ui.notify(`[litellm-auto] ${error.message}`, "error");
			else ctx.ui.notify("[litellm-auto] model list refreshed", "info");
		},
	});
}
