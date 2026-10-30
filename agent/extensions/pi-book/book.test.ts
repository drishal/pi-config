/**
 * pi-book's disk edits, without a pi session or a model call:
 *
 *   node --test agent/extensions/pi-book/book.test.ts
 *
 * Covers a note edit that could pick the wrong bullet: a short quote that fits
 * several notes is refused and listed, never resolved to the first match.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { Book } from "./book.ts";
import { DEFAULTS, Memory } from "./memory.ts";

const PROJECT = "github-com-drishal-pi-config";

function tempBook(t: TestContext): { dir: string; book: Book } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-book-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const book = new Book(dir);
	book.ensure();
	return { dir, book };
}

/** A Memory on a scratch book with vectors off, so nothing touches the network. */
function tempMemory(t: TestContext): Memory {
	const { dir } = tempBook(t);
	const m = new Memory({ ...DEFAULTS, dir, embed: { url: "", model: "" } }, { inPi: false, agentDir: dir });
	m.book.ensure();
	return m;
}

test("resolve prefers the exact note and lists every substring match", (t) => {
	const { book } = tempBook(t);
	book.add("user", "preferences", "Workflow", "Use bg_task for long jobs instead of sleep polling.", { date: "2026-10-30" });
	book.add("user", "preferences", "Workflow", "Never write sleep polling loops in bash.", { date: "2026-10-30" });

	const ambiguous = book.resolve("sleep polling", [PROJECT]);
	assert.equal(ambiguous.length, 2);
	assert.deepEqual(ambiguous.map((h) => h.rel), ["user/preferences.md", "user/preferences.md"]);

	const exact = book.resolve("Use bg_task for long jobs instead of sleep polling.", [PROJECT]);
	assert.equal(exact.length, 1);
	assert.match(exact[0].line, /bg_task/);
});

test("apply refuses a delete that fits several notes and names them", (t) => {
	const m = tempMemory(t);
	m.book.add("user", "preferences", "Workflow", "Use bg_task for long jobs instead of sleep polling.", { date: "2026-10-30" });
	m.book.add("user", "preferences", "Workflow", "Never write sleep polling loops in bash.", { date: "2026-10-30" });

	const [refused] = m.apply([{ op: "delete", old: "sleep polling" }], PROJECT);
	assert.equal(refused.ok, false);
	assert.match(refused.note, /^refused: 2 notes contain that/);
	assert.match(refused.note, /user\/preferences\.md › Use bg_task/);
	assert.match(refused.note, /user\/preferences\.md › Never write/);

	// Both notes survive; the whole text still deletes exactly one.
	assert.equal(m.book.bullets([PROJECT]).length, 2);
	const [done] = m.apply([{ op: "delete", old: "Never write sleep polling loops in bash." }], PROJECT);
	assert.equal(done.ok, true);
	assert.deepEqual(
		m.book.bullets([PROJECT]).map((b) => b.norm),
		["use bg_task for long jobs instead of sleep polling"],
	);
});

