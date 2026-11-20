import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readFileSync as read } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { parseContextWindow, parseRouterMd, policyBudget, DEFAULT_MECHANICS, type MechanicsConfig } from "./parse.ts";
import { validatePolicy } from "./validate.ts";
import { activatePolicy, loadPolicy } from "./load.ts";

const sample = `# Router policy

## Plans
### Go
Promo through 2026-11-22. After that prefer flash.

## Defaults
- fallback: \`opencode-go/glm-5.3-flash\`
- direct: \`command-code/recursive/flint-v1.0:free\`
- pin-free: \`command-code/recursive/flint-v1.0:free\`
- pin-hard: \`opencode-go/glm-5.3\`
- order: \`command-code/recursive/flint-v1.0:free\`, \`opencode-go/glm-5.3-flash\`, \`opencode-go/glm-5.3\`

## Models

### \`command-code/recursive/flint-v1.0:free\`
- plan: GOAT
- tier: free
- cost: \$0
- context: 200K
- images: no
- trains: no
- strengths: cheap loops
- fit: micro

### \`opencode-go/glm-5.3-flash\`
- plan: Go
- tier: cheap
- context: 1M
- images: yes
- trains: no
- strengths: workhorse, vision
- fit: routine, screenshots

### \`opencode-go/glm-5.3\`
- plan: Go
- tier: cheap
- context: 1M
- images: no
- trains: no
- fit: hard_debug during promo

### \`opencode-go/iceman-contributor-free\`
- plan: Go
- tier: never
- context: 200K
- images: no
- trains: yes
- fit: never
`;

const here = dirname(fileURLToPath(import.meta.url));
const exampleMd = join(here, "../../router_example.md");

describe("parseRouterMd", () => {
	it("parses defaults, ids, images, trains, and context windows", () => {
		const policy = parseRouterMd(sample);
		assert.equal(policy.defaults.fallback, "opencode-go/glm-5.3-flash");
		assert.equal(policy.defaults.direct, "command-code/recursive/flint-v1.0:free");
		assert.equal(policy.defaults.pinHard, "opencode-go/glm-5.3");
		assert.equal(policy.models.length, 4);
		const flash = policy.models.find((m) => m.id === "opencode-go/glm-5.3-flash");
		assert.ok(flash);
		assert.equal(flash.images, true);
		assert.equal(flash.contextWindow, 1_000_000);
		assert.equal(flash.trains, false);
		const iceman = policy.models.find((m) => m.id === "opencode-go/iceman-contributor-free");
		assert.equal(iceman?.trains, true);
		assert.equal(iceman?.allowTrains, false);
		assert.match(policy.plans, /Promo through 2026-11-22/);
	});

	it("parses trains: yes, allowed", () => {
		const policy = parseRouterMd(
			sample.replace("trains: yes\n- fit: never", "trains: yes, allowed\n- fit: rare"),
		);
		const iceman = policy.models.find((m) => m.id === "opencode-go/iceman-contributor-free");
		assert.equal(iceman?.trains, true);
		assert.equal(iceman?.allowTrains, true);
	});
});

describe("parseContextWindow", () => {
	it("understands 1M, 262K, and raw integers", () => {
		assert.equal(parseContextWindow("1M"), 1_000_000);
		assert.equal(parseContextWindow("1.0M"), 1_000_000);
		assert.equal(parseContextWindow("262K"), 262_000);
		assert.equal(parseContextWindow("200k"), 200_000);
		assert.equal(parseContextWindow("128000"), 128000);
	});
});

describe("tracked router_example.md", () => {
	it("parses, has a fallback in the model list, and fits the default Jev 32768 window", () => {
		const policy = parseRouterMd(read(exampleMd, "utf8"));
		assert.ok(policy.models.length >= 10);
		assert.ok(policy.models.some((m) => m.id === policy.defaults.fallback));
		const report = validatePolicy(policy, DEFAULT_MECHANICS);
		assert.equal(report.ok, true, report.errors.join("\n"));
		assert.equal(report.budget.contextTokens, 32_768);
		assert.ok(report.budget.remaining > 0);
		assert.match(report.budget.windowSource ?? "", /typesafe\/jev|router\.json|commandcode\.ai/);
	});
});

describe("validatePolicy", () => {
	it("rejects a missing fallback and an over-budget file", () => {
		const policy = parseRouterMd(sample.replace("fallback: `opencode-go/glm-5.3-flash`", "fallback: "));
		const report = validatePolicy(policy);
		assert.equal(report.ok, false);
		assert.ok(report.errors.some((e) => /fallback/.test(e)));
	});

	it("rejects a policy that exceeds the decider window and names how much to trim", () => {
		// Plans section already exists; append as model strengths to inflate renderForJev
		const policy = parseRouterMd(sample.replace("- fit: micro", `- fit: micro\n- strengths: ${"word ".repeat(30_000)}`));
		const tight: MechanicsConfig = { ...DEFAULT_MECHANICS, promptChars: 16_000 };
		const report = validatePolicy(policy, tight);
		assert.equal(report.ok, false, "expected over-budget failure");
		assert.match(report.errors.join("\n"), /trim about/);
		assert.match(report.errors.join("\n"), /not activated/);
		// Same text is fine on a 1M chat-model window
		const wide = validatePolicy(policy, tight, 1_000_000);
		assert.equal(wide.ok, true, wide.errors.join("\n"));
		assert.equal(wide.budget.contextTokens, 1_000_000);
	});
});

describe("activatePolicy and load fallback", () => {
	it("refuses to activate an over-budget file and leaves the previous router.md in place", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-router-"));
		process.env.PI_CODING_AGENT_DIR = dir;
		mkdirSync(join(dir), { recursive: true });
		const dest = join(dir, "router.md");
		const cache = join(dir, "router.parsed.json");
		const good = join(dir, "good.md");
		const bad = join(dir, "bad.md");
		writeFileSync(good, sample);
		const first = activatePolicy(good, { destPath: dest, cachePath: cache, mechanics: DEFAULT_MECHANICS });
		assert.equal(first.ok, true, first.message);
		const before = readFileSync(dest, "utf8");
		writeFileSync(bad, sample.replace("- fit: micro", `- fit: micro\n- strengths: ${"word ".repeat(30_000)}`));
		const second = activatePolicy(bad, { destPath: dest, cachePath: cache, mechanics: DEFAULT_MECHANICS });
		assert.equal(second.ok, false);
		assert.equal(second.wrote, false);
		assert.match(second.message, /not activated|trim about|exceeded/);
		assert.equal(readFileSync(dest, "utf8"), before);
		delete process.env.PI_CODING_AGENT_DIR;
	});

	it("on load, keeps the last valid parsed policy if router.md on disk is over budget", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-router-"));
		process.env.PI_CODING_AGENT_DIR = dir;
		const dest = join(dir, "router.md");
		const cache = join(dir, "router.parsed.json");
		const good = join(dir, "good.md");
		writeFileSync(good, sample);
		const first = activatePolicy(good, { destPath: dest, cachePath: cache, mechanics: DEFAULT_MECHANICS });
		assert.equal(first.ok, true, first.message);
		writeFileSync(dest, sample.replace("- fit: micro", `- fit: micro\n- strengths: ${"word ".repeat(30_000)}`));
		const loaded = loadPolicy();
		assert.ok(loaded.policy, loaded.warning);
		assert.equal(loaded.fallbackUsed, true);
		assert.ok(loaded.warning && /not activated|exceeded|trim about/.test(loaded.warning));
		assert.equal(loaded.policy?.defaults.fallback, "opencode-go/glm-5.3-flash");
		assert.ok(loaded.policy?.models.some((m) => m.id === "command-code/recursive/flint-v1.0:free"));
		delete process.env.PI_CODING_AGENT_DIR;
	});
});
