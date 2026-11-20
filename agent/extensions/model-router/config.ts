/**
 * Load router config: tracked example as defaults, optional machine-local overlay.
 * A missing local file is fine — the example is enough to run.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hardDebugFirst, promoActive, TASKS, type RouterConfig } from "./policy.ts";

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
}

export function exampleConfigPath(): string {
	const tracked = join(agentDir(), "model-router_example.json");
	try {
		readFileSync(tracked);
		return tracked;
	} catch {
		return join(dirname(fileURLToPath(import.meta.url)), "../../model-router_example.json");
	}
}

export function localConfigPath(): string {
	return join(agentDir(), "model-router.json");
}

export function lastDecisionPath(): string {
	return join(agentDir(), "model-router-last.json");
}

export function loadConfig(): { config: RouterConfig; source: string } {
	const examplePath = exampleConfigPath();
	const example = readJson(examplePath);
	const localPath = localConfigPath();
	let local: Record<string, unknown> | undefined;
	try {
		local = readJson(localPath);
	} catch {
		local = undefined;
	}
	const merged = validate(merge(example, local ?? {}));
	return {
		config: merged,
		source: local ? `${localPath} over ${examplePath}` : examplePath,
	};
}

export function describeHardDebug(cfg: RouterConfig, now: Date): string {
	const first = hardDebugFirst(cfg, now);
	return promoActive(cfg.hardDebug.promoUntil, now)
		? `hard_debug: ${first} (Go promo through ${cfg.hardDebug.promoUntil}, Asia/Calcutta)`
		: `hard_debug: ${first}; escalate ${cfg.hardDebug.afterPromoEscalate}`;
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function merge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(overlay)) {
		if (
			value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			base[key] &&
			typeof base[key] === "object" &&
			!Array.isArray(base[key])
		) {
			out[key] = merge(base[key] as Record<string, unknown>, value as Record<string, unknown>);
		} else {
			out[key] = value;
		}
	}
	return out;
}

function validate(raw: Record<string, unknown>): RouterConfig {
	const hardDebug = raw.hardDebug as RouterConfig["hardDebug"];
	if (!hardDebug?.promoUntil || !hardDebug.duringPromo || !hardDebug.afterPromo || !hardDebug.afterPromoEscalate) {
		throw new Error("model-router: hardDebug needs promoUntil, duringPromo, afterPromo, afterPromoEscalate");
	}
	const tasks = raw.tasks as RouterConfig["tasks"];
	for (const task of TASKS) {
		if (!tasks?.[task] || !Array.isArray(tasks[task].first) || !Array.isArray(tasks[task].fallback)) {
			throw new Error(`model-router: tasks.${task} needs first[] and fallback[]`);
		}
	}
	const jev = raw.jev as RouterConfig["jev"];
	if (!jev?.provider || !jev.id) throw new Error("model-router: jev.provider and jev.id are required");
	if (!raw.deepSeekPeak) throw new Error("model-router: deepSeekPeak is required");
	raw.never = Array.isArray(raw.never) ? raw.never : [];
	raw.lowCap = Array.isArray(raw.lowCap) ? raw.lowCap : [];
	raw.visionPreferred = Array.isArray(raw.visionPreferred) ? raw.visionPreferred : [];
	raw.longContextPreferred = Array.isArray(raw.longContextPreferred) ? raw.longContextPreferred : [];
	raw.subagentPins = raw.subagentPins && typeof raw.subagentPins === "object" ? raw.subagentPins : {};
	raw.largeContextChars = typeof raw.largeContextChars === "number" ? raw.largeContextChars : 200000;
	return raw as unknown as RouterConfig;
}
