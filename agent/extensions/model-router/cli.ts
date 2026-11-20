#!/usr/bin/env node
/**
 * Validate or activate a router.md without going through the /router command.
 * Used by /build-router (the agent cannot invoke /router from bash).
 *
 *   node --experimental-strip-types ~/.pi/agent/extensions/model-router/cli.ts validate [file]
 *   node --experimental-strip-types ~/.pi/agent/extensions/model-router/cli.ts apply [file]
 *   node --experimental-strip-types ~/.pi/agent/extensions/model-router/cli.ts budget [file]
 */
import { readFileSync } from "node:fs";
import {
	activatePolicy,
	loadMechanics,
	routerMdPath,
	routerStagingPath,
} from "./load.ts";
import { mechanicsWindow, parseRouterMd } from "./parse.ts";
import { formatReport, validatePolicy } from "./validate.ts";

const argv = process.argv.slice(2);
const cmd = (argv[0] ?? "validate").toLowerCase();
const file = argv[1] ?? (cmd === "apply" ? routerStagingPath() : routerMdPath());

function fail(message: string, code = 2): never {
	console.error(message);
	process.exit(code);
}

try {
	const { mechanics, source } = loadMechanics();
	const window = mechanicsWindow(mechanics);
	if (cmd === "apply") {
		const result = activatePolicy(file, { mechanics });
		if (!result.ok) fail(result.message);
		console.log(result.message);
		console.log(`activated ${result.dest}`);
		console.log(`window: ${window.contextTokens}  (${window.source})`);
		process.exit(0);
	}
	if (cmd === "validate" || cmd === "budget") {
		const policy = parseRouterMd(readFileSync(file, "utf8"));
		const report = validatePolicy(policy, mechanics);
		console.log(formatReport(report));
		console.log(`file: ${file}`);
		console.log(`mechanics: ${source}`);
		console.log(`window: ${report.budget.contextTokens}  (${window.source})`);
		process.exit(report.ok ? 0 : 2);
	}
	fail(`usage: cli.ts <validate|apply|budget> [file]`);
} catch (err) {
	fail(err instanceof Error ? err.message : String(err), 1);
}
