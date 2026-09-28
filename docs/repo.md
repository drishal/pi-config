# How this repo works

`~/.pi` **is** the repository: config is tracked in place, and everything else
pi keeps there (sessions, tokens, keys, pi-book's notes, caches) is private
state that must never be committed. Three layers keep it that way.

## 1. An allowlist `.gitignore`

Everything is ignored unless listed with a `!` line: `.gitignore`,
`.githooks/`, `README.md`, `SETUP.md`, `setup.sh`, `docs/`,
and under `agent/` only `AGENTS.md`, `settings.shared.json`, `pi.env`, `subagents.json`, `model-state_example.json`, `extensions/` and `themes/`.
Anything pi or an extension creates later stays private by default.

To track a new file, add a `!` line for it **and** add it to the pre-commit
allowlist. Never turn the file into a denylist.

## 2. A pre-commit hook (`.githooks/pre-commit`)

The second line of defence — `git add -f` bypasses ignore rules, and a new
extension can carry a pasted key. It refuses a commit when:

- a staged path is not on the allowlist, or is private state (`settings.json`,
  `auth.json`, `models.json`, `mcp.json`, `mcp-adapter.json`, `model-state.json`, `.env`, `sessions/`, `book/`,
  `memories/`, `npm/`, `stream/`, `skills/`, …)
- staged content looks like a secret (OpenAI/xAI/GitHub/AWS/Google keys,
  private keys, bearer tokens, OAuth token fields)

It also notes — without failing — packages installed with `pi install` that
`settings.shared.json` does not list yet.

Bypass only with `git commit --no-verify`, and only after reading what it
flagged.

## 3. Split settings

pi rewrites `agent/settings.json` on every toggle and model pick, so that file
is private, and the tracked `agent/settings.shared.json` holds the hand-picked
settings. `.githooks/sync-settings.mjs` merges shared into live with a 3-way
merge (details in [configuration.md](configuration.md#settings-shared-and-live)).
The `post-merge`, `post-checkout` and `post-rewrite` hooks run it, so a pull
that changes the shared settings applies them without touching your toggles.
This replaced a clean filter that stripped a fixed list of keys on staging —
toggles outside that list dirtied the repo, and a pull reset the rest.

## setup.sh

Per clone, idempotent (`--check` reports without changing anything):

1. checks `pi`, `npm`, `node`, `jq`, `git`
2. git safeguards: points `core.hooksPath` at `.githooks` and makes the hooks
   executable (git never versions its own config)
3. settings: merges `settings.shared.json` into pi's `settings.json`
4. packages: one `pi install` per missing or mismatched `packages[]` entry —
   no lockfile; pin a version in the entry when needed
5. memory: reports whether the embedding endpoint answers (pi-book needs
   no packages; without embeddings search is keyword-only)
6. prints what it cannot do: `models.json`, `auth.json`, `mcp-adapter.json`, `.env`,
   skills, `settings.json`, `model-state.json` — the per-machine and personal files

## Commits

Commits carry the owner's name only — no AI attribution trailers. Before
committing, `git status --short` should show only config you meant to change.
