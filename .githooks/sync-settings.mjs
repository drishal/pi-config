#!/usr/bin/env node
// sync-settings — merge the curated agent/settings.shared.json into pi's live
// agent/settings.json.
//
// settings.shared.json is tracked: hand-picked settings every machine shares
// (packages, defaultTools, theme, compaction, statusline, …). settings.json is
// private: pi rewrites it whenever you toggle something (Ctrl+T, /settings, the
// model picker), so it never belongs in git.
//
// The merge is 3-way against a snapshot of the shared file as last applied
// (agent/.settings.shared.applied.json, untracked):
//   - a shared key that did not change since the last sync is left alone, so a
//     local override of it survives (a different theme on one machine);
//   - a shared key that changed is applied — objects key by key, everything
//     else (arrays included) whole;
//   - a key removed from the shared file is removed locally only if the local
//     value is still the old shared one;
//   - keys the shared file never had (toggles, model picks, anything a future
//     pi writes) are never touched.
//
//   node .githooks/sync-settings.mjs            sync (run by setup.sh and git hooks)
//   node .githooks/sync-settings.mjs --check    report differences, change nothing
//   node .githooks/sync-settings.mjs --promote <key> [<key>…]
//                                               copy keys from settings.json into
//                                               settings.shared.json (e.g. packages
//                                               after `pi install`)
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = process.env.PI_CODING_AGENT_DIR || path.join(root, "agent");
const SHARED = path.join(root, "agent", "settings.shared.json");
const LIVE = path.join(agent, "settings.json");
const APPLIED = path.join(agent, ".settings.shared.applied.json");

const args = process.argv.slice(2);
const quiet = args.includes("--quiet");
const check = args.includes("--check");
const say = (msg) => quiet || console.log(msg);

function read(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch (err) {
		if (err.code === "ENOENT") return fallback;
		throw new Error(`${path.relative(root, file)}: ${err.message}`);
	}
}

// pi writes settings.json itself; a temp file + rename keeps a crash from
// leaving it half-written.
function write(file, value) {
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
	fs.renameSync(tmp, file);
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Apply shared-file changes (since `last`) to `live`, in place. Returns the changed paths. */
function merge(live, shared, last, prefix = "") {
	const changed = [];
	for (const key of new Set([...Object.keys(shared), ...Object.keys(last)])) {
		const s = shared[key];
		const l = last[key];
		if (same(s, l)) continue; // unchanged upstream: local value wins
		const where = prefix + key;
		if (s === undefined) {
			if (same(live[key], l)) {
				delete live[key];
				changed.push(`-${where}`);
			}
		} else if (isObject(s) && isObject(live[key])) {
			changed.push(...merge(live[key], s, isObject(l) ? l : {}, `${where}.`));
		} else if (!same(live[key], s)) {
			live[key] = structuredClone(s);
			changed.push(where);
		}
	}
	return changed;
}

const shared = read(SHARED, undefined);
if (!shared) {
	console.error(`sync-settings: ${path.relative(root, SHARED)} is missing`);
	process.exit(1);
}

const promoteAt = args.indexOf("--promote");
if (promoteAt >= 0) {
	const keys = args.slice(promoteAt + 1).filter((a) => !a.startsWith("--"));
	const live = read(LIVE, {});
	if (!keys.length) {
		console.error("usage: sync-settings.mjs --promote <key> [<key>…]");
		process.exit(1);
	}
	for (const key of keys) {
		if (live[key] === undefined) delete shared[key];
		else shared[key] = structuredClone(live[key]);
	}
	write(SHARED, shared);
	// The live file already has these values: record them as applied.
	write(APPLIED, shared);
	say(`promoted to settings.shared.json: ${keys.join(", ")}`);
	process.exit(0);
}

const live = read(LIVE, {});
const last = read(APPLIED, {});
const next = structuredClone(live);
const changed = merge(next, shared, last);

if (check) {
	say(changed.length ? `settings.json would change: ${changed.join(", ")}` : "settings.json is in sync");
	const extra = (live.packages ?? []).filter((p) => !(shared.packages ?? []).includes(p));
	if (extra.length) say(`packages only in settings.json (promote to share): ${extra.join(", ")}`);
	process.exit(0);
}

if (changed.length) {
	write(LIVE, next);
	say(`settings.json: applied ${changed.join(", ")} from settings.shared.json`);
}
write(APPLIED, shared);
