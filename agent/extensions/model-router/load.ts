/**
 * Load mechanics (router.json) and the markdown policy, with a parsed cache
 * and the hard context-budget gate on activate and on load.
 */
import { copyFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_MECHANICS,
	mechanicsWindow,
	parseRouterMd,
	type MechanicsConfig,
	type RouterPolicy,
} from "./parse.ts";
import type { BudgetResult, WindowResolution } from "./tokens.ts";
import { formatReport, validatePolicy, type ValidationReport } from "./validate.ts";

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
}

export function exampleConfigPath(): string {
	const tracked = join(agentDir(), "router_example.json");
	try {
		readFileSync(tracked);
		return tracked;
	} catch {
		return join(dirname(fileURLToPath(import.meta.url)), "../../router_example.json");
	}
}

export function localConfigPath(): string {
	return join(agentDir(), "router.json");
}

/** Legacy v1 mechanics overlay; still read so existing pins/timeouts migrate. */
export function legacyConfigPath(): string {
	return join(agentDir(), "model-router.json");
}

export function examplePolicyPath(): string {
	const tracked = join(agentDir(), "router_example.md");
	try {
		readFileSync(tracked);
		return tracked;
	} catch {
		return join(dirname(fileURLToPath(import.meta.url)), "../../router_example.md");
	}
}

export function routerMdPath(): string {
	return join(agentDir(), "router.md");
}

export function routerStagingPath(): string {
	return join(agentDir(), "router.staging.md");
}

export function parsedCachePath(): string {
	return join(agentDir(), "router.parsed.json");
}

export function lastDecisionPath(): string {
	return join(agentDir(), "model-router-last.json");
}

export function buildRouterPromptPath(): string {
	const tracked = join(dirname(fileURLToPath(import.meta.url)), "build-router.prompt.md");
	try {
		readFileSync(tracked);
		return tracked;
	} catch {
		return join(agentDir(), "extensions/model-router/build-router.prompt.md");
	}
}

/**
 * Every file this extension (or /build-router) writes. All are personal to one
 * user and machine, live directly in agentDir(), and are git-ignored by name
 * in the pi-config repo (.gitignore "model-router: per-user files"). Keep this
 * list and that block in sync. model-router.json is the legacy v1 overlay: it
 * is only read, never written, but is just as personal.
 */
export const PERSONAL_ROUTER_FILES = [
	"router.md",
	"router.md.tmp",
	"router.staging.md",
	"router.json",
	"router.parsed.json",
	"model-router-last.json",
	"model-router.json",
] as const;

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Refuse to write a tracked path: the shipped examples (router_example.*) or
 * anything inside the extension's own source directory. Personal files go to
 * agentDir() only.
 */
export function assertPersonalPath(path: string): void {
	const abs = resolve(path);
	const name = basename(abs);
	if (/_example\.(md|json)$/i.test(name)) {
		throw new Error(`model-router: refusing to write tracked example file ${abs}`);
	}
	if (abs === EXTENSION_DIR || abs.startsWith(EXTENSION_DIR + sep)) {
		throw new Error(`model-router: refusing to write inside the extension source directory (${abs})`);
	}
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

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asPins(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, string> = {};
	for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
		if (typeof v === "string" && v.trim()) out[key] = v.trim();
	}
	return out;
}

/** Pull still-valid mechanics keys out of a v1 model-router.json. */
function mechanicsFromLegacy(raw: Record<string, unknown>): Record<string, unknown> {
	const jev = (raw.jev ?? {}) as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	if (asNumber(jev.timeoutMs) != null) out.timeoutMs = jev.timeoutMs;
	if (asNumber(jev.promptChars) != null) out.promptChars = jev.promptChars;
	if (asNumber(jev.confidenceFloor) != null) out.confidenceFloor = jev.confidenceFloor;
	if (asNumber(jev.contextTokens) != null) out.routerContextWindow = jev.contextTokens;
	if (asNumber(jev.headroomTokens) != null) out.headroomTokens = jev.headroomTokens;
	if (asNumber(raw.largeContextChars) != null) out.largeContextChars = raw.largeContextChars;
	if (asNumber(raw.charsPerToken) != null) out.charsPerToken = raw.charsPerToken;
	if (raw.subagentPins && typeof raw.subagentPins === "object") out.subagentPins = raw.subagentPins;
	if (asString(jev.url)) out.jev = { ...(DEFAULT_MECHANICS.jev), url: jev.url };
	if (asString(jev.id) && !asString(raw.routerModel)) {
		const provider = asString(jev.provider);
		if (provider === "command-code-jev" || provider === "command-code" || !provider) {
			out.routerModel = "command-code/typesafe/jev";
		} else {
			out.routerModel = `${provider}/${jev.id}`;
		}
	}
	return out;
}

function validateMechanics(raw: Record<string, unknown>): MechanicsConfig {
	const jevIn = (raw.jev ?? {}) as Record<string, unknown>;
	const routerModel = asString(raw.routerModel) ?? DEFAULT_MECHANICS.routerModel;
	const buildRouterModel = asString(raw.buildRouterModel);
	const cfg: MechanicsConfig = {
		routerModel,
		routerContextWindow: asNumber(raw.routerContextWindow),
		buildRouterModel: buildRouterModel,
		timeoutMs: asNumber(raw.timeoutMs) ?? DEFAULT_MECHANICS.timeoutMs,
		chatTimeoutMs: asNumber(raw.chatTimeoutMs) ?? DEFAULT_MECHANICS.chatTimeoutMs,
		promptChars: asNumber(raw.promptChars) ?? DEFAULT_MECHANICS.promptChars,
		confidenceFloor: asNumber(raw.confidenceFloor) ?? DEFAULT_MECHANICS.confidenceFloor,
		headroomTokens: asNumber(raw.headroomTokens) ?? DEFAULT_MECHANICS.headroomTokens,
		charsPerToken: asNumber(raw.charsPerToken) ?? DEFAULT_MECHANICS.charsPerToken,
		largeContextChars: asNumber(raw.largeContextChars) ?? DEFAULT_MECHANICS.largeContextChars,
		subagentPins: Object.keys(asPins(raw.subagentPins)).length ? asPins(raw.subagentPins) : { ...DEFAULT_MECHANICS.subagentPins },
		jev: {
			url: asString(jevIn.url) ?? DEFAULT_MECHANICS.jev.url,
			id: asString(jevIn.id) ?? DEFAULT_MECHANICS.jev.id,
		},
	};
	if (cfg.timeoutMs <= 0) cfg.timeoutMs = DEFAULT_MECHANICS.timeoutMs;
	if (cfg.chatTimeoutMs <= 0) cfg.chatTimeoutMs = DEFAULT_MECHANICS.chatTimeoutMs;
	if (cfg.promptChars <= 0) cfg.promptChars = DEFAULT_MECHANICS.promptChars;
	if (cfg.charsPerToken <= 0) cfg.charsPerToken = DEFAULT_MECHANICS.charsPerToken;
	return cfg;
}

export function loadMechanics(): { mechanics: MechanicsConfig; source: string } {
	const examplePath = exampleConfigPath();
	let base: Record<string, unknown> = { ...DEFAULT_MECHANICS, jev: { ...DEFAULT_MECHANICS.jev } };
	try {
		base = merge(base, readJson(examplePath));
	} catch {
		// defaults are enough
	}
	const sources = [examplePath];
	const legacyPath = legacyConfigPath();
	try {
		const legacy = mechanicsFromLegacy(readJson(legacyPath));
		if (Object.keys(legacy).length) {
			base = merge(base, legacy);
			sources.push(`${legacyPath} (migrated mechanics)`);
		}
	} catch {
		// no legacy file
	}
	const localPath = localConfigPath();
	try {
		base = merge(base, readJson(localPath));
		sources.push(localPath);
	} catch {
		// machine overlay is optional
	}
	return { mechanics: validateMechanics(base), source: sources.join(" over ") };
}

export function writeMechanics(partial: Record<string, unknown>): MechanicsConfig {
	const current = (() => {
		try {
			return readJson(localConfigPath());
		} catch {
			return {};
		}
	})();
	const merged = merge(current, partial);
	const dest = localConfigPath();
	assertPersonalPath(dest);
	mkdirSync(dirname(dest), { recursive: true });
	writeFileSync(dest, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
	return loadMechanics().mechanics;
}

export interface CachedPolicy {
	version: 1;
	mtimeMs: number;
	size: number;
	policy: RouterPolicy;
	budget: BudgetResult;
	window: WindowResolution;
}

export interface LoadedPolicy {
	policy: RouterPolicy | undefined;
	mechanics: MechanicsConfig;
	mechanicsSource: string;
	policySource: string;
	budget?: BudgetResult;
	window: WindowResolution;
	warning?: string;
	fallbackUsed: boolean;
}

function readCache(path: string): CachedPolicy | undefined {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as CachedPolicy;
		if (raw?.version !== 1 || !raw.policy?.defaults?.fallback || !Array.isArray(raw.policy.models)) return undefined;
		return raw;
	} catch {
		return undefined;
	}
}

function writeCache(path: string, cache: CachedPolicy): void {
	try {
		assertPersonalPath(path);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(cache) + "\n", { mode: 0o600 });
	} catch {
		// cache is best-effort
	}
}

function statOf(path: string): { mtimeMs: number; size: number } | undefined {
	try {
		const s = statSync(path);
		return { mtimeMs: s.mtimeMs, size: s.size };
	} catch {
		return undefined;
	}
}

function tryFile(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/**
 * Load the active policy. If router.md is missing, over budget, or invalid,
 * fall back to the last valid parsed cache (or the tracked example) and do
 * not overwrite a good cache with a bad parse.
 */
export function loadPolicy(registryWindow?: number): LoadedPolicy {
	const { mechanics, source: mechanicsSource } = loadMechanics();
	const window = mechanicsWindow(mechanics, registryWindow);
	const mdPath = routerMdPath();
	const cachePath = parsedCachePath();
	const cache = readCache(cachePath);
	const md = tryFile(mdPath);
	const mdStat = statOf(mdPath);

	const accept = (policy: RouterPolicy, src: string, st?: { mtimeMs: number; size: number }, write = false): LoadedPolicy | undefined => {
		const report = validatePolicy(policy, mechanics, registryWindow);
		if (!report.ok) return undefined;
		if (write && st) {
			writeCache(cachePath, {
				version: 1,
				mtimeMs: st.mtimeMs,
				size: st.size,
				policy,
				budget: report.budget,
				window,
			});
		}
		return {
			policy,
			mechanics,
			mechanicsSource,
			policySource: src,
			budget: report.budget,
			window,
			fallbackUsed: false,
		};
	};

	/**
	 * Fall back to the last parsed cache only after re-validating it against
	 * the *current* mechanics and decider window. A cache that was within
	 * budget for an older, larger decider must not be routed through a
	 * smaller one (e.g. after `/router model` switches to Jev's 32K).
	 */
	let cacheReport: ValidationReport | undefined;
	const keepCache = (why: string): LoadedPolicy | undefined => {
		if (!cache?.policy) return undefined;
		cacheReport ??= validatePolicy(cache.policy, mechanics, registryWindow);
		if (!cacheReport.ok) return undefined;
		return {
			policy: cache.policy,
			mechanics,
			mechanicsSource,
			policySource: `${cachePath} (kept; ${why})`,
			budget: cacheReport.budget,
			window,
			fallbackUsed: true,
		};
	};
	const cacheRejected = (): string | undefined =>
		cacheReport && !cacheReport.ok
			? `last parsed policy (${cachePath}) no longer fits the current decider and was not used:\n${formatReport(cacheReport)}`
			: undefined;

	if (md && mdStat) {
		const cacheFresh =
			cache && cache.mtimeMs === mdStat.mtimeMs && cache.size === mdStat.size && cache.budget?.ok;
		if (cacheFresh) {
			// Re-check budget if the decider window changed since the cache was written.
			const report = validatePolicy(cache.policy, mechanics, registryWindow);
			if (report.ok) {
				return {
					policy: cache.policy,
					mechanics,
					mechanicsSource,
					policySource: `${mdPath} (cached)`,
					budget: report.budget,
					window,
					fallbackUsed: false,
				};
			}
		}
		try {
			const parsed = parseRouterMd(md);
			const loaded = accept(parsed, mdPath, mdStat, true);
			if (loaded) return loaded;
			const report = validatePolicy(parsed, mechanics, registryWindow);
			const kept = keepCache(`${mdPath} failed validation`);
			if (kept) {
				kept.warning = `router.md was not activated:\n${formatReport(report)}${kept.warning ? `\n${kept.warning}` : ""}`;
				return kept;
			}
			const example = loadExample(mechanics, mechanicsSource, registryWindow, window);
			example.warning = joinWarnings(`router.md was not activated:\n${formatReport(report)}`, cacheRejected(), example.warning);
			return example;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const kept = keepCache(`${mdPath} failed to parse`);
			if (kept) {
				kept.warning = `router.md failed to parse (${message}); using last valid policy`;
				return kept;
			}
			const example = loadExample(mechanics, mechanicsSource, registryWindow, window);
			example.warning = joinWarnings(`router.md failed to parse (${message})`, cacheRejected(), example.warning);
			return example;
		}
	}

	const kept = keepCache("no router.md");
	if (kept) return kept;

	const example = loadExample(mechanics, mechanicsSource, registryWindow, window);
	example.warning = joinWarnings(cacheRejected(), example.warning);
	return example;
}

function joinWarnings(...parts: (string | undefined)[]): string | undefined {
	const out = parts.filter((p): p is string => !!p);
	return out.length ? out.join("\n") : undefined;
}

function loadExample(
	mechanics: MechanicsConfig,
	mechanicsSource: string,
	registryWindow: number | undefined,
	window: WindowResolution,
): LoadedPolicy {
	const path = examplePolicyPath();
	const text = tryFile(path);
	if (!text) {
		return {
			policy: undefined,
			mechanics,
			mechanicsSource,
			policySource: "(none)",
			window,
			warning: "no router.md, no valid cache, and router_example.md is missing",
			fallbackUsed: true,
		};
	}
	try {
		const policy = parseRouterMd(text);
		const report = validatePolicy(policy, mechanics, registryWindow);
		if (!report.ok) {
			return {
				policy: undefined,
				mechanics,
				mechanicsSource,
				policySource: path,
				budget: report.budget,
				window,
				warning: `tracked router_example.md failed validation:\n${formatReport(report)}`,
				fallbackUsed: true,
			};
		}
		return {
			policy,
			mechanics,
			mechanicsSource,
			policySource: path,
			budget: report.budget,
			window,
			fallbackUsed: false,
		};
	} catch (err) {
		return {
			policy: undefined,
			mechanics,
			mechanicsSource,
			policySource: path,
			window,
			warning: `router_example.md failed to parse (${err instanceof Error ? err.message : String(err)})`,
			fallbackUsed: true,
		};
	}
}

export interface ActivateResult {
	ok: boolean;
	report: ValidationReport;
	wrote: boolean;
	dest: string;
	message: string;
}

/**
 * Activate a staging markdown file as router.md. Refuses to write (and leaves
 * the previous router.md + cache untouched) if validation or the context
 * budget fails.
 */
export function activatePolicy(
	sourcePath: string,
	opts?: { destPath?: string; cachePath?: string; mechanics?: MechanicsConfig; registryWindow?: number },
): ActivateResult {
	const dest = opts?.destPath ?? routerMdPath();
	const cachePath = opts?.cachePath ?? parsedCachePath();
	const mechanics = opts?.mechanics ?? loadMechanics().mechanics;
	assertPersonalPath(dest);
	assertPersonalPath(cachePath);
	const text = readFileSync(sourcePath, "utf8");
	const policy = parseRouterMd(text);
	const report = validatePolicy(policy, mechanics, opts?.registryWindow);
	const message = formatReport(report);
	if (!report.ok) {
		return { ok: false, report, wrote: false, dest, message };
	}
	mkdirSync(dirname(dest), { recursive: true });
	const tmp = dest + ".tmp";
	writeFileSync(tmp, text.endsWith("\n") ? text : text + "\n", { mode: 0o600 });
	try {
		renameSync(tmp, dest);
	} catch {
		copyFileSync(tmp, dest);
	}
	const st = statOf(dest);
	if (st) {
		writeCache(cachePath, {
			version: 1,
			mtimeMs: st.mtimeMs,
			size: st.size,
			policy,
			budget: report.budget,
			window: mechanicsWindow(mechanics, opts?.registryWindow),
		});
	}
	return { ok: true, report, wrote: true, dest, message };
}
