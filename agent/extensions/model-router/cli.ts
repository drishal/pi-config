#!/usr/bin/env node
/**
 * Validate or activate a router.md without going through the /router command.
 * Used by /build-router (the agent cannot invoke /router from bash).
 *
 *   node --experimental-strip-types ~/.pi/agent/extensions/model-router/cli.ts validate [file]
 *   node --experimental-strip-types ~/.pi/agent/extensions/model-router/cli.ts apply [file]
 *   node --experimental-strip-types ~/.pi/agent/extensions/model-router/cli.ts budget [file]
 *
 * Outside pi there is no model registry, so the decider window comes from
 * `routerContextWindow` in router.json (which `/router model` writes from the
 * registry) or the Jev default. Pass `--window <tokens>` to override it with
 * the registry value; inside pi, `/router validate` / `/router apply` read the
 * registry directly.
 */
import { readFileSync } from "node:fs";
import {
	activatePolicy,
	loadMechanics,
	routerMdPath,
	routerStagingPath,
} from "./load.ts";
import { mechanicsWindow, parseRouterMd } from "./parse.ts";
import { isJevModelId } from "./tokens.ts";
import { formatReport, validatePolicy } from "./validate.ts";

const rawArgv = process.argv.slice(2);
let windowOverride: number | undefined;
const argv: string[] = [];
for (let i = 0; i < rawArgv.length; i++) {
	const arg = rawArgv[i]!;
	const eq = arg.match(/^--window=(\d+)$/);
	if (eq) {
		windowOverride = Number(eq[1]);
		continue;
	}
	if (arg === "--window") {
		const next = Number(rawArgv[i + 1]);
		if (!Number.isInteger(next) || next <= 0) {
			console.error("--window needs a positive token count");
			process.exit(2);
		}
		windowOverride = next;
		i++;
		continue;
	}
	argv.push(arg);
}
const cmd = (argv[0] ?? "validate").toLowerCase();
const file = argv[1] ?? (cmd === "apply" ? routerStagingPath() : routerMdPath());

function fail(message: string, code = 2): never {
	console.error(message);
	process.exit(code);
}

try {
	const { mechanics, source } = loadMechanics();
	// windowOverride is treated like pi's registry window (highest precedence).
	const window = mechanicsWindow(mechanics, windowOverride);
	const windowSource = windowOverride != null ? "--window" : window.source;
	if (windowOverride == null && mechanics.routerContextWindow == null && !isJevModelId(mechanics.routerModel)) {
		console.error(
			`warning: routerModel ${mechanics.routerModel} has no routerContextWindow in router.json and the pi registry is not visible from this CLI; ` +
				`using ${window.contextTokens} (${window.source}). Pass --window <tokens>, run /router model ${mechanics.routerModel} once, or use /router validate inside pi.`,
		);
	}
	if (cmd === "apply") {
		const result = activatePolicy(file, { mechanics, registryWindow: windowOverride });
		if (!result.ok) fail(result.message);
		console.log(result.message);
		console.log(`activated ${result.dest}`);
		console.log(`window: ${window.contextTokens}  (${windowSource})`);
		process.exit(0);
	}
	if (cmd === "validate" || cmd === "budget") {
		const policy = parseRouterMd(readFileSync(file, "utf8"));
		const report = validatePolicy(policy, mechanics, windowOverride);
		console.log(formatReport(report));
		console.log(`file: ${file}`);
		console.log(`mechanics: ${source}`);
		console.log(`window: ${report.budget.contextTokens}  (${windowSource})`);
		process.exit(report.ok ? 0 : 2);
	}
	fail(`usage: cli.ts <validate|apply|budget> [--window <tokens>] [file]`);
} catch (err) {
	fail(err instanceof Error ? err.message : String(err), 1);
}
