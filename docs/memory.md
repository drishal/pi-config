# Memory: the memory book

`agent/extensions/memory-book/` gives pi long-term memory as plain Markdown you
can read, grep and fix by hand. It replaced mem0 (see
[memory-benchmarks.md](memory-benchmarks.md) for why and how they compare).

## Storage

```
~/.pi/agent/book/
  INDEX.md                        generated table of contents — never edit
  user/<chapter>.md               about you: preferences, environment, workflow
  projects/<id>/<chapter>.md      one project: decisions, conventions, gotchas, commands
  projects/<id>/journal.md        medium-term digests of recent sessions (expire)
  .index/vectors.json             embedding cache — derived, safe to delete
  .history/…                      a chapter's previous text, saved before each rewrite
```

The book is **private**: not a git repo, not synced, outside this repo's
allowlist and on the pre-commit never-list. Recovery from a bad edit is
`.history/` — each chapter keeps its last 10 versions.

A chapter is frontmatter, a title, then `## Section` blocks of dated bullets:

```markdown
---
summary: How the user likes to work
---
# Preferences

## Shell
- 2026-09-27 · Wants scripts in POSIX sh or bash — never zsh-specific syntax.
```

A journal section is one session: `## 2026-09-27 · <first prompt> [s:1a2b3c4d]`
with up to 8 bullets starting `Done:`, `Tried:`, `Failed:`, `Decided:`, `Open:`
or `Next:`.

**Scope.** `user/` chapters apply everywhere. A project's id comes from its
git remote (`git@github.com:you/app.git` → `github-com-you-app`), so every
checkout of a repo shares its notes and other projects' notes never appear.
Without a remote it is the repo root's name; outside git, the directory name
plus a short hash.

## Tiers

| Tier | Holds | Lives | Reaches the model |
|---|---|---|---|
| short | the live session | the session | pi's own context |
| medium — journal | one digest per session | `journal.ttlDays` (30), then a promotion pass | last `journal.recall` (2) digests at session start |
| long — chapters | durable facts | until changed | chapter list + matching facts at session start; `memory` tool |
| archive | pi's own session files, verbatim | as long as pi keeps them | only on request: `memory` action `history` |

The capture model sorts what it reads into long (edits to chapters), medium
(this session's digest) or nothing. Size then routes in code: a "fact" longer
than 300 characters is moved into the digest; digest bullets are cut at 240;
code, logs and long explanations are never stored — they stay in the archive.

## What happens during a session

| Event | What memory-book does |
|---|---|
| session start | resolves the project id and a short session id; in the background, expires old digests (one promotion pass first) |
| first prompt | injects the recall block once (again after a compaction) |
| each agent run ends | in the background and serialised: capture — unless your messages were only acknowledgements ("ok", "go ahead", …) |
| after a capture | embeds the changed sections, so the next search does not wait |
| session end | waits up to 20 s for an in-flight capture |

**Recall block** (≈400 tokens in practice, capped at `recall.maxChars`):

1. the chapters in scope, with up to 6 section headings each
2. the last 2 sessions' digests, at most 5 lines each — `Open`/`Next`/`Decided`
   /`Failed` before `Done`
3. matching notes as single facts under their heading, until
   `recall.budgetTokens` (400) is spent; a note must reach `recall.minCos` (0.3)
   similarity to the prompt

It shows in the transcript as one line — `● Memory · 5 chapters, 1 recent
session, 3 notes recalled · ~430 tokens`; Ctrl+O expands it.

**Capture** sends one small model call with: the chapter list, up to 30
existing notes that overlap the new turns (earlier digests marked `(journal)`),
this session's digest so far, and the new turns (user and assistant text, tool
calls as names only, ≤12k characters). It returns
`{"ops": [add|update|delete…], "journal": [...] | null}`. Most runs change no
note; the digest is rewritten as a whole.

## Guards in code

The model proposes; code decides. Refused or changed regardless of the model:

- **Credentials** — anything shaped like a key, token, private key, JWT or
  `password=…` is refused (notes and digest bullets).
- **Size** — facts ≤300 characters (longer ones go to the digest), digest ≤8
  bullets of ≤240, at most 8 edits per capture.
- **Scope** — a "user" fact that says "this repo/project/codebase" is filed
  under the project.
- **Duplicates** — an exact duplicate (after normalising case, spacing, dates)
  is not added.
- **Rewording** — an update whose words are exactly the note's (after
  stemming) is refused; real changes, even one word, go through.
- **Digests** — an empty digest reply never wipes the session's digest.
- **Copied dates** — a date or bullet the model copied into a fact is stripped.
- **Only you change notes** — the prompt forbids edits based on the
  assistant's own findings; those go to the journal.
- **Backups** — one `.history/` copy per chapter per batch of edits.

## Search and reads

- **Hybrid ranking**: BM25 (stopwords dropped, light suffix stemming) and
  embedding similarity, fused with reciprocal-rank fusion (k = 60).
  EmbeddingGemma, Qwen3-Embedding and nomic get their task prefixes
  automatically.
- **Bullet-level, budgeted reads**: each fact is scored on its own and only
  matching facts are returned, under their heading, until a token budget is
  spent. On LoCoMo this delivers the same evidence as whole-section reads for
  about a third fewer tokens.
- **Degrades, never blocks**: the vector side of a search gets 3 s
  (`embed.searchBudgetMs`); a hung or missing embedding server leaves keyword
  search. Vectors are cached by content hash and model; an interrupted
  embedding pass keeps what it finished.

Measured on the reference machine: a query embeds in ~13 ms; a full search is
~20–30 ms inside pi (~90 ms from the CLI, including Node startup); new sections
embed at ~25 a second, once.

## The `memory` tool

| Action | Parameters | Does |
|---|---|---|
| `search` | `query`, `budget` (tokens, default 800) | budgeted fact search; exact keyword matches survive the similarity floor |
| `read` | `path` (`user/preferences.md`, `projects/<id>/journal.md`, or `INDEX`) | a whole chapter in scope |
| `write` | `scope` (`user`/`project`), `chapter`, `section`, `text` | add one fact (all guards apply) |
| `update` / `delete` | `old` (the note's text), `text` | change or remove a note |
| `history` | `query`, `k` (default 4) | keyword search over past pi sessions of this project, verbatim |

## Commands

| Command | Does |
|---|---|
| `/remember <fact>` | the capture model files it; if the call fails it is saved verbatim under `notes › Inbox` |
| `/memory` | book path, scope, models, recall/journal/archive state, the last captures and errors |
| `/memory search <query>` | ranked hits with their BM25 and vector ranks |
| `/memory reindex` | embed everything, drop stale vectors, rewrite `INDEX.md` |
| `/memory tidy` | per chapter, propose merges of duplicates and removal of stale notes (updates and deletes only) |

## Configuration

`~/.pi/agent/model-state.json`, section `"memory"` (per machine, never synced).
Every key is optional; these are the defaults:

```json
"memory": {
  "llm":     { "mode": "pi" },
  "embed":   { "url": "http://127.0.0.1:8090/v1", "model": "embeddinggemma" },
  "recall":  { "enabled": true, "budgetTokens": 400, "maxChars": 2800, "minCos": 0.3 },
  "capture": "auto",
  "journal": { "enabled": true, "ttlDays": 30, "recall": 2, "maxBullets": 8 }
}
```

- `llm.mode: "pi"` — a minimal isolated pi session: through `microcall.ts`
  inside pi, built from pi's SDK in the CLI. Required for providers that only
  accept a coding agent's own traffic (OpenCode Go). `"model": "provider/id"`
  pins one; without it the `"micro"` chain is used.
- `llm.mode: "raw"` — OpenAI-compatible `POST /chat/completions` for a server
  you run or a provider that allows direct API use: `baseUrl`, `model`,
  `apiKeyEnv` (or `apiKey`), `extraBody` (e.g.
  `{"chat_template_kwargs": {"enable_thinking": false}}`), `timeoutMs`. Always
  temperature 0 and `max_tokens` 4096; `<think>` blocks are stripped.
  OpenCode Go URLs are refused in this mode.
- `embed` — any OpenAI-compatible `/embeddings`: `url` (`""` = keyword-only),
  `model`, `apiKey`, `queryPrefix` / `docPrefix`, `timeoutMs`, `searchBudgetMs`.
- `capture: "manual"` — no automatic capture; only `/remember` and the tool.
- `journal.ttlDays: 0` — digests never expire.
- `dir` — move the book (default `~/.pi/agent/book`).

Environment overrides, mainly for tests: `PI_MEMORY_DIR` (the book) and
`PI_MEMORY_CONFIG` (another JSON file with a `"memory"` section).

Capture sends conversation text to the configured model. On OpenCode Go keep
personal data off "Contributor" models — their prompts train the vendor's
models.

## CLI

```
node ~/.pi/agent/extensions/memory-book/cli.ts status
node …/cli.ts search <query> [--project <id>] [--k <n>]
node …/cli.ts recall <prompt> [--project <id>] [--session <id>]
node …/cli.ts capture [--project <id>] [--session <id>] [--date YYYY-MM-DD] < transcript
node …/cli.ts history <query> [--project <id>]
node …/cli.ts serve        # JSON lines for the benchmark adapter; needs PI_MEMORY_DIR
```

## Source map

| File | Holds |
|---|---|
| `index.ts` | the pi extension: events, recall renderer, `memory` tool, commands |
| `memory.ts` | config, recall, budgeted reads, capture, promotion, guards, prompts |
| `book.ts` | Markdown storage: chapters, journal, edits, backups, `INDEX.md`, project ids |
| `search.ts` | BM25, embeddings, RRF, section chunks and bullet units, vector cache |
| `archive.ts` | keyword search over pi's session files |
| `llm.ts` | the `pi` and `raw` model modes |
| `cli.ts` | the command line and the benchmark `serve` protocol |

## Troubleshooting

- **Nothing recalled** — `/memory` shows whether the book has chapters in this
  scope and the last recall mode; `(keyword)` in the recall line means the
  embedding server did not answer.
- **Captures failing** — `/memory` lists the last errors; `/microcall test`
  checks the model chain.
- **A wrong note** — `memory` action `update`/`delete`, `/memory tidy`, or edit
  the Markdown directly; previous versions are in `.history/`.
- **Search feels stale after hand edits** — `/memory reindex`.
