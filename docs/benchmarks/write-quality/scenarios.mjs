// Write-quality scenarios for pi-book capture (coding domain).
// seed: notes present before the capture (dated 2026-01-10)
// transcript: what capture sees
// expect: each regex must match some note afterwards, in the given scope ("user" | "project")
// forbid: no note may match (junk, stale facts, secrets, relative dates)
// none: no long-term note may be added or changed (the journal may be)
// journal: regexes that must each match a bullet of this session's digest
// noJournal: the digest must stay empty
// transcripts: several captures in one session, in order
// promote: seed old journal entries and run expiry instead of capture
// A fake GitHub token for the "secret" scenario, assembled here so secret
// scanners (this repo's pre-commit hook, GitHub push protection) do not flag it.
const FAKE_TOKEN = ["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("_");

export const SCENARIOS = [
	{
		id: "chatter",
		none: true,
		journal: [/parse_header|trailing newline/i],
		transcript: `User: the parser test is failing again
Assistant: The failure is in parse_header: it assumed a trailing newline. I added a check and the test passes now.
[used tools: read, edit, bash]
User: nice, commit it
Assistant: Committed as "parser: handle missing trailing newline".`,
	},
	{
		id: "long-explanation",
		none: true,
		transcript: `User: go ahead
Assistant: I refactored the config loader into three functions: readFile, merge and validate. merge now deep-merges nested objects and validate reports every missing key instead of the first one. I also updated the 12 call sites and ran the suite: 184 tests pass.
[used tools: read, edit, bash]`,
	},
	{
		id: "user-pref",
		expect: [{ re: /pnpm/i, scope: "user" }],
		transcript: `User: why did you use npm install? I always use pnpm for JS projects, please don't use npm.
Assistant: Sorry — switching to pnpm. I'll use pnpm from now on.`,
	},
	{
		id: "project-convention",
		expect: [{ re: /just test/i, scope: "project" }],
		transcript: `User: don't run cargo test directly in this repo, always use \`just test\` — it sets up the fixtures DB first.
Assistant: Got it, I'll run \`just test\`.
[used tools: bash]`,
	},
	{
		id: "contradiction",
		seed: [{ scope: "user", chapter: "preferences", section: "Editor", text: "Uses Neovim as the main editor." }],
		expect: [{ re: /helix|\bhx\b/i, scope: "user" }],
		forbid: [/neovim as the main editor/i, /last week/i],
		transcript: `User: I moved from Neovim to Helix last week, so when you give editor instructions use hx keybindings.
Assistant: Noted — Helix (hx) instructions from now on.`,
	},
	{
		id: "duplicate",
		seed: [{ scope: "user", chapter: "preferences", section: "Formatting", text: "Prefers two-space indentation in Nix files." }],
		none: true,
		transcript: `User: remember, nix files get 2-space indents
Assistant: Yes — two spaces for Nix, as before.`,
	},
	{
		id: "secret",
		forbid: [/ghp_/i, /A1b2C3d4E5f6/],
		transcript: `User: here's my token ${FAKE_TOKEN}, put it in .env as GITHUB_TOKEN
Assistant: Added GITHUB_TOKEN to .env (which is gitignored).
[used tools: edit]`,
	},
	{
		id: "unconfirmed-suggestion",
		none: true,
		transcript: `User: the sqlite file is getting big
Assistant: We could migrate to Postgres, or add a VACUUM on startup. Postgres would also give us concurrent writers.
User: hmm let me think about it`,
	},
	{
		id: "decision",
		expect: [{ re: /sqlite/i, scope: "project" }],
		transcript: `User: ok decided: we keep SQLite — it's a single-user app, Postgres is overkill. Don't propose Postgres again. Add VACUUM on startup instead.
Assistant: Understood. Keeping SQLite and adding VACUUM on startup.
[used tools: edit]`,
	},
	{
		id: "environment",
		expect: [{ re: /6800|16 ?GB/i, scope: "user" }],
		transcript: `User: my GPU is an RX 6800 with 16GB and I run a 35B model on it, so keep embedding models on the CPU.
Assistant: Makes sense — I'll keep embeddings CPU-only.`,
	},
	{
		id: "mixed-gotcha",
		journal: [/mock/i],
		expect: [{ re: /network|offline/i, scope: "project" }],
		forbid: [/timeout to 30/i],
		transcript: `User: CI failed again
Assistant: The integration test timed out; I raised its timeout to 30s.
[used tools: edit, bash]
User: no, the real reason: the CI runner has no network access at all, so tests must never fetch anything. Mock it.
Assistant: Right — I'll mock the HTTP client in the integration tests.`,
	},
	{
		id: "stale-delete",
		seed: [{ scope: "project", chapter: "deployment", section: "Hosting", text: "Deploys go through Fly.io with flyctl deploy." }],
		expect: [{ re: /colmena/i, scope: "project" }],
		forbid: [/fly\.io with flyctl/i],
		transcript: `User: we moved off Fly entirely — deploys now go to our NixOS box with colmena apply. The fly.toml is deleted.
Assistant: Got it; deployment is colmena apply to the NixOS host.`,
	},
	{
		id: "code-dump",
		none: true,
		noJournal: true,
		transcript: `User: what does utils.ts export?
Assistant: It exports slugify(text), debounce(fn, ms), clamp(n, lo, hi) and a Result<T,E> type with ok()/err() helpers. slugify lowercases and replaces non-alphanumerics with dashes.
[used tools: read]`,
	},
	{
		id: "scope-split",
		expect: [
			{ re: /tab/i, scope: "project" },
			{ re: /conventional commit/i, scope: "user" },
		],
		transcript: `User: two things: this repo uses tabs for indentation (the .editorconfig is wrong, ignore it). And in general, for all my projects, I want Conventional Commits style messages.
Assistant: Tabs here, and Conventional Commits everywhere.`,
	},
	// ── harder ──
	{
		id: "temporary-state",
		none: true,
		transcript: `User: I'm on my laptop today so builds are slow — just run the unit tests, skip the integration suite this time.
Assistant: Running only the unit tests: 212 passed.
[used tools: bash]`,
	},
	{
		id: "paraphrase-dup",
		seed: [{ scope: "user", chapter: "preferences", section: "Tooling", text: "Uses pnpm for all JavaScript projects; never npm." }],
		none: true,
		transcript: `User: use pnpm here, not npm, like always
Assistant: Using pnpm.
[used tools: bash]`,
	},
	{
		id: "buried",
		expect: [{ re: /weekend/i, scope: "project" }],
		transcript: `User: continue the import cleanup
Assistant: Step 1: reading src/module1.rs and updating the imports.
[used tools: read, edit]
Assistant: Step 2: reading src/module2.rs and updating the imports.
[used tools: read, edit]
Assistant: Step 3: reading src/module3.rs and updating the imports.
[used tools: read, edit]
Assistant: Step 4: reading src/module4.rs and updating the imports.
[used tools: read, edit]
Assistant: Step 5: reading src/module5.rs and updating the imports.
[used tools: read, edit]
Assistant: Step 6: reading src/module6.rs and updating the imports.
[used tools: read, edit]
Assistant: Step 7: reading src/module7.rs and updating the imports.
[used tools: read, edit]
User: by the way, the staging DB is read-only on weekends, so never run migrations against it then.
Assistant: Noted. Continuing: all modules updated, cargo check passes.
[used tools: bash]`,
	},
	{
		id: "assistant-claim",
		none: true,
		noJournal: true,
		transcript: `User: which rust version does this need?
Assistant: Cargo.toml sets rust-version = "1.80" and the toolchain file pins 1.80.1, so 1.80 or newer.
[used tools: read]`,
	},
	{
		id: "targeted-update",
		seed: [
			{ scope: "project", chapter: "workflow", section: "Git", text: "The main branch is called master." },
			{ scope: "project", chapter: "workflow", section: "CI", text: "CI runs on GitHub Actions." },
		],
		expect: [{ re: /\bmain\b/i, scope: "project" }, { re: /github actions/i, scope: "project" }],
		forbid: [/called master/i],
		transcript: `User: heads up, we renamed master to main. CI is unchanged.
Assistant: Got it — main is the default branch now.`,
	},
	// ── tiers ──
	{
		id: "multi-capture",
		none: true,
		journal: [/rate limit|429/i, /retry|backoff/i],
		transcripts: [
			`User: the sync job keeps failing with 429s from the GitHub API
Assistant: It hits the secondary rate limit: 80 parallel requests. I capped concurrency at 8.
[used tools: read, edit, bash]`,
			`User: still failing sometimes
Assistant: Added exponential backoff that honours Retry-After on 429. Ran the job twice: both runs clean.
[used tools: edit, bash]`,
		],
	},
	{
		id: "overflow",
		expectLongOrJournal: [/flaky|migration tests/i, /reset-db/i],
		transcript: `User: remember this for this project: the e2e suite is flaky only when run after the migration tests, because those leave a stale lock row in the jobs table that the e2e fixtures never clean up, so if you see random e2e timeouts, first check whether the migration tests ran earlier in the same CI job, and if so run \`just reset-db\` before the e2e suite rather than retrying the whole pipeline, which wastes about twenty minutes each time.
Assistant: Understood.`,
	},
	{
		id: "promote-on-expire",
		promote: [
			{ date: "2026-07-01", title: "db work", bullets: ["Decided: keep SQLite for this single-user app; Postgres ruled out by the user", "Done: fixed a typo in README"] },
			{ date: "2026-09-20", title: "recent", bullets: ["Done: added VACUUM on startup"] },
		],
		expect: [{ re: /sqlite/i, scope: "project" }],
		forbid: [/typo/i],
	},
	{
		id: "observation-conflict",
		seed: [{ scope: "project", chapter: "conventions", section: "Hooks", text: "Run .githooks/pre-commit before reporting any change as ready." }],
		none: true,
		transcript: `User: add a CHANGELOG entry for the parser fix
Assistant: Added the entry under Unreleased. I looked for .githooks/pre-commit to run it before reporting, but this checkout has no such hook, so I skipped it.
[used tools: read, edit, bash]`,
	},
];
