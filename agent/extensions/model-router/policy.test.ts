/**
 * Unit tests for the pure routing policy.
 *   node --experimental-strip-types --test agent/extensions/model-router/policy.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { decide, explicitModel, heuristicTask, isDeepSeekPeak, isRetryableError, promoActive, type RouterConfig } from "./policy.ts";
import { loadConfig } from "./config.ts";

const cfg: RouterConfig = loadConfig().config;

const goFlash = "opencode-go/glm-5.3-flash";
const goGlm = "opencode-go/glm-5.3";
const ccFlash = "command-code/z-ai/glm-5.3-flash";
const ccGlm = "command-code/zai-org/GLM-5.3";
const flint = "command-code/recursive/flint-v1.0:free";
const goDs = "opencode-go/deepseek-v4.1-flash";
const iceman = "opencode-go/iceman-contributor-free";
const haiku = "opencode-go/claude-haiku-5-5";

const all = [
	flint,
	"command-code/stealth/glyph-cluster:free",
	"opencode-go/beam-free",
	"opencode-go/longcat-2.5-free",
	goFlash,
	goGlm,
	ccFlash,
	ccGlm,
	goDs,
	"command-code/deepseek/deepseek-v4.1-flash",
	"command-code/inclusionai/ling-3.1-flash-1019",
	"command-code/inclusionai/ling-3.1-flash",
	iceman,
	haiku,
	"opencode-go/gpt-6-luna",
];

const meta: Record<string, { contextWindow: number; images: boolean }> = {
	[flint]: { contextWindow: 262144, images: false },
	["command-code/stealth/glyph-cluster:free"]: { contextWindow: 256000, images: false },
	["opencode-go/beam-free"]: { contextWindow: 1_000_000, images: false },
	["opencode-go/longcat-2.5-free"]: { contextWindow: 1_000_000, images: true },
	[goFlash]: { contextWindow: 1_000_000, images: true },
	[goGlm]: { contextWindow: 1_000_000, images: false },
	[ccFlash]: { contextWindow: 1_000_000, images: false },
	[ccGlm]: { contextWindow: 1_000_000, images: false },
	[goDs]: { contextWindow: 1_000_000, images: true },
	["command-code/deepseek/deepseek-v4.1-flash"]: { contextWindow: 1_000_000, images: false },
	["command-code/inclusionai/ling-3.1-flash-1019"]: { contextWindow: 1_000_000, images: false },
	["command-code/inclusionai/ling-3.1-flash"]: { contextWindow: 262144, images: false },
	[iceman]: { contextWindow: 262144, images: false },
	[haiku]: { contextWindow: 1_000_000, images: true },
	["opencode-go/gpt-6-luna"]: { contextWindow: 1_100_000, images: true },
};

const offPeak = new Date("2026-11-20T04:00:00+05:30"); // Friday 04:00 IST, off-peak
const peak = new Date("2026-11-20T07:00:00+05:30"); // Friday 07:00 IST, first peak window
const afterPromo = new Date("2026-11-23T00:00:00+05:30");

function base(over: Partial<Parameters<typeof decide>[1]> = {}) {
	return {
		reason: "user" as const,
		prompt: "Please fix the typo in the header.",
		hasImages: false,
		contextChars: 100,
		now: offPeak,
		available: new Set(all),
		modelMeta: meta,
		...over,
	};
}

describe("promo and peak helpers", () => {
	it("treats 22 Nov 2026 as still in the Go promo, 23 Nov as after", () => {
		assert.equal(promoActive("2026-11-22", new Date("2026-11-22T23:59:00+05:30")), true);
		assert.equal(promoActive("2026-11-22", afterPromo), false);
	});
	it("flags DeepSeek peak windows on weekdays in Asia/Calcutta", () => {
		assert.equal(isDeepSeekPeak(peak, cfg.deepSeekPeak.windowsIst), true);
		assert.equal(isDeepSeekPeak(offPeak, cfg.deepSeekPeak.windowsIst), false);
		assert.equal(isDeepSeekPeak(new Date("2026-11-21T07:00:00+05:30"), cfg.deepSeekPeak.windowsIst), false); // Saturday
	});
	it("recognises 429 / quota / context overflow as retryable", () => {
		assert.equal(isRetryableError("HTTP 429 rate limit exceeded"), true);
		assert.equal(isRetryableError("quota exhausted for this window"), true);
		assert.equal(isRetryableError("context overflow: prompt is too long"), true);
		assert.equal(isRetryableError("syntax error"), false);
	});
});

describe("heuristics and explicit mentions", () => {
	it("maps render/test wording to render_loop", () => {
		const h = heuristicTask("The transcript flickers during streaming. Run the tests after.", false);
		assert.equal(h?.task, "render_loop");
	});
	it("maps images to ui_review", () => {
		const h = heuristicTask("What do you think?", true);
		assert.equal(h?.task, "ui_review");
	});
	it("leaves a vague prompt unclassified so Jev can be asked", () => {
		assert.equal(heuristicTask("What do you think about the approach we discussed?", false), undefined);
	});
	it("resolves 'use flint' to the free Flint id", () => {
		assert.equal(explicitModel("please use flint for this", new Set(all)), flint);
	});
});

describe("decide()", () => {
	it("honours an explicit flint request", () => {
		const d = decide(cfg, base({ prompt: "use flint and reply ok" }));
		assert.equal(d.model, flint);
		assert.equal(d.via, "explicit");
	});

	it("routes image turns to an OpenCode Go vision flash, never full GLM-5.3", () => {
		const d = decide(cfg, base({ prompt: "What is wrong with this screen?", hasImages: true }));
		assert.equal(d.model, goFlash);
		assert.equal(d.task, "ui_review");
		assert.notEqual(d.model, goGlm);
	});

	it("never selects iceman or muse contributor models, even if named", () => {
		const d = decide(cfg, base({ prompt: "use opencode-go/iceman-contributor-free for this" }));
		assert.notEqual(d.model, iceman);
		assert.ok(d.reasons.some((r) => /refusing explicit/.test(r) || /never/.test(r) || d.skipped.some((s) => /iceman/.test(s))));
	});

	it("skips DeepSeek during the 2x peak window", () => {
		const d = decide(cfg, base({
			prompt: "Read the whole codebase and summarise the server layout.",
			now: peak,
		}));
		assert.ok(!d.model.toLowerCase().includes("deepseek"), d.model);
		assert.ok(d.skipped.some((s) => /DeepSeek peak/.test(s)), d.skipped.join("\n"));
	});

	it("avoids $15-cap models when a high-limit option exists", () => {
		const d = decide(cfg, base({ prompt: "What do you think about the approach?", jev: { task: "routine_fix", confidence: 0.8 } }));
		assert.equal(d.model, goFlash);
		assert.notEqual(d.model, haiku);
	});

	it("stays on the previous model for continuations", () => {
		const d = decide(cfg, base({ reason: "continuation", previousId: goFlash, prompt: "and also fix the typo" }));
		assert.equal(d.model, goFlash);
		assert.equal(d.via, "sticky");
	});

	it("on a 429 retry, walks the fallback chain past the failed model", () => {
		const d = decide(cfg, base({
			reason: "retry",
			failedId: flint,
			failedError: "HTTP 429 rate limit exceeded",
			prompt: "Reply with the single word ok",
		}));
		assert.notEqual(d.model, flint);
		assert.equal(d.via, "retry");
		assert.ok(
			d.model === "command-code/stealth/glyph-cluster:free" ||
				d.model === "opencode-go/beam-free" ||
				d.model.startsWith("opencode-go/") ||
				d.model.startsWith("command-code/"),
		);
	});

	it("uses Go GLM-5.3 for hard debug during the promo", () => {
		const d = decide(cfg, base({
			prompt: "Hard debug this race condition in the streaming renderer.",
			now: offPeak,
		}));
		assert.equal(d.model, goGlm);
		assert.equal(d.task, "hard_debug");
	});

	it("after the promo, defaults hard debug to Command Code GLM-5.3-Flash and escalates on retry", () => {
		const first = decide(cfg, base({
			prompt: "Hard debug this race condition in the streaming renderer.",
			now: afterPromo,
		}));
		assert.equal(first.model, ccFlash);
		const retry = decide(cfg, base({
			reason: "retry",
			failedId: ccFlash,
			failedError: "overloaded",
			prompt: "Hard debug this race condition in the streaming renderer.",
			now: afterPromo,
			previousTask: "hard_debug",
		}));
		assert.equal(retry.model, ccGlm);
		assert.equal(retry.via, "retry");
	});

	it("sends direct (compaction) requests to a cheap/free model", () => {
		const d = decide(cfg, base({ reason: "direct", prompt: "" }));
		assert.equal(d.model, flint);
		assert.equal(d.via, "direct");
	});

	it("prefers 1M-class models when the context is large", () => {
		const d = decide(cfg, base({
			prompt: "Please summarise what you have so far.",
			contextChars: 400_000,
			jev: { task: "routine_fix", confidence: 0.9 },
		}));
		assert.ok(meta[d.model].contextWindow >= 900_000, d.model);
		assert.ok(d.task === "long_context" || d.model === goDs || d.model === goFlash);
	});

	it("does not downgrade when Jev confidence is low; defaults to routine_fix", () => {
		const d = decide(cfg, base({
			prompt: "What do you think about the approach we discussed?",
			jev: { task: "hard_debug", confidence: 0.2 },
		}));
		assert.equal(d.task, "routine_fix");
		assert.equal(d.model, goFlash);
	});

	it("honours a free pin", () => {
		const d = decide(cfg, base({ pin: "free", prompt: "Hard debug this race condition." }));
		assert.equal(d.model, flint);
		assert.equal(d.via, "pin");
	});

	it("honours a subagent pin when configured", () => {
		const withPin = {
			...cfg,
			subagentPins: { Explore: flint },
		};
		const d = decide(withPin, base({ subagentType: "Explore", prompt: "Please fix the typo in the header." }));
		assert.equal(d.model, flint);
		assert.equal(d.via, "subagent-pin");
	});
});

describe("example config", () => {
	it("is valid JSON with the hardDebug one-liners", () => {
		const raw = JSON.parse(
			readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../model-router_example.json"), "utf8"),
		);
		assert.equal(raw.hardDebug.duringPromo, goGlm);
		assert.equal(raw.hardDebug.afterPromo, ccFlash);
		assert.equal(raw.hardDebug.afterPromoEscalate, ccGlm);
		assert.equal(raw.hardDebug.promoUntil, "2026-11-22");
		assert.deepEqual(raw.subagentPins, {});
	});
});
