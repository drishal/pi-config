/**
 * prompt-diet — crisper wording for package tool prompts, without editing packages.
 *
 * Packages describe their tools at length: the descriptions and parameter docs
 * of ~40 tools, plus their `<rules>` bullets, cost ~10k tokens on every request,
 * and much of it repeats itself. Editing the packages does not survive
 * `pi update`, so this swaps in shorter text at runtime instead:
 *
 *   - before_agent_start: per-tool rule bullets (`toolGuidelines`), the one-line
 *     `<tools>` snippets, and skill descriptions;
 *   - before_provider_request: tool descriptions and the `description` strings
 *     inside parameter schemas. Schema structure is never touched.
 *
 * Every rewrite in rewrites.json is pinned to a hash of the text it replaces.
 * When a package update changes that text, the original is used and a warning
 * names the tool once per session, so a stale rewrite is never served.
 *
 * PI_DIET=dump writes the current originals and their hashes to
 * <agent>/prompt-diet.dump.json (untracked) and rewrites nothing; refresh an
 * entry from there. PI_DIET=off turns the extension off.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Rewrites = {
	tools: Record<string, { hash: string; description?: string; params?: Record<string, string> }>;
	guidelines: Record<string, { hash: string; lines: string[] }>;
	snippets: Record<string, { hash: string; text: string }>;
	skills: Record<string, { hash: string; description: string }>;
};
type Obj = Record<string, unknown>;

const here = dirname(fileURLToPath(import.meta.url));
const DUMP = join(here, "..", "..", "prompt-diet.dump.json");
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);

/** Visit every string `description` in a JSON schema with its path, e.g. "properties.query". */
function eachDescription(node: unknown, visit: (path: string, holder: Obj) => void, path = ""): void {
	if (Array.isArray(node)) node.forEach((v, i) => eachDescription(v, visit, `${path}[${i}]`));
	else if (node && typeof node === "object")
		for (const [k, v] of Object.entries(node)) {
			if (k === "description" && typeof v === "string") visit(path, node as Obj);
			else eachDescription(v, visit, path ? `${path}.${k}` : k);
		}
}

/** The original text of a tool, as one hashable value. */
function toolText(def: Obj, schema: unknown) {
	const params: Record<string, string> = {};
	eachDescription(schema, (path, holder) => (params[path] = holder.description as string));
	return { description: def.description as string, params };
}

/** Tool definitions in a provider payload: OpenAI chat/responses, Anthropic, Google. */
function toolDefs(tools: unknown[]): { def: Obj; schema: unknown }[] {
	const out: { def: Obj; schema: unknown }[] = [];
	for (const t of tools as Obj[])
		for (const d of ((t?.functionDeclarations as Obj[]) ?? [(t?.function as Obj) ?? t]) as Obj[])
			if (typeof d?.name === "string" && typeof d.description === "string")
				out.push({ def: d, schema: d.parameters ?? d.input_schema ?? d.parametersJsonSchema });
	return out;
}

export default function (pi: ExtensionAPI) {
	const mode = process.env.PI_DIET?.trim().toLowerCase() ?? "";
	if (/^(off|0|false|no)$/.test(mode)) return;
	const dump = mode === "dump";
	const rw: Rewrites = JSON.parse(readFileSync(join(here, "rewrites.json"), "utf-8"));
	const dumped: Obj = {};

	const stale = new Set<string>();
	const warned = new Set<string>();
	const warn = (ctx: ExtensionContext) => {
		const fresh = [...stale].filter((n) => !warned.has(n));
		if (!fresh.length) return;
		fresh.forEach((n) => warned.add(n));
		ctx.ui.notify(
			`prompt-diet: upstream text changed for ${fresh.join(", ")}; using the originals. ` +
				"Refresh extensions/prompt-diet/rewrites.json from a PI_DIET=dump run.",
			"warning",
		);
	};
	/** The rewrite for `key` when it was written against `original`, else undefined. */
	function pick<T extends { hash: string }>(kind: string, table: Record<string, T>, key: string, original: unknown) {
		const entry = table[key];
		if (!entry) return undefined;
		if (entry.hash === hash(original)) return entry;
		stale.add(`${kind} ${key}`);
		return undefined;
	}

	pi.on("before_agent_start", async (event, ctx) => {
		const o = event.systemPromptOptions;
		if (dump) {
			const entries = <T>(rec: Record<string, T>, f: (v: T) => unknown) =>
				Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, { hash: hash(v), original: f(v) }]));
			dumped.guidelines = entries(o.toolGuidelines, (v) => v);
			dumped.snippets = entries(o.toolSnippets, (v) => v);
			dumped.skills = entries(Object.fromEntries(o.skills.map((s) => [s.name, s.description])), (v) => v);
			return;
		}
		for (const [name, lines] of Object.entries(o.toolGuidelines)) {
			const r = pick("rules", rw.guidelines, name, lines);
			if (r) o.toolGuidelines[name] = r.lines;
		}
		for (const [name, text] of Object.entries(o.toolSnippets)) {
			const r = pick("snippet", rw.snippets, name, text);
			if (r) o.toolSnippets[name] = r.text;
		}
		o.skills = o.skills.map((s) => {
			const r = pick("skill", rw.skills, s.name, s.description);
			return r ? { ...s, description: r.description } : s;
		});
		warn(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload as Obj;
		const config = payload?.config as Obj | undefined;
		if (!Array.isArray(payload?.tools) && !Array.isArray(config?.tools)) return;
		// Copy the tool lists: the originals may be reused for the next request.
		const next: Obj = { ...payload };
		if (Array.isArray(payload.tools)) next.tools = structuredClone(payload.tools);
		if (Array.isArray(config?.tools)) next.config = { ...config, tools: structuredClone(config.tools) };
		const defs = [...toolDefs((next.tools as unknown[]) ?? []), ...toolDefs(((next.config as Obj)?.tools as unknown[]) ?? [])];

		if (dump) {
			dumped.tools = Object.fromEntries(
				defs.map(({ def, schema }) => {
					const text = toolText(def, schema);
					return [def.name, { hash: hash(text), original: text }];
				}),
			);
			writeFileSync(DUMP, `${JSON.stringify(dumped, null, 1)}\n`);
			return;
		}
		for (const { def, schema } of defs) {
			const r = pick("tool", rw.tools, def.name as string, toolText(def, schema));
			if (!r) continue;
			if (r.description) def.description = r.description;
			if (r.params)
				eachDescription(schema, (path, holder) => {
					if (r.params![path] !== undefined) holder.description = r.params![path];
				});
		}
		warn(ctx);
		return next;
	});
}
