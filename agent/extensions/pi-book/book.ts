/**
 * The memory book on disk: plain Markdown in one private directory. It is not a
 * git repo and never synced — ~/.pi's allowlist leaves it out — because these
 * are private memories pi builds up as projects progress.
 *
 *   <root>/INDEX.md                    generated table of contents (never hand-edited)
 *   <root>/user/<chapter>.md           about the user: preferences, environment, workflow
 *   <root>/projects/<id>/<chapter>.md  about one project: decisions, conventions, gotchas
 *   <root>/projects/<id>/journal.md    medium-term: one digest per recent session
 *                                      ("## 2026-09-27 · title [s:1a2b3c4d]"), expiring
 *   <root>/.index/                     derived search data, rebuildable, safe to delete
 *   <root>/.history/                   a chapter's previous text, saved before any
 *                                      rewrite or deletion (the last HISTORY_KEEP each)
 *
 * A chapter is frontmatter (a one-line summary), a "# Title", then "## Section"
 * blocks of dated bullets:
 *
 *   ---
 *   summary: How the user likes to work
 *   ---
 *   # Preferences
 *
 *   ## Editor
 *   - 2026-09-27 · Uses Neovim; config lives in ~/dotfiles/nvim.
 *
 * Sections are the unit of search and of recall. Everything here is plain file
 * work — no model calls — so it is shared by the extension and the CLI.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type Scope = "user" | "project";

export interface Section {
	/** "<rel>#<heading>" — stable while the heading is. */
	id: string;
	/** Path relative to the book root, e.g. "user/preferences.md". */
	rel: string;
	chapter: string;
	scope: Scope;
	project?: string;
	heading: string;
	/** The section as searched and recalled: "## heading" plus its bullets. */
	text: string;
}

export interface Chapter {
	rel: string;
	chapter: string;
	scope: Scope;
	project?: string;
	title: string;
	summary: string;
	sections: Section[];
	chars: number;
}

const BULLET_DATE = /^(- )?\d{4}-\d{2}-\d{2} · /;
const HISTORY_KEEP = 10;

export function today(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Lowercase, collapse whitespace, drop the date prefix and trailing punctuation. */
export function normalize(text: string): string {
	return text
		.replace(BULLET_DATE, "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(/[.;,!]+$/, "")
		.trim();
}

/** A fact as stored after the date: one line, without a bullet or date the model copied in. */
export function cleanFact(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[-*•]\s*/, "")
		.replace(/^(?:\d{4}-\d{2}-\d{2}\s*[·:-]\s*)+/, "")
		.trim();
}

export function kebab(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "notes"
	);
}

function git(args: string[], cwd: string, timeout = 3000): string {
	return execFileSync("git", args, { cwd, timeout, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** Temp directories (smoke tests, throwaway clones) hold nothing worth a project's memory. */
function isScratch(cwd: string): boolean {
	const dir = path.resolve(cwd);
	return ["/tmp", "/var/tmp", os.tmpdir()].some((t) => dir === t || dir.startsWith(`${t}/`));
}

/**
 * Stable project id: the git remote (the same repo matches on every machine,
 * wherever it is checked out), else the repo root's name, else the directory.
 * "" in a temp directory: no project there, only the user's chapters.
 */
export function projectId(cwd: string): string {
	if (isScratch(cwd)) return "";
	try {
		const url = git(["remote", "get-url", "origin"], cwd);
		if (url) {
			const cleaned = url
				.replace(/^[a-z+]+:\/\//, "")
				.replace(/^[^@]+@/, "")
				.replace(/\.git$/, "")
				.replace(/:/, "/");
			return kebab(cleaned.replace(/\//g, "-"));
		}
	} catch {
		// No git or no remote.
	}
	try {
		return kebab(path.basename(git(["rev-parse", "--show-toplevel"], cwd)));
	} catch {
		const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 6);
		return `${kebab(path.basename(cwd))}-${hash}`;
	}
}

export const JOURNAL = "journal";

export interface JournalEntry {
	heading: string;
	date: string;
	/** Short session id from the heading's "[s:…]" tag. */
	sid: string;
	bullets: string[];
}

const JOURNAL_HEAD = /^(\d{4}-\d{2}-\d{2}) · (.*?)\s*\[s:([\w-]+)\]$/;

export class Book {
	root: string;
	/** Chapters already backed up in the current batch (see batch()). */
	private saved: Set<string> | undefined;

	constructor(root: string) {
		this.root = root;
	}

	/** Create the layout on first use. */
	ensure(): void {
		fs.mkdirSync(path.join(this.root, "user"), { recursive: true });
		fs.mkdirSync(path.join(this.root, "projects"), { recursive: true });
	}

	rel(scope: Scope, chapter: string, project?: string): string {
		return scope === "user" ? `user/${kebab(chapter)}.md` : `projects/${project}/${kebab(chapter)}.md`;
	}

	/** Chapters in scope: all user chapters plus the given projects' (all projects when omitted). */
	chapters(projects?: string[]): Chapter[] {
		const out: Chapter[] = [];
		const read = (dir: string, scope: Scope, project?: string) => {
			let names: string[] = [];
			try {
				names = fs.readdirSync(path.join(this.root, dir)).filter((n) => n.endsWith(".md")).sort();
			} catch {
				return;
			}
			for (const name of names) {
				const rel = `${dir}/${name}`;
				const parsed = this.parse(rel, scope, project);
				if (parsed) out.push(parsed);
			}
		};
		read("user", "user");
		let ids: string[] = [];
		try {
			ids = fs.readdirSync(path.join(this.root, "projects")).sort();
		} catch {
			// No projects yet.
		}
		for (const id of ids) {
			if (projects && !projects.includes(id)) continue;
			read(`projects/${id}`, "project", id);
		}
		return out;
	}

	parse(rel: string, scope: Scope, project?: string): Chapter | undefined {
		let raw: string;
		try {
			raw = fs.readFileSync(path.join(this.root, rel), "utf-8");
		} catch {
			return undefined;
		}
		const chapter = path.basename(rel, ".md");
		let body = raw;
		let summary = "";
		const fm = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
		if (fm) {
			summary = /^summary:\s*(.*)$/m.exec(fm[1])?.[1]?.trim() ?? "";
			body = raw.slice(fm[0].length);
		}
		const title = /^# (.+)$/m.exec(body)?.[1]?.trim() ?? chapter;
		const sections: Section[] = [];
		const parts = body.split(/^(?=## )/m);
		for (const part of parts) {
			const h = /^## (.+)$/m.exec(part);
			if (!h || !part.startsWith("## ")) continue;
			const heading = h[1].trim();
			const text = part.trim();
			if (!text.includes("\n")) continue; // a heading with no bullets
			sections.push({ id: `${rel}#${heading}`, rel, chapter, scope, project, heading, text });
		}
		return { rel, chapter, scope, project, title, summary, sections, chars: raw.length };
	}

	private write(rel: string, content: string): void {
		const abs = path.join(this.root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		const tmp = `${abs}.tmp`;
		fs.writeFileSync(tmp, content.endsWith("\n") ? content : `${content}\n`);
		fs.renameSync(tmp, abs);
	}

	/**
	 * Save a chapter's current text to .history/ before it is rewritten or loses
	 * a bullet — the book has no git, so this is what makes an edit undoable.
	 */
	private backup(rel: string): void {
		if (this.saved?.has(rel)) return;
		this.saved?.add(rel);
		const current = this.read(rel);
		if (current === undefined) return;
		const dir = path.join(this.root, ".history", path.dirname(rel));
		const base = path.basename(rel, ".md");
		fs.mkdirSync(dir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		fs.writeFileSync(path.join(dir, `${base}.${stamp}.md`), current);
		const old = fs
			.readdirSync(dir)
			.filter((n) => n.startsWith(`${base}.`) && n.endsWith(".md"))
			.sort();
		for (const n of old.slice(0, Math.max(0, old.length - HISTORY_KEEP))) fs.rmSync(path.join(dir, n), { force: true });
	}

	private read(rel: string): string | undefined {
		try {
			return fs.readFileSync(path.join(this.root, rel), "utf-8");
		} catch {
			return undefined;
		}
	}

	/** Every bullet in scope, for de-duplication: normalized text → where it lives. */
	bullets(projects?: string[]): Array<{ rel: string; line: string; norm: string }> {
		const out: Array<{ rel: string; line: string; norm: string }> = [];
		for (const c of this.chapters(projects)) {
			const raw = this.read(c.rel) ?? "";
			for (const line of raw.split("\n")) {
				if (line.startsWith("- ")) out.push({ rel: c.rel, line, norm: normalize(line.slice(2)) });
			}
		}
		return out;
	}

	/**
	 * Add a dated bullet under "## section" of a chapter, creating either as
	 * needed. Returns false when the exact fact is already recorded in scope.
	 */
	add(scope: Scope, chapter: string, section: string, text: string, opts: { project?: string; summary?: string; date?: string } = {}): boolean {
		const fact = cleanFact(text);
		if (!fact) return false;
		const projects = opts.project ? [opts.project] : [];
		const norm = normalize(fact);
		if (this.bullets(projects).some((b) => b.norm === norm)) return false;

		const rel = this.rel(scope, chapter, opts.project);
		const heading = section.replace(/\s+/g, " ").trim() || "Notes";
		const bullet = `- ${opts.date ?? today()} · ${fact}`;
		let raw = this.read(rel);
		if (raw === undefined) {
			const title = chapter.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
			const summary = (opts.summary ?? title).replace(/\s+/g, " ").trim();
			raw = `---\nsummary: ${summary}\n---\n# ${title}\n`;
		}
		const lines = raw.replace(/\s+$/, "").split("\n");
		const at = lines.findIndex((l) => l.trim() === `## ${heading}`);
		if (at < 0) {
			lines.push("", `## ${heading}`, bullet);
		} else {
			let end = at + 1;
			while (end < lines.length && !lines[end].startsWith("## ")) end++;
			while (end > at + 1 && lines[end - 1].trim() === "") end--;
			lines.splice(end, 0, bullet);
		}
		this.write(rel, lines.join("\n"));
		return true;
	}

	journalRel(project: string): string {
		return `projects/${project}/${JOURNAL}.md`;
	}

	/** A project's journal, oldest first. */
	journal(project: string): JournalEntry[] {
		const c = this.parse(this.journalRel(project), "project", project);
		if (!c) return [];
		const out: JournalEntry[] = [];
		for (const s of c.sections) {
			const m = JOURNAL_HEAD.exec(s.heading);
			if (!m) continue;
			const bullets = s.text.split("\n").slice(1).filter((l) => l.startsWith("- "));
			out.push({ heading: s.heading, date: m[1], sid: m[3], bullets });
		}
		return out;
	}

	/** Replace one session's digest (or add it). Empty `bullets` removes it. */
	setJournal(project: string, sid: string, date: string, title: string, bullets: string[]): void {
		const rel = this.journalRel(project);
		const raw = this.read(rel) ?? "---\nsummary: Recent sessions — what was done, tried and left open (expires)\n---\n# Journal\n";
		const tag = `[s:${sid}]`;
		const parts = raw.replace(/\s+$/, "").split(/^(?=## )/m);
		const kept = parts.filter((p) => !(p.startsWith("## ") && p.split("\n")[0].trimEnd().endsWith(tag)));
		const old = parts.length !== kept.length;
		if (old) this.backup(rel);
		const cleanTitle = title.replace(/[#\[\]\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 70) || "session";
		// Keep the session's first date and title when rewriting its digest.
		const prev = old ? parts.find((p) => p.startsWith("## ") && p.split("\n")[0].trimEnd().endsWith(tag)) : undefined;
		const head = prev ? prev.split("\n")[0].trim() : `## ${date} · ${cleanTitle} ${tag}`;
		const entryDate = JOURNAL_HEAD.exec(head.slice(3))?.[1] ?? date;
		if (bullets.length) {
			kept.push(`${head}\n${bullets.map((b) => `- ${entryDate} · ${cleanFact(b)}`).join("\n")}\n`);
		}
		this.write(rel, kept.map((p) => p.replace(/\s+$/, "")).join("\n\n"));
	}

	/** Drop digests older than `ttlDays` (0 keeps everything). Returns what was dropped, for promotion. */
	expireJournal(project: string, ttlDays: number, now = new Date()): JournalEntry[] {
		if (!ttlDays) return [];
		const cutoff = new Date(now.getTime() - ttlDays * 86_400_000).toISOString().slice(0, 10);
		const entries = this.journal(project);
		const old = entries.filter((e) => e.date < cutoff);
		if (!old.length) return [];
		this.backup(this.journalRel(project));
		const rel = this.journalRel(project);
		const raw = this.read(rel) ?? "";
		const drop = new Set(old.map((e) => e.heading));
		const parts = raw.replace(/\s+$/, "").split(/^(?=## )/m).filter((p) => !(p.startsWith("## ") && drop.has(p.split("\n")[0].slice(3).trim())));
		this.write(rel, parts.map((p) => p.replace(/\s+$/, "")).join("\n\n"));
		return old;
	}

	/** Run several edits with one .history/ backup per chapter, so a long batch cannot rotate out the original. */
	batch<T>(fn: () => T): T {
		this.saved = new Set();
		try {
			return fn();
		} finally {
			this.saved = undefined;
		}
	}

	/**
	 * Append a whole section at once, without de-duplication — for bulk imports
	 * such as the benchmark's raw conversation sessions.
	 */
	appendSection(rel: string, heading: string, lines: string[], date: string, summary?: string): void {
		let raw = this.read(rel);
		if (raw === undefined) {
			const chapter = path.basename(rel, ".md");
			const title = chapter.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
			raw = `---\nsummary: ${summary ?? title}\n---\n# ${title}\n`;
		}
		const bullets = lines.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).map((l) => `- ${date} · ${l}`);
		this.write(rel, `${raw.replace(/\s+$/, "")}\n\n## ${heading}\n${bullets.join("\n")}`);
	}

	/**
	 * Replace (or with `text` undefined, delete) the bullet whose text contains
	 * `old`. Returns the chapter touched, or undefined when nothing matched.
	 */
	/** The bullet an edit refers to: exact text first, else the first that contains it. */
	find(old: string, projects: string[]): { rel: string; line: string; norm: string } | undefined {
		const target = normalize(cleanFact(old));
		if (!target) return undefined;
		const all = this.bullets(projects);
		return all.find((b) => b.norm === target) ?? all.find((b) => b.norm.includes(target));
	}

	change(old: string, text: string | undefined, projects: string[]): string | undefined {
		const hit = this.find(old, projects);
		if (!hit) return undefined;
		const raw = this.read(hit.rel) ?? "";
		const lines = raw.split("\n");
		const i = lines.indexOf(hit.line);
		if (i < 0) return undefined;
		this.backup(hit.rel);
		if (text === undefined) lines.splice(i, 1);
		else lines[i] = `- ${today()} · ${cleanFact(text)}`;
		this.write(hit.rel, lines.join("\n"));
		return hit.rel;
	}

	/** Replace a whole chapter (used by consolidation); the old text goes to .history/. */
	replaceChapter(rel: string, content: string): void {
		this.backup(rel);
		this.write(rel, content);
	}

	readText(rel: string): string | undefined {
		return this.read(rel);
	}

	/** Regenerate INDEX.md: every chapter's summary and section headings. */
	writeIndex(): void {
		const lines = ["# Memory index", "", "Generated — do not edit. Chapters and their sections; read one with the memory tool.", ""];
		const chapters = this.chapters();
		const group = (title: string, list: Chapter[]) => {
			if (!list.length) return;
			lines.push(`## ${title}`, "");
			for (const c of list) {
				lines.push(`- ${c.rel} — ${c.summary || c.title} (${c.sections.map((s) => s.heading).join(", ") || "empty"})`);
			}
			lines.push("");
		};
		group("You", chapters.filter((c) => c.scope === "user"));
		const ids = [...new Set(chapters.filter((c) => c.project).map((c) => c.project as string))];
		for (const id of ids) group(`Project ${id}`, chapters.filter((c) => c.project === id));
		this.write("INDEX.md", lines.join("\n"));
	}
}
