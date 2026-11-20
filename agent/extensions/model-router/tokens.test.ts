import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	budgetCheck,
	estimateTokens,
	isJevModelId,
	JEV_CONTEXT_TOKENS,
	resolveRouterContextWindow,
} from "./tokens.ts";

describe("estimateTokens", () => {
	it("rounds up at 3.25 chars/token", () => {
		assert.equal(estimateTokens(""), 0);
		assert.equal(estimateTokens("abcd"), 2); // 4/3.25 = 1.23 → 2
		assert.equal(estimateTokens("x".repeat(325)), 100);
	});
});

describe("isJevModelId", () => {
	it("matches the canonical alias and registered companion id", () => {
		assert.equal(isJevModelId("command-code/typesafe/jev"), true);
		assert.equal(isJevModelId("command-code-jev/typesafe/jev"), true);
		assert.equal(isJevModelId("typesafe/jev"), true);
		assert.equal(isJevModelId("command-code/z-ai/glm-5.3-flash"), false);
		assert.equal(isJevModelId("opencode-go/glm-5.3"), false);
	});
});

describe("resolveRouterContextWindow", () => {
	it("prefers the pi registry window when present", () => {
		const w = resolveRouterContextWindow({
			routerModel: "opencode-go/glm-5.3-flash",
			routerContextWindow: 32_768,
			registryWindow: 1_000_000,
		});
		assert.equal(w.contextTokens, 1_000_000);
		assert.match(w.source, /pi registry/);
	});

	it("uses router.json routerContextWindow when the model is unregistered", () => {
		const w = resolveRouterContextWindow({
			routerModel: "command-code/typesafe/jev",
			routerContextWindow: 40_000,
		});
		assert.equal(w.contextTokens, 40_000);
		assert.match(w.source, /configured routerContextWindow/);
	});

	it("defaults typesafe/jev to 32768 from commandcode.ai/models/jev", () => {
		const w = resolveRouterContextWindow({ routerModel: "command-code/typesafe/jev" });
		assert.equal(w.contextTokens, JEV_CONTEXT_TOKENS);
		assert.equal(w.contextTokens, 32_768);
		assert.match(w.source, /typesafe\/jev/);
		assert.match(w.source, /commandcode\.ai\/models\/jev/);
	});

	it("uses a conservative default for other unregistered deciders", () => {
		const w = resolveRouterContextWindow({ routerModel: "acme/mystery-model" });
		assert.equal(w.contextTokens, 32_768);
		assert.match(w.source, /unregistered decider/);
	});
});

describe("budgetCheck", () => {
	const base = {
		policyText: "short policy",
		promptChars: 100,
		questionText: "choose a model",
		contextTokens: 32_768,
		windowSource: "default for typesafe/jev (commandcode.ai/models/jev)",
	};

	it("accepts a small payload against the Jev window", () => {
		const r = budgetCheck(base);
		assert.equal(r.ok, true);
		assert.equal(r.contextTokens, 32_768);
		assert.match(r.message, /Router budget ok/);
		assert.match(r.message, /commandcode\.ai\/models\/jev/);
	});

	it("refuses an oversized policy and says how much to trim", () => {
		const r = budgetCheck({
			...base,
			policyText: "n".repeat(200_000),
		});
		assert.equal(r.ok, false);
		assert.ok(r.overBy > 0);
		assert.ok(r.trimChars > 0);
		assert.match(r.message, /Router context exceeded/);
		assert.match(r.message, /trim about/);
		assert.match(r.message, /not activated/);
		assert.match(r.message, /32768/);
	});

	it("passes the same oversized policy when the window is a 1M chat model", () => {
		const r = budgetCheck({
			...base,
			policyText: "n".repeat(200_000),
			contextTokens: 1_000_000,
			windowSource: "pi registry contextWindow (opencode-go/glm-5.3-flash)",
		});
		assert.equal(r.ok, true);
		assert.equal(r.contextTokens, 1_000_000);
	});
});
