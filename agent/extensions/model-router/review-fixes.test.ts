/**
 * Regression tests for the PR #1 review (Kimi): cached-policy revalidation,
 * retry skip, hard-filter bypass, /build-router model switch, optional
 * request signal, and personal-file write guards.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { activatePolicy, assertPersonalPath, loadPolicy, PERSONAL_ROUTER_FILES } from "./load.ts";
import { DEFAULT_MECHANICS, parseRouterMd, type RouterPolicy } from "./parse.ts";
import { applyDecider, failOpen, NoEligibleModelError, preRoute, type RouteInput } from "./policy.ts";

const here = dirname(fileURLToPath(import.meta.url));

const sample = `# Router policy

## Plans
Go promo through 2026-11-22.

## Defaults
- fallback: \`opencode-go/glm-5.3-flash\`
- direct: \`command-code/recursive/flint-v1.0:free\`
- pin-free: \`command-code/recursive/flint-v1.0:free\`
- pin-hard: \`opencode-go/glm-5.3\`
- order: \`command-code/recursive/flint-v1.0:free\`, \`opencode-go/glm-5.3-flash\`, \`opencode-go/glm-5.3\`

## Models

### \`command-code/recursive/flint-v1.0:free\`
- context: 200K
- images: no
- trains: no
- fit: micro

### \`opencode-go/glm-5.3-flash\`
- context: 1M
- images: yes
- trains: no
- fit: routine, screenshots

### \`opencode-go/glm-5.3\`
- context: 1M
- images: no
- trains: no
- fit: hard_debug
`;

const policy: RouterPolicy = parseRouterMd(sample);
const FLINT = "command-code/recursive/flint-v1.0:free";
const FLASH = "opencode-go/glm-5.3-flash";
const GLM = "opencode-go/glm-5.3";

function input(partial: Partial<RouteInput> = {}): RouteInput {
	return {
		reason: "user",
		prompt: "fix the typo in main.ts",
		hasImages: false,
		contextChars: 100,
		now: new Date("2026-11-20T10:00:00+05:30"),
		available: new Set([FLINT, FLASH, GLM]),
		modelMeta: {
			[FLINT]: { contextWindow: 200_000, images: false },
			[FLASH]: { contextWindow: 1_000_000, images: true },
			[GLM]: { contextWindow: 1_000_000, images: false },
		},
		...partial,
	};
}

function withAgentDir<T>(fn: (dir: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "pi-router-review-"));
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		return fn(dir);
	} finally {
		if (prev == null) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
	}
}

describe("finding 2: cached policy is revalidated against the current decider window", () => {
	it("does not return a cache that fit 32768 tokens once the decider window is 1000", () => {
		withAgentDir((dir) => {
			const good = join(dir, "good.md");
			writeFileSync(good, sample);
			const first = activatePolicy(good, {
				destPath: join(dir, "router.md"),
				cachePath: join(dir, "router.parsed.json"),
				mechanics: DEFAULT_MECHANICS,
			});
			assert.equal(first.ok, true, first.message);
			// Sanity: at the original window the cached policy loads.
			assert.ok(loadPolicy().policy);
			// Kimi's repro: same router.md + cache, 1000-token decider.
			const small = loadPolicy(1000);
			assert.ok(!small.policySource.includes("(kept;"), `used stale cache: ${small.policySource}`);
			assert.ok(!small.policySource.includes("(cached)"), small.policySource);
			// The tracked example does not fit 1000 tokens either -> refuse.
			assert.equal(small.policy, undefined);
			assert.equal(small.fallbackUsed, true);
			assert.match(small.warning ?? "", /no longer fits the current decider/);
		});
	});

	it("revalidates the cache when router.md is missing (no-router.md branch)", () => {
		withAgentDir((dir) => {
			const good = join(dir, "good.md");
			writeFileSync(good, sample);
			const cachePath = join(dir, "router.parsed.json");
			assert.equal(activatePolicy(good, { destPath: join(dir, "other.md"), cachePath, mechanics: DEFAULT_MECHANICS }).ok, true);
			const ok = loadPolicy();
			assert.match(ok.policySource, /kept; no router\.md/);
			const small = loadPolicy(1000);
			assert.equal(small.policy, undefined);
			assert.match(small.warning ?? "", /no longer fits/);
		});
	});

	it("revalidates the cache when router.md is over budget, and uses it only if it still fits", () => {
		withAgentDir((dir) => {
			const good = join(dir, "good.md");
			writeFileSync(good, sample);
			const dest = join(dir, "router.md");
			const cachePath = join(dir, "router.parsed.json");
			assert.equal(activatePolicy(good, { destPath: dest, cachePath, mechanics: DEFAULT_MECHANICS }).ok, true);
			writeFileSync(dest, sample.replace("- fit: micro", `- fit: micro\n- strengths: ${"word ".repeat(30_000)}`));
			const kept = loadPolicy();
			assert.match(kept.policySource, /kept; .*failed validation/);
			assert.equal(kept.policy?.defaults.fallback, FLASH);
			const small = loadPolicy(1000);
			assert.equal(small.policy, undefined, small.policySource);
		});
	});
});

describe("finding 3: retry never re-selects the model that just failed", () => {
	it("throws a retryable NoEligibleModelError when the failed model is the only one (429)", () => {
		const run = () =>
			preRoute(
				policy,
				DEFAULT_MECHANICS,
				input({ reason: "retry", failedId: FLASH, failedError: "429 Too Many Requests", available: new Set([FLASH]) }),
			);
		assert.throws(run, (err: unknown) => {
			assert.ok(err instanceof NoEligibleModelError);
			assert.equal(err.retryable, true);
			assert.match(err.message, /other than opencode-go\/glm-5\.3-flash/);
			assert.match(err.message, /429/);
			return true;
		});
	});

	it("does not fall back to defaults.fallback when it is the failed id", () => {
		// FLASH is the fallback; FLINT lacks vision, so on an image turn only FLASH survives.
		assert.throws(
			() =>
				preRoute(
					policy,
					DEFAULT_MECHANICS,
					input({ reason: "retry", hasImages: true, failedId: FLASH, failedError: "rate limit exceeded" }),
				),
			NoEligibleModelError,
		);
	});

	it("also respects the skip on context-overflow retries", () => {
		assert.throws(
			() =>
				preRoute(
					policy,
					DEFAULT_MECHANICS,
					input({ reason: "retry", failedId: GLM, failedError: "prompt is too long", available: new Set([GLM]) }),
				),
			NoEligibleModelError,
		);
	});

	it("still advances to another eligible model when one exists", () => {
		const pre = preRoute(
			policy,
			DEFAULT_MECHANICS,
			input({ reason: "retry", failedId: FLASH, failedError: "429", available: new Set([FLASH, GLM]) }),
		);
		assert.equal(pre.final?.model, GLM);
		assert.equal(pre.final?.via, "retry");
	});
});

describe("finding 4: hard filters cannot be bypassed by fallback paths", () => {
	const visionless = { available: new Set([FLINT]), hasImages: true };

	it("a user turn with images and no vision model fails instead of picking a no-vision model", () => {
		assert.throws(() => preRoute(policy, DEFAULT_MECHANICS, input(visionless)), (err: unknown) => {
			assert.ok(err instanceof NoEligibleModelError);
			assert.match(err.message, /no vision/);
			return true;
		});
	});

	it("direct requests, manual pins, explicit names and subagent pins fail the same way", () => {
		for (const partial of [
			{ reason: "direct" as const },
			{ pin: "hard" },
			{ pin: FLASH },
			{ prompt: "use glm-5.3-flash for this" },
			{ subagentType: "scout" },
		]) {
			const mech = { ...DEFAULT_MECHANICS, subagentPins: { scout: FLASH } };
			assert.throws(() => preRoute(policy, mech, input({ ...visionless, ...partial })), NoEligibleModelError, JSON.stringify(partial));
		}
	});

	it("a model with no credentials (not in the catalog) is never chosen as the fallback", () => {
		// Only GLM has credentials; fallback FLASH is missing. A pin to FLASH must land on GLM.
		const pre = preRoute(policy, DEFAULT_MECHANICS, input({ pin: FLASH, available: new Set([GLM]) }));
		assert.equal(pre.final?.model, GLM);
		assert.throws(
			() => preRoute(policy, DEFAULT_MECHANICS, input({ pin: FLASH, available: new Set(["acme/other"]) })),
			NoEligibleModelError,
		);
	});

	it("decider fail-open paths never return a filtered model", () => {
		const empty = { candidates: [], reasons: [], skipped: [`${FLASH} (no vision)`] };
		assert.throws(() => applyDecider(policy, empty, { error: "timeout" }, 0.45), NoEligibleModelError);
		assert.throws(() => applyDecider(policy, empty, { choice: "acme/x", confidence: 1, via: "chat" }, 0.45), NoEligibleModelError);
		assert.throws(() => failOpen(policy, empty, "boom"), NoEligibleModelError);
		const one = { candidates: [GLM], reasons: [], skipped: [] };
		assert.equal(applyDecider(policy, one, { error: "timeout" }, 0.45).model, GLM);
	});
});

describe("personal router files are never written to tracked paths", () => {
	it("refuses the tracked examples and the extension source directory", () => {
		assert.throws(() => assertPersonalPath(join(tmpdir(), "router_example.md")), /tracked example/);
		assert.throws(() => assertPersonalPath(join(tmpdir(), "router_example.json")), /tracked example/);
		assert.throws(() => assertPersonalPath(join(here, "router.md")), /extension source directory/);
		assert.doesNotThrow(() => assertPersonalPath(join(tmpdir(), "router.md")));
	});

	it("activatePolicy refuses to write router.md into the extension directory", () => {
		withAgentDir((dir) => {
			const good = join(dir, "good.md");
			writeFileSync(good, sample);
			assert.throws(
				() => activatePolicy(good, { destPath: join(here, "router.md"), cachePath: join(dir, "c.json"), mechanics: DEFAULT_MECHANICS }),
				/extension source directory/,
			);
		});
	});

	it("every personal file is listed in the repo .gitignore", () => {
		const gitignore = readFileSync(join(here, "../../../.gitignore"), "utf8").split("\n").map((l) => l.trim());
		for (const name of PERSONAL_ROUTER_FILES) {
			assert.ok(gitignore.includes(name), `${name} missing from .gitignore`);
		}
	});
});

describe("finding 1 + 5: /build-router switches with pi.setModel; optional request signal", () => {
	let dir: string;
	let prevDir: string | undefined;
	let prevKeys: (string | undefined)[];
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-router-ext-"));
		prevDir = process.env.PI_CODING_AGENT_DIR;
		prevKeys = [process.env.CMD_API_KEY, process.env.COMMAND_CODE_API_KEY];
		process.env.PI_CODING_AGENT_DIR = dir;
		delete process.env.CMD_API_KEY;
		delete process.env.COMMAND_CODE_API_KEY;
		writeFileSync(join(dir, "router.json"), JSON.stringify({ buildRouterModel: GLM }));
	});
	after(() => {
		if (prevDir == null) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevDir;
		if (prevKeys[0] != null) process.env.CMD_API_KEY = prevKeys[0];
		if (prevKeys[1] != null) process.env.COMMAND_CODE_API_KEY = prevKeys[1];
	});

	it("calls pi.setModel (ctx has no setModel) and then submits the build turn", async () => {
		const mod = await import("./index.ts");
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
		const calls: string[] = [];
		const glm = { provider: "opencode-go", id: "glm-5.3", contextWindow: 1_000_000, input: ["text"] };
		const pi = {
			registerProvider() {},
			registerVirtualModel() {},
			registerCommand(name: string, opts: { handler: (args: string, ctx: unknown) => unknown }) {
				commands.set(name, opts);
			},
			async setModel(model: { provider: string; id: string }) {
				calls.push(`setModel ${model.provider}/${model.id}`);
				return true;
			},
			sendUserMessage(text: string, opts?: { deliverAs?: string }) {
				calls.push(`send${opts?.deliverAs ? `:${opts.deliverAs}` : ""} ${text.includes("## User request") ? "build" : "?"}`);
			},
		};
		const notes: string[] = [];
		const ctx = {
			cwd: dir,
			ui: { notify: (m: string, level: string) => notes.push(`${level}: ${m}`) },
			isIdle: () => true,
			modelRegistry: {
				find: (p: string, id: string) => (p === glm.provider && id === glm.id ? glm : undefined),
				getAll: () => [glm],
				getAvailable: () => [glm],
				getModelsOfType: () => [],
			},
		};
		mod.default(pi as never);
		const handler = commands.get("build-router")?.handler;
		assert.ok(handler);
		const ret = handler("route my plans", ctx);
		assert.ok(ret instanceof Promise, "handler must return a Promise<void>");
		await ret;
		for (let i = 0; i < 20 && calls.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
		assert.deepEqual(calls, ["setModel opencode-go/glm-5.3", "send build"], notes.join("\n"));
		assert.ok(!notes.some((n) => n.startsWith("error:")), notes.join("\n"));
	});

	it("withTimeout accepts an undefined request signal", async () => {
		const { withTimeout } = await import("./index.ts");
		const s = withTimeout(undefined, 50);
		assert.equal(s.aborted, false);
		const ac = new AbortController();
		const both = withTimeout(ac.signal, 10_000);
		ac.abort();
		assert.equal(both.aborted, true);
	});
});
