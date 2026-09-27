# How this repo works

`~/.pi` **is** the repository: config is tracked in place, and everything else
pi keeps there (sessions, tokens, keys, the memory book, caches) is private
state that must never be committed. Three layers keep it that way.

## 1. An allowlist `.gitignore`

Everything is ignored unless listed with a `!` line: `.gitignore`,
`.gitattributes`, `.githooks/`, `README.md`, `SETUP.md`, `setup.sh`, `docs/`,
and under `agent/` only `AGENTS.md`, `settings.json`, `pi.env`, `pi-fff.json`,
`subagents.json`, `model-state_example.json`, `extensions/` and `themes/`.
Anything pi or an extension creates later stays private by default.

To track a new file, add a `!` line for it **and** add it to the pre-commit
allowlist. Never turn the file into a denylist.

## 2. A pre-commit hook (`.githooks/pre-commit`)

The second line of defence — `git add -f` bypasses ignore rules, and a new
extension can carry a pasted key. It refuses a commit when:

- a staged path is not on the allowlist, or is private state (`auth.json`,
  `models.json`, `mcp.json`, `model-state.json`, `.env`, `sessions/`, `book/`,
  `memories/`, `npm/`, `stream/`, `skills/`, …)
- staged content looks like a secret (OpenAI/xAI/GitHub/AWS/Google keys,
  private keys, bearer tokens, OAuth token fields)
- `agent/settings.json` still carries pi's machine keys

Bypass only with `git commit --no-verify`, and only after reading what it
flagged.

## 3. A clean filter for settings.json

pi writes `defaultProvider`, `defaultModel`, `defaultThinkingLevel` and
`lastChangelogVersion` into `settings.json` at runtime. `.gitattributes` runs
`agent/settings.json` through the `pi-local-keys` filter, which strips them on
staging: the committed copy holds only shared settings while the live file keeps
its local keys. The filter is marked required, so a clone without it refuses to
stage `settings.json` at all.

## setup.sh

Per clone, idempotent (`--check` reports without changing anything):

1. checks `pi`, `npm`, `node`, `jq`, `git`
2. git safeguards: defines the clean filter and points `core.hooksPath` at
   `.githooks` (git never versions its own config)
3. packages: one `pi install` per missing or mismatched `settings.json`
   `packages[]` entry — no lockfile; pin a version in the entry when needed
4. memory: reports whether the embedding endpoint answers (memory-book needs
   no packages; without embeddings search is keyword-only)
5. prints what it cannot do: `models.json`, `auth.json`, `mcp.json`, `.env`,
   skills, `model-state.json` — the per-machine and personal files

## Commits

Commits carry the owner's name only — no AI attribution trailers. Before
committing, `git status --short` should show only config you meant to change.
