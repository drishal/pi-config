/**
 * 00-env — environment files for pi, loaded before every other extension.
 *
 * pi reads no env file of its own, so switches that other extensions and
 * packages read from process.env (PI_BG_FEATURES, …) would
 * otherwise have to live in each machine's shell profile. Two files in the
 * agent dir, later winning:
 *
 *   pi.env   shared, tracked in the dotfiles repo (bootstrap links it).
 *            Non-secret switches only — it is committed.
 *   .env     this machine only: never linked, synced or committed; the place
 *            for per-machine values and secrets (like ~/.hermes/.env).
 *
 * A variable already set in the environment wins over both files, so a
 * one-off `FOO=x pi` still works — unless a parent pi put it there: exported
 * values are inherited by everything pi spawns (bash tools, a tmux server
 * started from inside pi, a nested pi), where they would shadow later edits
 * to these files. Names loaded from a file are listed in PI_ENV_FROM_FILES
 * and, when inherited, are reloaded from the files instead.
 *
 * Load order is what makes this work: pi reads each extensions directory
 * with readdirSync, which returns entries byte-sorted, and loads local
 * extensions before packages — so "00-" runs before any factory that reads
 * process.env. Keep the prefix.
 *
 * Format: KEY=value per line; `#` comments, an optional `export ` prefix,
 * and "double" (with \n \t escapes) or 'single' (literal) quotes. No ${…}
 * interpolation. Values are never logged; /env lists names and sources only.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? `${process.env.HOME}/.pi/agent`;
/** Lowest precedence first. */
const FILES = ["pi.env", ".env"];
const MARKER = "PI_ENV_FROM_FILES";

function parse(text: string): Map<string, string> {
	const vars = new Map<string, string>();
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!m) continue;
		let value = m[2];
		if (value.startsWith('"')) {
			const end = value.lastIndexOf('"');
			value = (end > 0 ? value.slice(1, end) : value.slice(1)).replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"');
		} else if (value.startsWith("'")) {
			const end = value.lastIndexOf("'");
			value = end > 0 ? value.slice(1, end) : value.slice(1);
		} else {
			value = value.replace(/\s+#.*$/, "").trim(); // trailing comment on an unquoted value
		}
		vars.set(m[1], value);
	}
	return vars;
}

/** name -> file it came from, for /env. */
const loaded = new Map<string, string>();
const problems: string[] = [];

function load(): void {
	// Values a parent pi loaded from these files are not user overrides.
	for (const name of (process.env[MARKER] ?? "").split(",")) {
		if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) delete process.env[name];
	}
	problems.length = 0;
	const merged = new Map<string, { value: string; file: string }>();
	for (const file of FILES) {
		const p = path.join(AGENT_DIR, file);
		let text: string;
		try {
			text = fs.readFileSync(p, "utf-8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`${file}: ${(err as Error).message}`);
			continue;
		}
		for (const [name, value] of parse(text)) merged.set(name, { value, file });
	}
	loaded.clear();
	for (const [name, { value, file }] of merged) {
		if (process.env[name] !== undefined) continue; // set by the user: theirs wins
		process.env[name] = value;
		loaded.set(name, file);
	}
	if (loaded.size) process.env[MARKER] = [...loaded.keys()].join(",");
	else delete process.env[MARKER];
}

export default function (pi: ExtensionAPI) {
	load();

	pi.registerCommand("env", {
		description: "Variables loaded from pi.env / .env (names and sources, never values)",
		handler: async (_args, ctx) => {
			const lines = [...loaded].map(([name, file]) => `${name}  ← ${file}`);
			const skipped = FILES.flatMap((file) => {
				try {
					const names = [...parse(fs.readFileSync(path.join(AGENT_DIR, file), "utf-8")).keys()];
					return names.filter((n) => !loaded.has(n)).map((n) => `${n}  (${file}; kept the environment's value)`);
				} catch {
					return [];
				}
			});
			ctx.ui.notify(
				[`env files in ${AGENT_DIR}: ${FILES.join(", ")}`, ...lines, ...skipped, ...problems].join("\n") ||
					"no env files",
				"info",
			);
		},
	});
}
