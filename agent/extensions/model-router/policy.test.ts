import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	JEV_CANONICAL,
	parseDeciderText,
	parsePickerOption,
	formatPickerOption,
	pickerEntries,
	resolveDeciderKind,
	validateRouterModel,
	type CatalogEntry,
} from "./decider.ts";
import { DEFAULT_MECHANICS, parseRouterMd, type MechanicsConfig, type RouterPolicy } from "./parse.ts";
import {
	applyDecider,
	explicitModel,
	hardFilter,
	preRoute,
	walkOrder,
	type RouteInput,
} from "./policy.ts";

const sample = `# Router policy

## Plans
Go promo through 2026-11-22.

## Defaults
- fallback: \`opencode-go/glm-5.3-flash\`
- direct: \`command-code/recursive/flint-v1.0:free\`
- pin-free: \`command-code/recursive/flint-v1.0:free\`
- pin-hard: \`opencode-go/glm-5.3\`
- order: \`command-code/recursive/flint-v1.0:free\`, \`opencode-go/glm-5.3-flash\`, \`command-code/z-ai/glm-5.3-flash\`, \`opencode-go/glm-5.3\`

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
- fit: routine

### \`command-code/z-ai/glm-5.3-flash\`
- context: 1M
- images: yes
- trains: no
- fit: hard_debug after promo

### \`opencode-go/glm-5.3\`
- context: 1M
- images: no
- trains: no
- fit: hard_debug during promo

### \`opencode-go/iceman-contributor-free\`
- context: 200K
- images: no
- trains: yes
- fit: never
`;

const policy: RouterPolicy = parseRouterMd(sample);
const mechanics: MechanicsConfig = DEFAULT_MECHANICS;
const ALL = policy.models.map((m) => m.id).filter((id) => !id.includes("iceman"));

function input(partial: Partial<RouteInput> = {}): RouteInput {
	return {
		reason: "user",
		prompt: "fix the typo in main.ts",
		hasImages: false,
		contextChars: 100,
		now: new Date("2026-11-20T10:00:00+05:30"),
		available: new Set(ALL),
		modelMeta: {
			"command-code/recursive/flint-v1.0:free": { contextWindow: 200_000, images: false },
			"opencode-go/glm-5.3-flash": { contextWindow: 1_000_000, images: true },
			"command-code/z-ai/glm-5.3-flash": { contextWindow: 1_000_000, images: false },
			"opencode-go/glm-5.3": { contextWindow: 1_000_000, images: false },
		},
		...partial,
	};
}

describe("hardFilter", () => {
	it("drops training/contributor models even when they are in the catalog", () => {
		const { candidates, skipped } = hardFilter(
			policy,
			input({ available: new Set([...ALL, "opencode-go/iceman-contributor-free"]) }),
			mechanics,
		);
		assert.ok(!candidates.includes("opencode-go/iceman-contributor-free"));
		assert.ok(skipped.some((s) => /iceman.*trains/.test(s)));
	});

	it("keeps only vision-capable models on image turns (md or catalog flag)", () => {
		const { candidates, skipped } = hardFilter(policy, input({ hasImages: true }), mechanics);
		assert.deepEqual(candidates.sort(), ["command-code/z-ai/glm-5.3-flash", "opencode-go/glm-5.3-flash"].sort());
		assert.ok(skipped.some((s) => /flint.*no vision/.test(s)));
		assert.ok(skipped.some((s) => /glm-5.3 \(no vision\)/.test(s) || /opencode-go\/glm-5.3 \(no vision\)/.test(s)));
	});

	it("prefers 1M-class models when the transcript is huge, but fails open if none remain", () => {
		const { candidates } = hardFilter(policy, input({ contextChars: 250_000 }), mechanics);
		assert.ok(candidates.includes("opencode-go/glm-5.3-flash"));
		assert.ok(!candidates.includes("command-code/recursive/flint-v1.0:free"));
	});

	it("drops models that are not in the catalog", () => {
		const { candidates } = hardFilter(
			policy,
			input({ available: new Set(["opencode-go/glm-5.3-flash"]) }),
			mechanics,
		);
		assert.deepEqual(candidates, ["opencode-go/glm-5.3-flash"]);
	});
});

describe("explicitModel", () => {
	it("resolves 'use flint' and an exact provider/id", () => {
		assert.equal(explicitModel("please use flint for this", ALL), "command-code/recursive/flint-v1.0:free");
		assert.equal(
			explicitModel("use opencode-go/glm-5.3-flash here", ALL),
			"opencode-go/glm-5.3-flash",
		);
	});

	it("prefers glm-5.3 over flash when the prompt does not say flash", () => {
		assert.equal(explicitModel("switch to glm-5.3", ALL), "opencode-go/glm-5.3");
		assert.equal(explicitModel("use glm-5.3-flash", ALL), "opencode-go/glm-5.3-flash");
	});
});

describe("preRoute", () => {
	it("sticks on continuation when the previous model is still a candidate", () => {
		const pre = preRoute(
			policy,
			mechanics,
			input({ reason: "continuation", previousId: "opencode-go/glm-5.3-flash" }),
		);
		assert.equal(pre.final?.via, "sticky");
		assert.equal(pre.final?.model, "opencode-go/glm-5.3-flash");
	});

	it("routes direct requests to defaults.direct", () => {
		const pre = preRoute(policy, mechanics, input({ reason: "direct" }));
		assert.equal(pre.final?.via, "direct");
		assert.equal(pre.final?.model, "command-code/recursive/flint-v1.0:free");
	});

	it("honours pin free/hard and refuses to wait on the decider", () => {
		const free = preRoute(policy, mechanics, input({ pin: "free" }));
		assert.equal(free.final?.via, "pin");
		assert.equal(free.final?.model, "command-code/recursive/flint-v1.0:free");
		const hard = preRoute(policy, mechanics, input({ pin: "hard" }));
		assert.equal(hard.final?.model, "opencode-go/glm-5.3");
	});

	it("honours an explicit model name and refuses a training model", () => {
		const ok = preRoute(policy, mechanics, input({ prompt: "use flint and fix this" }));
		assert.equal(ok.final?.via, "explicit");
		assert.equal(ok.final?.model, "command-code/recursive/flint-v1.0:free");
		const no = preRoute(
			policy,
			mechanics,
			input({
				prompt: "use opencode-go/iceman-contributor-free",
				available: new Set([...ALL, "opencode-go/iceman-contributor-free"]),
			}),
		);
		assert.ok(!no.final || no.final.model !== "opencode-go/iceman-contributor-free");
		assert.ok((no.final?.reasons ?? no.reasons).some((r) => /refusing explicit.*iceman/.test(r)));
	});

	it("on retry, walks order and skips the failed id without needing a decider", () => {
		const pre = preRoute(
			policy,
			mechanics,
			input({
				reason: "retry",
				failedId: "command-code/recursive/flint-v1.0:free",
				failedError: "429 rate limit",
			}),
		);
		assert.equal(pre.final?.via, "retry");
		assert.equal(pre.final?.model, "opencode-go/glm-5.3-flash");
		assert.match(pre.final?.reasons.join(" ") ?? "", /no decider wait/);
	});

	it("returns candidates and no final decision when the decider should be asked", () => {
		const pre = preRoute(policy, mechanics, input({ prompt: "can you help me think through this design?" }));
		assert.equal(pre.final, undefined);
		assert.ok(pre.candidates.length >= 2);
	});
});

describe("applyDecider", () => {
	const pre = preRoute(policy, mechanics, input({ prompt: "help me design this" }));

	it("uses a Jev/classifier/chat choice that is in the candidate list", () => {
		assert.ok(pre.candidates.includes("opencode-go/glm-5.3-flash"));
		const d = applyDecider(policy, pre, { choice: "opencode-go/glm-5.3-flash", confidence: 0.9, via: "jev" }, 0.45);
		assert.equal(d.via, "jev");
		assert.equal(d.model, "opencode-go/glm-5.3-flash");
	});

	it("falls open to fallback when confidence is low, the id is unknown, or the call errors", () => {
		const low = applyDecider(policy, pre, { choice: "opencode-go/glm-5.3", confidence: 0.1, via: "jev" }, 0.45);
		assert.equal(low.via, "fallback");
		assert.equal(low.model, "opencode-go/glm-5.3-flash");
		const bad = applyDecider(policy, pre, { choice: "acme/not-a-candidate", confidence: 0.99, via: "chat" }, 0.45);
		assert.equal(bad.via, "fallback");
		const err = applyDecider(policy, pre, { error: "timeout" }, 0.45);
		assert.equal(err.via, "fallback");
		assert.match(err.reasons.join(" "), /timeout/);
	});
});

describe("walkOrder", () => {
	it("skips a failed id and continues down the configured order", () => {
		assert.equal(walkOrder(policy, ALL, "command-code/recursive/flint-v1.0:free"), "opencode-go/glm-5.3-flash");
	});
});

describe("parseDeciderText", () => {
	const cands = ["opencode-go/glm-5.3-flash", "command-code/recursive/flint-v1.0:free"];
	it("accepts strict JSON, fenced JSON, a bare id, and a unique substring", () => {
		assert.equal(parseDeciderText('{"choice":"opencode-go/glm-5.3-flash"}', cands), "opencode-go/glm-5.3-flash");
		assert.equal(parseDeciderText('```json\n{"model":"command-code/recursive/flint-v1.0:free"}\n```', cands), "command-code/recursive/flint-v1.0:free");
		assert.equal(parseDeciderText("opencode-go/glm-5.3-flash", cands), "opencode-go/glm-5.3-flash");
		assert.equal(parseDeciderText("I pick acme/unknown", cands), undefined);
	});
});

describe("routerModel catalog helpers", () => {
	const catalog: CatalogEntry[] = [
		{ spec: "command-code-jev/typesafe/jev", kind: "classifier", contextWindow: 32_768, name: "Jev (Command Code)" },
		{ spec: "opencode-go/glm-5.3-flash", kind: "chat", contextWindow: 1_000_000 },
		{ spec: "router/auto", kind: "chat", contextWindow: 1_000_000, virtual: true },
	];

	it("treats command-code/typesafe/jev as the HTTP Jev path", () => {
		assert.equal(resolveDeciderKind("command-code/typesafe/jev", catalog), "jev-http");
		assert.equal(resolveDeciderKind("command-code-jev/typesafe/jev", catalog), "jev-http");
		assert.equal(resolveDeciderKind("opencode-go/glm-5.3-flash", catalog), "chat");
		assert.equal(resolveDeciderKind("acme/missing", catalog), "missing");
	});

	it("validates picker values and lists Jev first under the canonical id", () => {
		const ok = validateRouterModel("opencode-go/glm-5.3-flash", catalog);
		assert.equal(ok.ok, true);
		if (ok.ok) {
			assert.equal(ok.spec, "opencode-go/glm-5.3-flash");
			assert.equal(ok.contextWindow, 1_000_000);
		}
		const jev = validateRouterModel("command-code/typesafe/jev", catalog);
		assert.equal(jev.ok, true);
		if (jev.ok) assert.equal(jev.spec, JEV_CANONICAL);
		const bad = validateRouterModel("nope", catalog);
		assert.equal(bad.ok, false);
		const rows = pickerEntries(catalog);
		assert.equal(rows[0]?.spec, JEV_CANONICAL);
		assert.equal(rows[0]?.contextWindow, 32_768);
		assert.ok(!rows.some((r) => r.spec === "router/auto"));
		const label = formatPickerOption(rows[0]!);
		assert.equal(parsePickerOption(label), JEV_CANONICAL);
	});
});
