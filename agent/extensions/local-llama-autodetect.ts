/**
 * local-llama-autodetect
 *
 * Auto-detects a running llama.cpp `llama-server`, probes /props and /v1/models,
 * and registers a provider that replaces the static "local-model" entry that used
 * to live in ~/.pi/agent/models.json with live values:
 *
 *   - model id: server model_alias, else the GGUF filename (extension stripped)
 *   - contextWindow: n_ctx from /props
 *   - maxTokens: n_predict if set, else n_ctx (unlimited thinking within the window)
 *   - thinkingLevelMap: full llama.cpp reasoning_effort range (none/minimal/low/medium/
 *     high/xhigh/max) so every thinking level is selectable via /model
 *   - input modalities: ["text"] or ["text", "image"] based on /props modalities
 *
 * Server URL resolution order (first one answering /props wins):
 *   1. $LOCAL_LLAMA_URL          (e.g. http://localhost:8081)
 *   2. baseUrl of the "local-model" provider in ~/.pi/agent/models.json (if present)
 *   3. http://localhost:8081     (default)
 *   4. http://localhost:8080     (llama-server stock default, secondary fallback)
 *
 * /local-model  -> re-detect (use after restarting llama-server with another model)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const PROVIDER_ID = "local-model";

interface LlamaProps {
	model_alias?: string;
	model_path?: string;
	total_slots?: number;
	is_sleeping?: boolean;
	modalities?: { vision?: boolean; audio?: boolean; video?: boolean };
	default_generation_settings?: {
		n_ctx?: number;
		params?: { n_predict?: number };
	};
}

interface Detection {
	baseUrl: string;
	modelId: string;
	displayName: string;
	contextWindow: number;
	maxTokens: number;
	vision: boolean;
}

function candidateUrls(): string[] {
	const urls: string[] = [];
	if (process.env.LOCAL_LLAMA_URL) {
		// Explicit override is authoritative: probe only that URL, never fall back
		// to another port (could hit a different server).
		return [process.env.LOCAL_LLAMA_URL.replace(/\/+$/, "")];
	}
	// Fall back to the old static models.json entry (baseUrl only)
	try {
		const raw = readFileSync(join(homedir(), ".pi/agent/models.json"), "utf8");
		const cfg = JSON.parse(raw) as {
			providers?: Record<string, { baseUrl?: string }>;
		};
		const baseUrl = cfg.providers?.[PROVIDER_ID]?.baseUrl;
		if (baseUrl) urls.push(baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, ""));
	} catch {
		// models.json missing/unreadable -> defaults below
	}
	// default port + llama-server's stock default as secondary fallback
	urls.push("http://localhost:8081", "http://localhost:8080");
	return [...new Set(urls)];
}

function describeUrls(): string {
	return candidateUrls().join(", ");
}

function prettyName(path: string): string {
	let name = basename(path).replace(/\.gguf$/i, "");
	// Trim quant suffix noise: "Model-Q6_K" -> "Model"
	name = name.replace(/[-_.](Q\d[_K]*|IQ\d_\w+|i?Q\d_\w+|BF16|F16|F32|FP16|UD-\w+)$/i, "");
	return name || "Local Llama";
}

function heuristicVision(modelName: string): boolean {
	return /llava|vision|-vl|internvl|minicpm-v|gemma-3|pixtral|mllama|moondream|qwen2\.?5-?vl|qwen3-?vl/i.test(modelName);
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T | undefined> {
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		const res = await fetch(url, { signal: ctrl.signal });
		clearTimeout(timer);
		if (!res.ok) return undefined;
		return (await res.json()) as T;
	} catch {
		return undefined;
	}
}

async function detect(baseUrl: string, timeoutMs = 2500): Promise<Detection | undefined> {
	const props = await fetchJson<LlamaProps>(`${baseUrl}/props`, timeoutMs);
	if (!props) return undefined;

	const modelsRes = await fetchJson<{ data?: Array<{ id?: string }> }>(
		`${baseUrl}/v1/models`,
		timeoutMs,
	);

	const rawId =
		(props.model_alias && props.model_alias.trim()) ||
		modelsRes?.data?.[0]?.id ||
		props.model_path ||
		"local-model";

	const nCtx = props.default_generation_settings?.n_ctx ?? 131072;
	const nPredict = props.default_generation_settings?.params?.n_predict ?? -1;
	// Thinking budget is UNLIMITED within the context window. The old Math.min(nCtx, 32768)
	// silently capped output at 32k tokens no matter how much ctx the server advertised, which
	// truncated a legitimate xhigh run mid-deliberation at exactly 32,768 (2^15) while 72k of
	// the 114,688 window was still free (`truncated = 0`, n_tokens 42,774). llama.cpp still
	// stops at n_ctx - n_prompt, so nCtx is an upper bound, not an allocation.
	// ⚠ This also removes the de-facto runaway circuit-breaker: a non-terminating generation
	// now runs until the context fills instead of self-limiting at 32k.
	const maxTokens = nPredict > 0 ? nPredict : nCtx;

	const vision =
		props.modalities?.vision === true ||
		(props.modalities === undefined && heuristicVision(rawId));

	return {
		baseUrl,
		modelId: basename(rawId).replace(/\.gguf$/i, "") || rawId,
		displayName: props.model_path ? prettyName(props.model_path) : "Local Llama (llama.cpp)",
		contextWindow: nCtx,
		maxTokens,
		vision,
	};
}

async function detectFirst(): Promise<Detection | undefined> {
	for (const url of candidateUrls()) {
		const d = await detect(url);
		if (d) return d;
	}
	return undefined;
}

function widgetLines(det: Detection): string[] {
	return [
		`local-model: ${det.modelId}  ctx=${det.contextWindow.toLocaleString()}  out=${det.maxTokens.toLocaleString()}  vision=${det.vision ? "yes" : "no"}  (${det.baseUrl})`,
	];
}

// Only surface the status widget while the local-model provider is the active model;
// hide it the rest of the time.
function syncWidget(ctx: ExtensionContext, det: Detection | undefined): void {
	if (ctx.model?.provider !== PROVIDER_ID) {
		ctx.ui.setWidget(PROVIDER_ID, undefined);
		return;
	}
	if (det) {
		ctx.ui.setWidget(PROVIDER_ID, widgetLines(det));
	} else {
		ctx.ui.setWidget(PROVIDER_ID, [
			`local-model: no llama-server detected (tried ${describeUrls()})`,
		]);
	}
}

function register(pi: ExtensionAPI, det: Detection): void {
	pi.registerProvider(PROVIDER_ID, {
		name: "Local Llama (auto-detected)",
		baseUrl: `${det.baseUrl}/v1`,
		api: "openai-completions",
		apiKey: "none", // llama-server ignores it, but pi wants auth presence
		models: [
			{
				id: det.modelId,
				name: det.displayName,
				reasoning: true,
				thinkingLevelMap: {
					off: "none",
					minimal: "minimal",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
					max: "max",
				},
				input: det.vision ? ["text", "image"] : ["text"],
				contextWindow: det.contextWindow,
				maxTokens: det.maxTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				compat: {
					// llama.cpp: keep system role; reasoning_effort is passed through to the template
					supportsDeveloperRole: false,
					supportsReasoningEffort: true,
				},
			},
		],
	});
}

export default async function (pi: ExtensionAPI) {
	let lastDetection: Detection | undefined;

	// Startup: async factory, so this completes before session_start and
	// before `pi --list-models` enumerates models.
	const det = await detectFirst();
	if (det) {
		lastDetection = det;
		register(pi, det);
	}

	pi.on("session_start", async (_event, ctx) => {
		if (lastDetection) register(pi, lastDetection); // re-assert after /reload
		syncWidget(ctx, lastDetection);
	});

	pi.on("model_select", (_event, ctx) => {
		syncWidget(ctx, lastDetection);
	});

	pi.registerCommand("local-model", {
		description: "Re-detect running llama-server and refresh local-model",
		handler: async (_args, ctx) => {
			const d = await detectFirst();
			if (!d) {
				ctx.ui.notify(
					`No llama-server found (tried ${describeUrls()}). Is llama-server running?`,
					"warning",
				);
				syncWidget(ctx, undefined);
				return;
			}
			lastDetection = d;
			register(pi, d); // applies immediately, no /reload needed
			syncWidget(ctx, d);
			ctx.ui.notify(
				`local-model refreshed: ${d.modelId} (ctx ${d.contextWindow.toLocaleString()}, vision ${d.vision ? "yes" : "no"})`,
				"info",
			);
		},
	});
}
