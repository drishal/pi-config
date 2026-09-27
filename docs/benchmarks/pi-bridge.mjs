// pi-bridge — an OpenAI-compatible /v1/chat/completions that answers through
// pi-book's "pi" mode: every request is one minimal isolated pi session
// (microcall's design), so providers that only accept pi's own traffic —
// OpenCode Go — work without any hand-built client or header.
//
//   node pi-bridge.mjs [port]      default 8095, binds 127.0.0.1 only
//   node pi-bridge.mjs 8096 --raw http://127.0.0.1:8081/v1 qwen35
//       raw backend instead: pi-book's "raw" mode (temperature 0, thinking
//       off, max_tokens 4096) — gives mem0 exactly the settings the book's capture gets
//   model: "provider/id" passes through; anything else uses the micro chain.
//   response_format json_object / json_schema → JSON-only instruction + schema.
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

const MB = path.join(os.homedir(), ".pi/agent/extensions/pi-book");
const { makeLlm } = await import(`${MB}/llm.ts`);
const agentDir = path.join(os.homedir(), ".pi/agent");
const port = Number(process.argv[2] ?? 8095);
const rawAt = process.argv.indexOf("--raw");
const raw = rawAt > 0 ? { baseUrl: process.argv[rawAt + 1], model: process.argv[rawAt + 2] } : undefined;
const llms = new Map();
const llmFor = (model) => {
	if (raw) {
		if (!llms.has("raw"))
			llms.set("raw", makeLlm({ mode: "raw", baseUrl: raw.baseUrl, model: raw.model, timeoutMs: 300_000, extraBody: { chat_template_kwargs: { enable_thinking: false } } }, { inPi: false, agentDir }));
		return llms.get("raw");
	}
	const key = model?.includes("/") ? model : "";
	if (!llms.has(key)) llms.set(key, makeLlm({ mode: "pi", model: key || undefined, timeoutMs: 180_000 }, { inPi: false, agentDir }));
	return llms.get(key);
};

const text = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p?.type === "text").map((p) => p.text).join("\n") : "");
let served = 0;
let failed = 0;

http
	.createServer(async (req, res) => {
		const send = (code, obj) => {
			res.writeHead(code, { "content-type": "application/json" });
			res.end(JSON.stringify(obj));
		};
		if (req.method === "GET" && req.url?.startsWith("/v1/models")) return send(200, { object: "list", data: [{ id: "pi-bridge", object: "model" }] });
		if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) return send(404, { error: { message: "not found" } });
		let body = "";
		for await (const c of req) body += c;
		const t0 = Date.now();
		try {
			const r = JSON.parse(body);
			if (r.tools?.length) return send(400, { error: { message: "pi-bridge: tool calls are not supported" } });
			const msgs = r.messages ?? [];
			let system = msgs.filter((m) => m.role === "system").map((m) => text(m.content)).join("\n\n");
			const rest = msgs.filter((m) => m.role !== "system");
			const prompt = rest.length === 1 ? text(rest[0].content) : rest.map((m) => `${m.role}: ${text(m.content)}`).join("\n\n");
			const rf = r.response_format;
			if (rf?.type === "json_object" || rf?.type === "json_schema") {
				const schema = rf.json_schema?.schema ? `\nThe object must match this JSON schema:\n${JSON.stringify(rf.json_schema.schema)}` : "";
				system = `${system}\n\nRespond with a single JSON object only — no prose, no markdown fences.${schema}`.trim();
			}
			let { text: out, model } = await llmFor(r.model)(system || "You are a helpful assistant.", prompt, { label: "bridge" });
			if (rf) {
				const s = out.indexOf("{");
				const e = out.lastIndexOf("}");
				if (s >= 0 && e > s) out = out.slice(s, e + 1);
			}
			served++;
			console.log(`${new Date().toTimeString().slice(0, 8)} ok ${model} ${Date.now() - t0}ms in=${(system.length + prompt.length) | 0}c out=${out.length}c (served ${served}, failed ${failed})`);
			send(200, {
				id: `bridge-${Date.now()}`,
				object: "chat.completion",
				created: Math.floor(Date.now() / 1000),
				model,
				choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: out } }],
				usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
			});
		} catch (err) {
			failed++;
			const msg = err instanceof Error ? err.message : String(err);
			console.log(`${new Date().toTimeString().slice(0, 8)} FAIL ${Date.now() - t0}ms ${msg.slice(0, 200)}`);
			send(502, { error: { message: `pi-bridge: ${msg}` } });
		}
	})
	.listen(port, "127.0.0.1", () => console.log(`pi-bridge on http://127.0.0.1:${port}/v1 (${raw ? `raw → ${raw.model} @ ${raw.baseUrl}` : "micro chain unless a provider/id model is sent"})`));
