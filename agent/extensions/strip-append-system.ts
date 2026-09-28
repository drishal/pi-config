/**
 * strip-append-system — keep package-written blocks out of the system prompt.
 *
 * Some pi packages (kendex-built ones, e.g. @vanillagreen/pi-background-tasks)
 * run a postinstall script that upserts a usage guide into
 * <agent-dir>/APPEND_SYSTEM.md between marker comments:
 *
 *   <!-- kendex:append-system <package> begin --> … <!-- … end -->
 *
 * pi appends that file to every system prompt. The background-tasks guide is
 * ~860 tokens that mostly repeat its tool descriptions, and deleting it by
 * hand does not stick: every `pi update` reinstalls the package and writes it
 * back. So drop those blocks from the prompt instead, on each agent start.
 * Text of your own in APPEND_SYSTEM.md is kept, and the result is the same on
 * every turn, so the prompt cache is unaffected.
 *
 * The one line of guidance still worth having is in AGENTS.md.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BLOCK = /<!-- kendex:append-system (\S+) begin -->[\s\S]*?<!-- kendex:append-system \1 end -->\n?/g;

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const opts = event.systemPromptOptions;
		if (!opts.appendSystemPrompt?.includes("kendex:append-system")) return;
		opts.appendSystemPrompt = opts.appendSystemPrompt.replace(BLOCK, "").trim();
	});
}
