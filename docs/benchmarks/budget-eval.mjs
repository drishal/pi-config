// LLM-free: how much gold evidence each read strategy delivers at a fixed token budget.
// All 10 LoCoMo conversations, raw sessions stored the way the book adapter stores them.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const MB = path.join(os.homedir(), ".pi/agent/extensions/memory-book");
const { Memory, DEFAULTS } = await import(`${MB}/memory.ts`);

const dir = path.join(here, "budget-book");
const fresh = !fs.existsSync(dir);
const m = new Memory(
	{ ...DEFAULTS, dir, embed: { ...DEFAULTS.embed, searchBudgetMs: 900_000, timeoutMs: 120_000 } },
	{ inPi: false, agentDir: "/tmp" },
);
m.book.ensure();

// Same query embedded once, reused by every strategy.
const qcache = new Map();
const embed = m.index.embedder.embed.bind(m.index.embedder);
m.index.embedder.embed = async (texts, kind, signal, onBatch) => {
	if (kind !== "query" || texts.length !== 1) return embed(texts, kind, signal, onBatch);
	if (!qcache.has(texts[0])) qcache.set(texts[0], await embed(texts, kind, signal));
	return qcache.get(texts[0]);
};

const data = JSON.parse(fs.readFileSync(path.join(here, "amb/.datasets/locomo/locomo10.json"), "utf-8"));
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const date = (s) => {
	const d = new Date(`${(s ?? "").replace(/^.*? on /, "")} UTC`);
	return Number.isNaN(d.getTime()) ? "2023-01-01" : d.toISOString().slice(0, 10);
};

if (fresh) {
	for (const item of data) {
		const conv = item.conversation;
		const keys = Object.keys(conv)
			.filter((k) => /^session_\d+$/.test(k))
			.sort((a, b) => Number(a.split("_")[1]) - Number(b.split("_")[1]));
		for (const k of keys) {
			const d = date(conv[`${k}_date_time`]);
			const lines = conv[k].map((t) => `${t.speaker}: ${t.text}${t.blip_caption ? ` [shares a photo: ${t.blip_caption}]` : ""}`);
			m.book.appendSection(m.book.rel("project", "sessions", item.sample_id), `${item.sample_id}_${k} (${d})`, lines, d);
		}
	}
	console.log("book built");
}

const configs = [];
for (const b of [500, 1000, 2000, 3000]) {
	configs.push({ name: `section@${b}`, unit: "section", budgetTokens: b });
	configs.push({ name: `bullet@${b}`, unit: "bullet", neighbors: 0, budgetTokens: b });
	configs.push({ name: `bullet±1@${b}`, unit: "bullet", neighbors: 1, budgetTokens: b });
	configs.push({ name: `bullet±2@${b}`, unit: "bullet", neighbors: 2, budgetTokens: b });
}
const stats = Object.fromEntries(configs.map((c) => [c.name, { found: 0, total: 0, full: 0, n: 0, tokens: 0 }]));
const limit = Number(process.env.LIMIT ?? 0);
let done = 0;
const t0 = Date.now();
for (const item of data) {
	const turns = new Map();
	for (const v of Object.values(item.conversation)) if (Array.isArray(v)) for (const t of v) if (t?.dia_id) turns.set(t.dia_id, norm(t.text ?? ""));
	for (const qa of item.qa) {
		if (qa.category === 5) continue;
		const ev = (qa.evidence ?? []).flatMap((e) => e.split(/[;,\s]+/)).filter((e) => /^D\d+:\d+$/.test(e));
		const texts = ev.map((e) => turns.get(e)).filter((t) => t && t.length >= 8);
		if (!texts.length) continue;
		for (const c of configs) {
			const r = await m.read(qa.question, item.sample_id, c);
			const ctx = norm(r.groups.map((g) => `${g.section.heading}\n${g.lines.join("\n")}`).join("\n"));
			const hit = texts.filter((t) => ctx.includes(t.slice(0, 60))).length;
			const s = stats[c.name];
			s.found += hit;
			s.total += texts.length;
			if (hit === texts.length) s.full++;
			s.n++;
			s.tokens += r.tokens;
		}
		done++;
		if (done % 100 === 0) console.log(`${done} questions, ${Math.round((Date.now() - t0) / 1000)}s`);
		if (limit && done >= limit) break;
	}
	if (limit && done >= limit) break;
}
console.log(`\n${done} questions, ${Math.round((Date.now() - t0) / 1000)}s`);
const rows = configs.map((c) => {
	const s = stats[c.name];
	return { read: c.name, evidenceRecall: `${((100 * s.found) / s.total).toFixed(1)}%`, allEvidence: `${((100 * s.full) / s.n).toFixed(1)}%`, avgTokens: Math.round(s.tokens / s.n) };
});
console.table(rows);
fs.writeFileSync(path.join(here, "budget-eval.json"), JSON.stringify(rows, null, 2));
process.exit(0);
