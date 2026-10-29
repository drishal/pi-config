/**
 * context-dump — headless per-request payload measurement.
 *
 * Hooks pi's before_provider_request to capture exactly what the provider
 * receives: system prompt + tool declarations + message body. Writes one
 * JSON summary per request to $PI_CONTEXT_DUMP_DIR (default
 * /tmp/pi-context-snapshots/<pid>-<n>.json) plus index.jsonl lines.
 *
 * This is what pi-context-view's TUI shows, minus the TUI.
 */
import type {
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.env.PI_CONTEXT_DUMP_DIR ?? "/tmp/pi-context-snapshots";

const tokenize = (s: string) => Math.ceil(s.length / 4);

interface ToolDecl {
	name?: string;
	function?: { name?: string };
	description?: string;
	parameters?: unknown;
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_CONTEXT_DUMP !== "1" && process.env.PI_CONTEXT_DUMP !== "on") return;
	mkdirSync(OUT, { recursive: true });

	let n = 0;
	pi.on("before_provider_request", (event) => {
		n += 1;
		const payload = event.payload as Record<string, unknown>;
		const toolsRaw = (payload.tools ?? payload.functions ?? []) as ToolDecl[];
		const toolRows = toolsRaw.map((t) => {
			const name = t.function?.name ?? t.name ?? "?";
			const j = JSON.stringify(t);
			return { name, chars: j.length, approxTokens: tokenize(j) };
		});
		const toolTokens = toolRows.reduce((a, r) => a + r.approxTokens, 0);
		const sysMsgs = (payload.messages as Array<{ role?: string; content?: unknown }> | undefined) ?? [];
		const sysText = sysMsgs
			.filter((m) => m.role === "system" || m.role === "developer")
			.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
			.join("\n");
		const systemTokens = tokenize(sysText);
		const userAssistantCount = sysMsgs.filter((m) => m.role === "user" || m.role === "assistant").length;
		const sorted = [...toolRows].sort((a, b) => b.approxTokens - a.approxTokens).slice(0, 14);

		const summary = {
			n,
			provider: payload.model as string | undefined,
			toolCount: toolRows.length,
			toolTokens,
			systemTokens,
			messages: sysMsgs.length,
			conversationTurns: userAssistantCount,
			approxSystemPlusTools: systemTokens + toolTokens,
			topTools: sorted.map((t) => `${t.name}:${t.approxTokens}`).join(" "),
		};

		try {
			writeFileSync(join(OUT, `${process.pid}-${n}.json`), JSON.stringify({ summary }));
			appendFileSync(join(OUT, "index.jsonl"), JSON.stringify(summary) + "\n");
		} catch {
			// never block the request on our dump failure
		}
	});
}
