// node evidence.mjs <results.json>... — LLM-free retrieval score for LoCoMo runs:
// how many gold evidence turns made it into the context the answer model saw.
import * as fs from "node:fs";
import * as path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const data = JSON.parse(fs.readFileSync(path.join(here, "amb/.datasets/locomo/locomo10.json"), "utf-8"));
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

const turns = new Map(); // "conv-26:D1:3" → normalized text
const qas = new Map(); // "conv-26_q7" → qa
for (const item of data) {
	for (const [k, v] of Object.entries(item.conversation)) {
		if (!Array.isArray(v)) continue;
		for (const t of v) if (t?.dia_id) turns.set(`${item.sample_id}:${t.dia_id}`, norm(t.text ?? ""));
	}
	item.qa.forEach((qa, i) => qas.set(`${item.sample_id}_q${i}`, qa));
}

const rows = [];
for (const file of process.argv.slice(2)) {
	const run = JSON.parse(fs.readFileSync(file, "utf-8"));
	let found = 0;
	let total = 0;
	let full = 0;
	let counted = 0;
	const byCat = {};
	for (const r of run.results) {
		const qa = qas.get(r.query_id);
		const conv = r.query_id.split("_q")[0];
		const ctx = norm(r.context ?? "");
		const ev = (qa?.evidence ?? []).flatMap((e) => e.split(/[;,\s]+/)).filter((e) => /^D\d+:\d+$/.test(e));
		const texts = ev.map((e) => turns.get(`${conv}:${e}`)).filter((t) => t && t.length >= 8);
		if (!texts.length) continue;
		counted++;
		// A long turn may be split across chunks: its first 60 normalized chars are enough.
		const hit = texts.filter((t) => ctx.includes(t.slice(0, 60))).length;
		found += hit;
		total += texts.length;
		if (hit === texts.length) full++;
		const cat = r.meta?.category ?? "?";
		byCat[cat] ??= { n: 0, correct: 0 };
		byCat[cat].n++;
		if (r.correct) byCat[cat].correct++;
	}
	rows.push({
		run: run.run_name,
		queries: run.total_queries,
		accuracy: `${(run.accuracy * 100).toFixed(1)}%`,
		evidenceRecall: `${((found / total) * 100).toFixed(1)}%`,
		allEvidence: `${((full / counted) * 100).toFixed(1)}%`,
		ctxTokens: Math.round(run.avg_context_tokens),
		retrieveMs: Math.round(run.avg_retrieve_time_ms),
		ingestS: Math.round((run.ingestion_time_ms ?? 0) / 1000),
		byCategory: Object.fromEntries(Object.entries(byCat).map(([c, v]) => [c, `${v.correct}/${v.n}`])),
	});
}
console.table(rows.map(({ byCategory, ...r }) => r));
for (const r of rows) console.log(r.run.padEnd(22), JSON.stringify(r.byCategory));
