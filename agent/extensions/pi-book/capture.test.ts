/**
 * Capture's journal-only mode: an acknowledgement run ("go ahead") still did
 * work when it used tools, so its digest is rewritten — but never into notes.
 *
 *   node --test agent/extensions/pi-book/capture.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { DEFAULTS, Memory } from "./memory.ts";

const PROJECT = "github-com-drishal-pi-config";

/** A Memory on a scratch book with vectors off, so nothing touches the network. */
function tempMemory(t: TestContext): Memory {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-book-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const m = new Memory({ ...DEFAULTS, dir, embed: { url: "", model: "" } }, { inPi: false, agentDir: dir });
	m.book.ensure();
	return m;
}

test("capture with notes:false rewrites the digest and writes no notes", async (t) => {
	const m = tempMemory(t);
	const prompts: string[] = [];
	m.llm = async (_system, prompt) => {
		prompts.push(prompt);
		return {
			text: JSON.stringify({
				ops: [{ op: "add", scope: "user", chapter: "preferences", section: "Workflow", text: "Likes tabs", quote: "tabs over spaces" }],
				journal: ["Done: shipped the ack-run fix"],
			}),
			model: "stub",
		};
	};

	const r = await m.capture("User: go ahead\nAssistant: done", PROJECT, { session: { id: "s1", title: "go ahead" }, notes: false });

	assert.equal(r.applied.length, 0);
	assert.deepEqual(r.journal, ["Done: shipped the ack-run fix"]);
	assert.match(prompts[0], /Do not write notes/);
	assert.equal(m.book.readText("user/preferences.md"), undefined);
	const journal = m.book.journal(PROJECT);
	assert.equal(journal.length, 1);
	assert.deepEqual(
		journal[0].bullets.map((b) => b.replace(/^- \d{4}-\d{2}-\d{2} · /, "")),
		["Done: shipped the ack-run fix"],
	);

	// The same reply with notes on does add the note.
	const full = await m.capture("User: I prefer tabs over spaces in this repo.", PROJECT, { session: { id: "s2", title: "preferences" } });
	assert.equal(full.applied.filter((a) => a.ok).length, 1);
	assert.equal(m.book.bullets([PROJECT]).filter((b) => b.rel === "user/preferences.md").length, 1);
});
