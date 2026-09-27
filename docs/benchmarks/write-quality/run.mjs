// node run.mjs <label> <llm-json> [reps] — write-quality check for pi-book capture.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SCENARIOS } from "./scenarios.mjs";

const MB = path.join(os.homedir(), ".pi/agent/extensions/pi-book");
const { Memory, DEFAULTS } = await import(`${MB}/memory.ts`);

const [label, llmJson, repsArg] = process.argv.slice(2);
const llm = JSON.parse(llmJson);
const reps = Number(repsArg ?? 2);
const out = path.join(path.dirname(new URL(import.meta.url).pathname), "runs", label);
fs.rmSync(out, { recursive: true, force: true });
const agentDir = path.join(os.homedir(), ".pi/agent");
const P = "proj";

const scopeOf = (rel) => (rel.startsWith("user/") ? "user" : "project");
const results = [];

const only = process.env.ONLY ? process.env.ONLY.split(",") : undefined;
for (const sc of SCENARIOS.filter((s) => !only || only.includes(s.id))) {
	for (let rep = 1; rep <= reps; rep++) {
		const dir = path.join(out, `${sc.id}-${rep}`);
		const mem = new Memory({ ...DEFAULTS, dir, llm }, { inPi: false, agentDir });
		mem.book.ensure();
		for (const s of sc.seed ?? []) mem.book.add(s.scope, s.chapter, s.section, s.text, { project: P, date: "2026-01-10" });
		mem.book.writeIndex();
		const before = new Set(mem.book.bullets([P]).map((b) => `${b.rel}\t${b.line}`));
		for (const [i, e] of (sc.promote ?? []).entries()) mem.book.setJournal(P, `old${i}`, e.date, e.title, e.bullets);
		const t0 = performance.now();
		let r;
		let error;
		let expired;
		try {
			if (sc.promote) {
				expired = await mem.expire(P);
				r = { applied: expired.promoted };
			} else {
				for (const t of sc.transcripts ?? [sc.transcript]) {
					r = await mem.capture(t, P, { date: "2026-09-27", session: { id: "s1", title: sc.id } });
				}
			}
		} catch (e) {
			error = e.message;
		}
		const ms = Math.round(performance.now() - t0);
		const afterList = mem.book.bullets([P]);
		const after = new Set(afterList.map((b) => `${b.rel}\t${b.line}`));
		const added = [...after].filter((x) => !before.has(x));
		const removed = [...before].filter((x) => !after.has(x));
		const notes = afterList.filter((b) => !b.rel.endsWith("/journal.md")).map((b) => ({ scope: scopeOf(b.rel), text: b.line }));
		const digest = mem.book.journal(P).find((e) => e.sid === "s1")?.bullets ?? [];
		const isJournal = (x) => x.split("\t")[0].endsWith("/journal.md");

		const fails = [];
		if (error) fails.push(`error: ${error}`);
		const addedLong = added.filter((a) => !isJournal(a));
		const removedLong = removed.filter((a) => !isJournal(a));
		if (sc.none && (addedLong.length || removedLong.length)) fails.push(`junk: +${addedLong.length} -${removedLong.length}`);
		for (const re of sc.journal ?? []) if (!digest.some((b) => re.test(b))) fails.push(`journal missed ${re}`);
		if (sc.noJournal && digest.length) fails.push(`journal not empty (${digest.length})`);
		for (const re of sc.expectLongOrJournal ?? []) if (!notes.some((n) => re.test(n.text)) && !digest.some((b) => re.test(b))) fails.push(`lost ${re}`);
		if (sc.promote) {
			const left = mem.book.journal(P).map((e) => e.date);
			if (left.includes("2026-07-01")) fails.push("old digest not expired");
			if (!left.includes("2026-09-20")) fails.push("recent digest wrongly expired");
		}
		if (digest.length > 8) fails.push(`digest too long (${digest.length})`);
		if (digest.some((b) => b.length > 260)) fails.push("digest bullet too long");
		for (const e of sc.expect ?? []) {
			const hit = notes.find((n) => e.re.test(n.text));
			if (!hit) fails.push(`missed ${e.re}`);
			else if (hit.scope !== e.scope) fails.push(`wrong scope for ${e.re}: ${hit.scope}`);
		}
		for (const f of sc.forbid ?? []) if (notes.some((n) => f.test(n.text))) fails.push(`forbidden ${f}`);
		const expected = (sc.expect ?? []).map((e) => e.re);
		const extra = addedLong.filter((a) => !expected.some((re) => re.test(a)));
		const refused = (r?.applied ?? []).filter((a) => !a.ok).map((a) => a.note);
		results.push({ id: sc.id, rep, pass: !fails.length, fails, added, removed, extra, refused, digest, ms, raw: r?.raw });
		console.log(`${fails.length ? "FAIL" : "pass"} ${sc.id}#${rep} ${ms}ms +${added.length} -${removed.length}${refused.length ? ` refused[${refused.join("; ")}]` : ""}${fails.length ? ` — ${fails.join("; ")}` : ""}`);
		for (const a of addedLong) console.log(`      + ${a.replace("\t", "  ")}`);
		for (const b of digest) console.log(`      ≈ ${b}`);
		for (const a of removedLong) console.log(`      - ${a.replace("\t", "  ")}`);
	}
}

const n = results.length;
const pass = results.filter((r) => r.pass).length;
const noneRuns = results.filter((r) => SCENARIOS.find((s) => s.id === r.id).none);
const junkRuns = noneRuns.filter((r) => r.fails.some((f) => f.startsWith("junk"))).length;
const expRuns = results.filter((r) => SCENARIOS.find((s) => s.id === r.id).expect);
const missed = expRuns.reduce((k, r) => k + r.fails.filter((f) => f.startsWith("missed")).length, 0);
const expTotal = expRuns.reduce((k, r) => k + SCENARIOS.find((s) => s.id === r.id).expect.length, 0);
const secretLeaks = results.filter((r) => r.id === "secret" && r.fails.some((f) => f.startsWith("forbidden"))).length;
const summary = {
	label,
	llm,
	runs: n,
	pass,
	junkRuns: `${junkRuns}/${noneRuns.length}`,
	factRecall: `${expTotal - missed}/${expTotal}`,
	extraNotes: results.reduce((k, r) => k + r.extra.length, 0),
	secretLeaks,
	journalFails: results.reduce((k, r) => k + r.fails.filter((f) => /journal|digest|lost|expire/.test(f)).length, 0),
	avgMs: Math.round(results.reduce((k, r) => k + r.ms, 0) / n),
};
console.log(JSON.stringify(summary));
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ summary, results }, null, 2));
process.exit(0);
