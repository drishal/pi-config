# pi agent setup

Runbook for recreating the pi coding-agent configuration on a machine.
Follow it top to bottom. What each feature does and how it works is documented
in [docs/](docs/README.md).

> **Fast path.** `~/.pi` **is** this repo: the config is tracked in place,
> so editing a file under `~/.pi/agent/` edits the repo, and `git status` in
> `~/.pi` shows exactly what changed.
>
> ```bash
> git clone <this repo> ~/.pi     # a fresh machine (before first running pi)
> ~/.pi/setup.sh --check          # report what is missing, change nothing
> ~/.pi/setup.sh                  # git safeguards, packages, memory check
> ```
>
> That covers steps 4, 5, 6 and 7. You still need steps 1–2
> (install pi, set up models) and the machine-specific items in step 9.
>
> **What keeps private state out.** The same directory is pi's live state —
> sessions, memories, `auth.json`, `models.json`, `mcp-adapter.json`, caches, npm.
> Three layers keep it out of git: `.gitignore` is an **allowlist** (everything
> is ignored unless listed, so new files pi creates stay private by default);
> settings are **split** — the tracked `agent/settings.shared.json` holds the
> hand-picked settings, while pi's own `settings.json` stays private (pi rewrites
> it on every toggle and model pick) and gets the shared settings merged in by
> `setup.sh` and the git hooks after pull/checkout/rebase; and
> `.githooks/pre-commit` refuses private paths and token-shaped strings. The
> hooks are per clone — `setup.sh` turns them on.

> **Out of scope: models & API keys.** You (the user) set these up first
> yourself — `pi`, then `/login` for a subscription provider or drop an API
> key into `~/.pi/agent/models.json`, then pick a model with `/model` (or
> Ctrl+L). Nothing below touches `models.json` or `auth.json`. This guide
> covers everything _around_ the models: the install, MCP servers,
> extensions, skills, and the seeded memory.

## Prerequisites

- **Node.js + npm**, with the global npm prefix set to `~/.node_modules`
  (so `npm i -g` lands in `~/.node_modules/lib/node_modules` and binaries
  in `~/.node_modules/bin`, which must be on `PATH`). This is provided by
  the Home Manager shell config.
- **uv / uvx** — used by the `nixos` MCP server. Install via
  `pipx install uv` or the standalone installer; ensure `uvx` is on `PATH`.
- **CLI tools the seeded memory rules assume:** `gh` (GitHub CLI),
  `obscura` (Rust headless browser, see below).

### SearXNG (optional — private search backend for `pi-web-access`)

Web search comes from the `pi-web-access` extension (step 6), not an MCP
server. It works with **no configuration** — Exa MCP serves it keyless. SearXNG
is optional and only worth wiring if you want search that never leaves your
network.

`pi-web-access` reads `web-search.json` from `$PI_CODING_AGENT_DIR` when that
is set, otherwise from `~/.pi/agent/` (or `~/.pi/` if only that one has the
file). With `XDG_CONFIG_HOME` set it reads `$XDG_CONFIG_HOME/pi/` (or `~/.pi/`)
instead and never looks in `~/.pi/agent/`.

```json
{
  "searxngBaseUrl": "http://127.0.0.1:48431",
  "searchRouting": { "providers": ["searxng", "exa"],
                     "fallbackOn": ["transient", "quota", "network", "invalid-response"] },
  "fetchRouting":  { "providers": ["http", "jina"], "allowRemoteHostedProviders": false },
  "maxInlineContentChars": 30000,
  "ssrf": { "allowLoopback": true, "allowRanges": ["127.0.0.0/8"] }
}
```

> **The `ssrf` block is required for a local SearXNG, and needs both keys.**
> They are separate code paths: `allowLoopback` permits the *hostname*
> `localhost`, while `allowRanges` permits *IP addresses*. A `searxngBaseUrl`
> of `http://127.0.0.1:…` is an IP, so `allowLoopback` alone still fails with
> `Blocked internal address for 127.0.0.1`, and search silently falls back to
> a public provider. Set both.

**Set `"toolActivation": "eager"`** — in the same file, SearXNG or not (this
machine's `~/.pi/agent/web-search.json` holds just that). The default,
`"dynamic"`, starts each session with a small `web_enable` tool and adds the
four real web tools when the model calls it. That changes the tool list
mid-session, which breaks the prompt cache from the tool definitions on: one
full-price re-read of the whole prompt on a cloud provider, and a full
re-prefill on a local hybrid model (125 s for 36k tokens on Bonsai 27B).
Eager adds ~3.3k tokens to
every request, cached after the first, which is cheaper as soon as most
sessions search at some point.

On NixOS the service is declared at `NixOS/hosts/common/searx.nix`. Three
settings there matter to pi:

- `server.port` — must match `searxngBaseUrl`
- `search.formats` — must include `"json"`, or the API returns HTML only
- `server.limiter = false` — the rate limiter rejects programmatic queries

Verify with `curl "http://127.0.0.1:<port>/search?q=test&format=json"`. If you
are not running SearXNG, omit `searxngBaseUrl` and `ssrf` entirely; routing
falls through to the public providers.

## 1. Install pi

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version     # expect 0.86.x or newer
```

`--ignore-scripts` is the documented install flag (pi needs no lifecycle
scripts). The binary ends up at `~/.node_modules/bin/pi`. If pi is already
installed and `pi --version` shows 0.86.x+, skip to step 2.

> **Config location.** Everything below assumes the default `~/.pi/agent/`.
> `PI_CODING_AGENT_DIR` overrides it, and `PI_CODING_AGENT_SESSION_DIR`
> relocates sessions alone. `auth.json`, `models.json` and `sessions/`
> resolve off the same root as the tracked config — the allowlist
> `.gitignore` is what keeps them out of git, so never replace it with a
> denylist.

## 2. Set up your models (you do this, not this guide)

Launch `pi`, run `/login` (subscription) or add an API key to
`~/.pi/agent/models.json`, then `/model`. Confirm a chat works before
continuing — the MCP servers and extensions below are useless without a
working model.

## 3. Directory layout (`~/.pi/agent/`)

pi creates most of this on first run. What matters:

| Path                                   | Purpose                                    | Managed here? |
| -------------------------------------- | ------------------------------------------ | ------------- |
| `models.json`                          | Providers + API keys                       | **No** (you)  |
| `auth.json`, `models-store.json`       | OAuth tokens from `/login`                 | **No** (pi)   |
| `settings.shared.json`                 | Shared settings: packages, tools, theme    | Yes (step 4)  |
| `settings.json`                        | pi's live settings: shared ones merged in, plus toggles and model picks | **No** (per machine; step 4) |
| `mcp-adapter.json`                     | MCP server definitions (pi-mcp-adapter)    | **No** (yours; suggestions in step 5) |
| `model-state.json`, `pi-book.json`, `.env` | micro models; pi-book's models; per-machine env and secrets | **No** (per machine) |
| `book/`                                | pi-book's notes: private (step 8)            | **No** (private; never synced) |
| `pi.env`                               | Shared env switches                        | Yes (step 4b) |
| `npm/`                                 | pi's package install tree                  | **No** (rebuilt by `setup.sh`) |
| `extensions/`                          | Local TypeScript extensions                | Yes, except the machine-local ones (step 7) |
| `skills/`                              | User-global skills (`SKILL.md` per dir)    | **No** (personal, like `mcp-adapter.json`; suggestions in step 7b) |
| `themes/`                              | base16/base24 YAML (→ JSON via `base16-theme.ts`) or pi theme JSON | YAML + hand-written JSON only |
| `subagents.json`                       | Per-extension config                       | Yes           |
| `keybindings.json`                     | Key overrides: Ctrl+Backspace / Ctrl+H delete a word | Yes |
| `AGENTS.md`                            | Global system prompt + MCP routing rules   | Yes           |
| `mcp-cache.json`, `mcp-npx-cache.json` | Auto-generated MCP tool caches             | No (auto)     |
| `sessions/`, `memories/`, `stream/`, `trust.json` | Runtime state                   | No (auto)     |

`AGENTS.md` is worth calling out: it carries the MCP routing rules that tell
the model which tool to reach for (`web_search`/`web_fetch` for the web,
obscura for pages that need a real browser, grep_app for public code, context7
for library docs, nixos for packages; memory is pi-book, step 8). Without it the
servers are present but rarely chosen well.

## 4. `settings.shared.json` (shared settings)

Shared settings live in **`~/.pi/agent/settings.shared.json`** (tracked). pi
itself reads and writes `~/.pi/agent/settings.json`, which is private: toggles
(Ctrl+T, `/settings`), model picks and anything a future pi writes stay there.
`.githooks/sync-settings.mjs` merges the shared file into it — `setup.sh` and
the git hooks run it — with a 3-way merge: a shared key is applied when it
*changed* since the last sync, so a local override survives until the shared
value itself changes, and keys the shared file never had are never touched.

- Edit shared settings in `settings.shared.json`, then run `setup.sh` (or
  `node ~/.pi/.githooks/sync-settings.mjs`).
- `pi install <pkg>` writes only `settings.json`; share the package with
  `node ~/.pi/.githooks/sync-settings.mjs --promote packages`. The pre-commit
  hook notes packages that are installed but not shared.
- `sync-settings.mjs --check` reports what a sync would change.

The shared file, as a starting point:

```json
{
  "theme": "gruvbox-material",
  "packages": [
    "npm:@gamaraan/todos-tool",
    "npm:@narumitw/pi-plan-mode",
    "npm:@vanillagreen/pi-background-tasks",
    "npm:pi-hashline-edit-pro",
    "npm:pi-lens",
    "npm:pi-mcp-adapter",
    "npm:pi-mono-ask-user-question",
    "npm:pi-mono-auto-fix",
    "npm:pi-mono-btw",
    "npm:pi-mono-context",
    "npm:pi-mono-review",
    "npm:pi-simplify",
    "npm:pi-web-access",
    "npm:pi-x-search"
  ],
  "defaultTools": ["read", "bash", "edit", "write", "find"],
  "compaction": {
    "enabled": true,
    "reserveTokens": 45000,
    "keepRecentTokens": 30000
  },
  "markdown": { "mermaid": "final" }
}
```

- `packages` is the list of extensions pi auto-installs into `~/.pi/agent/npm/`
  on startup (and via `pi install <pkg>`). See step 6.
- `defaultTools` adds pi's built-in `find` (fd, respects `.gitignore`) to the
  default four. With it, search needs no package: `find` for file names and
  pi-hashline-edit-pro's `anchor_grep` (ripgrep) for contents. hashline still
  replaces `read` and the edit tools, and sudo-session wraps `bash`.

> **`packages` is the only thing that loads an npm extension.** pi's
> `resolve()` iterates this array and nothing else — it never scans
> `node_modules`. A package sitting in `npm/node_modules` but missing from
> `packages` is invisible: not loaded, not updated by `pi update`, but still
> able to wreck npm dependency resolution for the packages you *do* use.
> Keep this list and `npm/package.json` in agreement.
>
> Local extensions are the exception: `~/.pi/agent/extensions/` (and
> `skills/`, `themes/`, `prompts/`) are auto-discovered and load without
> appearing here.

### Custom theme

pi itself only reads JSON themes, but you never have to write one: drop any
**base16 or base24 scheme YAML** into `~/.pi/agent/themes/` and select it by
file name.

```bash
mkdir -p ~/.pi/agent/themes
curl -fsSL https://raw.githubusercontent.com/tinted-theming/schemes/spec-0.11/base24/catppuccin-mocha.yaml \
  -o ~/.pi/agent/themes/catppuccin-mocha.yaml
# then: "theme": "catppuccin-mocha" in settings.shared.json (shared) or /settings → Theme (this machine)
```

`extensions/base16-theme.ts` converts every `themes/<name>.yaml` (or `.yml`)
into `themes/<name>.json` when pi starts and on `/reload`, before pi applies
the theme setting, so a new scheme works on the first launch. (It only shows up
in pi's startup theme list from the second launch on.) Notes:

- Both the tinted-theming layout (`palette:` block) and the legacy flat base16
  layout work. base24 schemes use base10–base17; base16 schemes derive them.
- The UI accent is base09 (orange). Add a top-level `accent: base0D` line to a
  scheme to use another slot.
- The generated JSON is machine-local and never enters this repo. The
  extension only rewrites JSON it generated itself; a hand-written or
  symlinked `<name>.json` (e.g. home-manager's) of the same name is left
  alone and reported.
- Edit the YAML, then `/reload`. pi hot-reloads the regenerated JSON.

Themes in this repo (`agent/themes/`): `gruvbox-material.yaml`
(default, a copy of the dotfiles' `NixOS/home/common/colors/gruvbox-material.yaml`) and the
hand-written `claude-dark.json`. On NixOS, Home Manager also writes the active
stylix scheme to `~/.pi/agent/themes/stylix.yaml`
(`NixOS/home/common/core/pi-theme.nix`); select it with `"theme": "stylix"`.
Stylix is optional; the extension needs nothing but the YAML.

### 4b. Environment switches (`pi.env`, `.env`)

pi reads no env file of its own, so `extensions/00-env.ts` loads two before any
other extension runs (the `00-` prefix makes it load first — keep it):

| File | Scope | Holds |
|---|---|---|
| `agent/pi.env` | tracked in this repo | non-secret switches (none needed at the moment) |
| `~/.pi/agent/.env` | this machine only, never committed (not on the allowlist) | per-machine values and secrets |

`.env` overrides `pi.env`; a variable exported in your shell overrides both, so
a one-off `PI_BOOK=off pi` still works. Values that a parent
pi loaded (and a bash tool, a tmux server started from pi, or a nested pi
inherited) are reloaded from the files rather than treated as your overrides.
`/env` lists what was loaded from where — names only, never values. This
replaces setting these in a shell profile, so non-Nix machines get them too.

## 5. MCP servers (`mcp-adapter.json`) — *suggestions, not a manifest*

> **`mcp-adapter.json` is deliberately not tracked in this repo** (it is off
> the `.gitignore` allowlist and on the pre-commit never-list). Server entries routinely carry inline credentials — an
> API token in `env`, a bearer in a URL — and which servers you want is a
> per-machine choice. What follows is a menu to pick from, not a file to copy.

Write `~/.pi/agent/mcp-adapter.json` yourself. (pi-mcp-adapter 3.0 stopped
reading `mcp.json`, which now belongs to pi's upcoming built-in MCP support; the
format is unchanged, so an old `mcp.json` only needs renaming.) STDIO servers use `command` + `args`
(+ optional `env`); HTTP servers use `url`. `lifecycle: "lazy"` spawns on first
use (good for stateless clients); `"keep-alive"` keeps the process alive (for
stateful daemons). The server list loads at session start — new entries need a
pi restart (or `/reload`) to appear.

### Suggested servers

Each is independently useful; take what you need.

| Server | Type | Gives you | Needs |
|---|---|---|---|
| `context7` | STDIO (`npx`) | up-to-date library/framework docs | nothing |
| `grep_app` | HTTP | search public GitHub code | nothing |
| `nixos` | STDIO (`uvx`) | nixpkgs / NixOS options lookup | `uvx` |
| `obscura` | STDIO | drive a real page — navigate, click, forms, JS render | `obscura` on `PATH` |

Web search is **not** on this list: `pi-web-access` (step 6) provides
`web_search` / `fetch_content` as ordinary tools, with local SearXNG tried first.
An MCP search server such as `argus` is redundant alongside it.

> **Credentials belong in `env`, not inline where you can help it.** A token
> written straight into `mcp-adapter.json` is why the file is untracked. Prefer
> `"API_TOKEN": "${API_TOKEN}"` env entries exported from your shell, or
> keep the credential in the server's own config file.

> **On `keep-alive` vs `lazy`.** Both appear in the prompt as a single
> `mcp__<server>` namespace proxy — the underlying tools are *not* enumerated,
> so the choice costs roughly one line either way. `keep-alive` keeps the
> process warm (worth it for a stateful daemon); `lazy` spawns on first use.
> Pick on startup latency, not on context.

```json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp@latest"],
      "lifecycle": "lazy"
    },
    "grep_app": {
      "url": "https://mcp.grep.app",
      "lifecycle": "lazy"
    },
    "obscura": {
      "command": "obscura",
      "args": ["mcp"],
      "lifecycle": "keep-alive"
    },
    "nixos": {
      "command": "uvx",
      "args": ["mcp-nixos"],
      "lifecycle": "lazy"
    }
  }
}
```

**What each server does / what it needs:**

| Server      | Type  | Needs                                                                                                                                      |
| ----------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `context7`  | STDIO | Nothing (public npx package, library docs).                                                                                                |
| `grep_app`  | HTTP  | Nothing (public, code search).                                                                                                             |
| `obscura`   | STDIO | The `obscura` Rust binary on `PATH`. Headless browser / page render.                                                                       |
| `nixos`     | STDIO | `uvx`. Query nixpkgs / NixOS options.                                                                                                      |

Memory is not an MCP server: it is the pi-book extension (step 8).

## 6. Extensions (npm packages)

Already listed under `packages` in `settings.shared.json` (step 4). On startup pi
installs missing entries into `~/.pi/agent/npm/` and updates
`~/.pi/agent/npm/package.json`. To install/update explicitly:

```bash
pi install npm:pi-lens            # one package
pi update --extensions             # update all installed extensions
```

What they are:

- `@gamaraan/todos-tool` — phased todo tool with reminders and a HUD
  (an Oh-My-Pi-style `todo`; pi ships no todo tool of its own).
- `@narumitw/pi-plan-mode` — Codex-like read-only `/plan` collaboration mode.
- `@vanillagreen/pi-background-tasks` — background shell tasks (`bg_task`,
  `bg_status`): persistent logs, wake-ups on exit or on matching output, no
  default timeout. Its postinstall writes a usage guide into
  `APPEND_SYSTEM.md`; `extensions/strip-append-system.ts` keeps that out of
  the prompt.
- `pi-hashline-edit-pro` — hash-anchored read/replace/insert/grep. Every line
  gets a stable 4-char anchor; stale or ambiguous anchors are rejected rather
  than fuzzy-matched. `AGENTS.md` tells the model to prefer these over
  `cat`/`head`/`sed`.
- `pi-lens` — real-time code feedback: LSP, linters, formatters,
  type-checking, structural analysis. Also ships four `pi-lens-*` skills.
  This is the closest thing here to an IDE wired into the agent.
- `pi-mcp-adapter` — MCP integration (config merging, oauth, `/mcp-adapter` panel;
  `/mcp` still works as a shortcut).
  Everything in step 5 depends on it; remove it and all six servers go dark.
- `pi-mono-ask-user-question` — structured multiple-choice questions instead
  of the model guessing.
- `pi-mono-auto-fix` — runs language-appropriate fixers (eslint, black,
  prettier, …) over files touched during a turn.
- `pi-mono-btw` — `/btw` answers a side question while the main agent keeps
  running, without polluting the main thread.
- `pi-mono-context` — prints current context-window usage *without* adding
  that report to future context.
- `pi-mono-review` — reviews GitHub PRs and GitLab MRs.
- `pi-web-access` — `web_search` / `fetch_content`. SearXNG first when configured
  (see Prerequisites), then public providers. GitHub URLs are cloned locally
  rather than scraped, so the agent gets real file contents.
- `pi-simplify` — reviews the **local** working diff for clarity and
  maintainability. Complements `pi-mono-review` rather than overlapping it
  (remote PR vs local diff).
- `pi-x-search` — searches X with verbatim post quotes and resolved URLs.
  Needs xAI auth (`/login` → xAI, or `XAI_API_KEY`). Note it **searches**;
  it cannot fetch a specific X URL — use obscura for that.
### 6b. Footer (`extensions/statusline.ts`)

The footer is this repo's own two-line status line, not a package:

```
deepseek-v4.1-flash · OpenCode Go · max · my-session          watchdog:on · LSP …
.pi on  main [!?] via ❄ impure            22k/1.0M · ↑44k ↓98 · cache 50% · $0.003 · 22 tok/s
```

Line 1 is the model, provider, thinking level and session name, with the other
extensions' statuses on the right. Line 2 is the real `starship prompt` for the
working directory (directory, git, language versions, nix-shell — whatever your
starship config renders), then context as real token counts, tokens in/out,
prompt-cache hit rate, cost, and the last reply's output tokens/s. Context turns
warning/error at a percentage *or* a token count, whichever comes first — on a
1M-token window a percentage alone would stay quiet until 700k.

starship never runs while drawing: it refreshes in the background after each
prompt and run, and the footer shows the last result. Without starship on
`PATH` the left side falls back to the directory name and git branch. Narrow
terminals drop whole segments (tok/s, cache, cost, tokens) and truncate
starship's text last. Settings, all optional, in `settings.shared.json` (or a
machine's own `settings.json`):

```json
"statusline": {
  "hide": [],
  "contextThresholds": { "warning": [70, 150000], "error": [90, 500000] },
  "separator": " · ",
  "starship": true
}
```

`/statusline` toggles it for a session (pi's built-in footer comes back). It
replaced `pi-zentui`, whose footer needed a local patch inside `node_modules`
to show real token counts, pinned to one version so updates would not undo it.

## 7. Skills + local extension

Skills are `SKILL.md` files. pi loads them from (in order) `.pi/skills/`,
`.agents/skills/` (project, walking up parents), then `~/.pi/agent/skills/`
and `~/.agents/skills/` (user-global).

**Skills are personal — this repo ships none.** Like `mcp-adapter.json`, `skills/` is
off the allowlist: every listed skill costs prompt tokens in every session, a
skill that does not fit your work is a routing mistake waiting to happen, and
the best skills are the ones written from your own sessions (`/learn`,
`/skill-review` — see `skill-manage.ts` below). Step 7b lists sources to pick
from. The repo ships one **recipe doc** for a local TypeScript extension:

- `docs/extensions/litellm-auto.md` — the recipe for an optional extension that
  auto-discovers chat models from a self-hosted LiteLLM-compatible gateway
  (`/v1/model/info`) and registers them as a provider. Only relevant if you run
  your own gateway; skip otherwise. The doc contains the full minimal
  implementation, config env vars, hardening notes, and where credentials live.

**Machine-specific values stay out of this repo.** `litellm-auto.ts` itself is
tracked (the shareable build of that recipe): it reads the gateway URL from
`~/.pi/secrets/litellm.url` (or `LITELLM_BASE_URL`) and its key from
`auth.json`, and on a machine with no gateway configured it does nothing, so it
is safe to keep on every machine.

The rest of `extensions/` **is** tracked here (an extension meant for one
machine only would be listed by name in `.gitignore` instead):

| Extension | Does |
|---|---|
| `neat-render.ts` | Claude-Code-shaped tool rows: two-line call/outcome, wrapped `└ $` for running commands, inline edit diffs, pulsing bullet. Ctrl+O shows each call in an omp-style frame (command — bash syntax-highlighted — then an `Output` divider, status in the bottom border) instead of pi's tinted box. A bash command's leading `# comment` lines show as a dim `# …` line above the call, so the row itself shows the actual command. Env knobs in its header. |
| `read-guard/` | Trims a `read` only when it would overflow the context window, returning the first 30 lines plus a use-grep-instead directive. From little-coder. Replaced `pi-mono-context-guard`, which capped every read at 120 lines regardless of pressure. |
| `compaction-continue/` | Watchdog that nudges pi to resume when a turn stalls. Upstream is unmaintained since 2026-05; the compaction half it was written for was fixed in pi 0.84.4, the stalled-turn half is still live. |
| `sudo-session.ts` | `/sudo` elevation for the bash tool. |
| `microcall.ts` | One-shot side calls for other extensions (`globalThis[Symbol.for("pi.microcall")]`), each run as a fresh isolated in-process pi session: no extensions, skills, AGENTS.md or tools, in-memory, thinking off. Because it is a real pi session, requests carry pi's own provider headers — so it works on providers that reject raw SDK calls (OpenCode Go). Model chain: `model-state.json` `"micro"` (`model` + `fallbacks`), else the caller's default, else the session model. `/microcall` shows the chain and recent calls; `/microcall test` round-trips. |
| `eval/` | `eval` tool: Python (`runner.py`, plain CPython — `python3` on PATH or `EVAL_PYTHON`) and JavaScript (`kernel.cjs`, Node REPL semantics) in persistent per-session kernels. Last-expression value, top-level await, `!cmd`/`%pip` in Python; Ctrl+C/timeout interrupts a cell, and a kernel that will not stop is restarted. Modelled on omp's `eval`. |
| `00-env.ts` | Loads `pi.env` (shared) and `.env` (this machine) into the environment before every other extension; `/env` shows names and sources. See step 4b. |
| `pi-book/` | Long-term memory as Markdown notes in `~/.pi/agent/book/` — recall, capture, the `memory` tool, `/remember`, `/memory`. See step 8. |
| `herdr-agent-state.ts` | Publishes agent state for desktop integrations. |
| `statusline.ts` | The two-line footer: model / provider / thinking and extension statuses, then the real `starship prompt` plus context, tokens, cache hit rate, cost and tok/s. See step 6b. |
| `local-llama-autodetect.ts` | Finds a running llama.cpp `llama-server` (`$LOCAL_LLAMA_URL`, else `models.json`'s `local-model` baseUrl, else `localhost:8081`/`8080`) and registers it as the `local-model` provider with the server's real context window, thinking levels and vision support. `/local-model` re-detects after you restart the server with another model. Fails fast and registers nothing when no server answers. |
| `skill-manage.ts` | A port of Hermes' skill machinery: the `skill_manage` tool (create / patch / delete skills and their files), `/learn <topic>` to author a skill from sources, `/skill-review` to codify what a conversation taught, `/skills-show`. Writes to `~/.pi/agent/skills/`, which is never tracked — your skills stay yours. |
| `tmux-stream.ts` | For `pi -p` (no TUI): mirrors reasoning and tool calls live into a tmux session (`tmux attach -r -t pi-stream`) and logs them to `~/.pi/agent/stream/` (never tracked — logs hold session content). `PI_TMUX_STREAM=0/1` forces it off/on. |

### 7b. User-global skills — *suggestions, not a manifest*

Nothing below is installed by `setup.sh`; pick what fits your work.


- **`obscura`** → from the upstream repo,
  **[h4ckf0r0day/obscura](https://github.com/h4ckf0r0day/obscura)** — do **not**
  vendor it here. Clone and copy its skill:

  ```bash
  git clone --depth 1 https://github.com/h4ckf0r0day/obscura /tmp/obscura
  mkdir -p ~/.pi/agent/skills/obscura
  cp /tmp/obscura/skills/obscura/SKILL.md ~/.pi/agent/skills/obscura/
  rm -rf /tmp/obscura
  ```

  Teaches CDP / page-render usage. Install it only if you use the obscura MCP
  server (step 5).
- **`pdf`** → the MIT skill from `@joemccann/pi-pdf`, without the package: its
  12 `pdf_*` tools cost ~1.8k tokens in every session, while the skill does the
  same work (text/tables, merge/split, rotate, watermark, encrypt, forms, OCR)
  in Python for ~150 tokens until it is used.

  ```bash
  cd /tmp && npm pack @joemccann/pi-pdf && tar xzf joemccann-pi-pdf-*.tgz
  cp -r package/skills/pdf ~/.pi/agent/skills/ && cp package/LICENSE ~/.pi/agent/skills/pdf/
  rm -rf package joemccann-pi-pdf-*.tgz
  ```

  It needs `python3` with `pypdf pdfplumber reportlab pdf2image pytesseract
  pypdfium2 pillow`, plus `tesseract`, `poppler` and `qpdf`. On NixOS declare
  them (dotfiles: a `python3.withPackages` entry in home-manager — the one
  `python3` on PATH, so pi's `eval` tool gets them too) and replace the skill's
  `pip install` line with a pointer to that.
- **`pi-lens-*`** (`ast-grep`, `lsp-navigation`, `write-ast-grep-rule`,
  `write-tree-sitter-rule`) → no manual copy; shipped by the `pi-lens` npm
  extension (step 6).
- **`find-skills`, `hindsight-docs`, `microsoft-foundry`, `mcp-scripting`,
  `self-learning`** → `~/.agents/skills/` (cross-agent convention) or from
  their own packages. Install on demand via the `find-skills` skill; not
  required for a baseline setup.
- **`skill-creator`** → previously came from
  `@howaboua/pi-skill-skill-creator`, **removed** from the package list
  (v0.0.5, too immature to carry). Re-add with
  `pi install npm:@howaboua/pi-skill-skill-creator` if you want it back.

- **`semantic-compression`, `system-prompts`, `tool-prompt-optimization`** →
  bundled with omp (oh-my-pi), MIT © Mario Zechner. Copy them out of an omp
  install into `~/.pi/agent/skills/<name>/` if you want them (keep each
  `LICENSE`).

Keep your own skills in sync across machines privately (dotfiles, a private
repo) — never by adding `skills/` to this repo's allowlist.


If a skill ships inside a package/venv, copy just the `SKILL.md` (and any
referenced sibling files) into the target dir — pi reads the file directly.

### ⚠️ Restart pi before steps 8–10

Extensions (step 6 + 7) and MCP servers (step 5) load at pi **startup**,
not mid-session. You've just written `settings.shared.json` and `mcp-adapter.json` during
this session, so the npm extensions and MCP servers are **not yet loaded** —
`/mcp-adapter` will show nothing until you restart. Exit pi and relaunch it, then
continue from step 8.

## 8. Memory (pi-book)

Full reference: [docs/memory.md](docs/memory.md); measurements:
[docs/memory-benchmarks.md](docs/memory-benchmarks.md).

Long-term memory is `extensions/pi-book/`: a small book of Markdown notes
you can read and fix by hand, in `~/.pi/agent/book/`. The book is private — no
git repo, not synced, outside this repo's allowlist and on the pre-commit
never-list — because pi fills it with what it learns about you and your projects.

```
book/INDEX.md                    generated table of contents
book/user/<chapter>.md           about you: preferences, environment, workflow
book/projects/<id>/<chapter>.md  one project: decisions, conventions, gotchas
book/projects/<id>/journal.md    recent session digests (medium-term, expire)
book/.index/                     search vectors (derived; safe to delete)
book/.history/                   a chapter's previous text before each rewrite
```

A chapter is `## Section` blocks of dated bullets. Project ids come from the
git remote, so every checkout of a repo shares its notes and other projects'
notes never appear.

Memory has tiers, and the capture model sorts what it reads between them:

| Tier | Holds | Lives | Reaches the model |
|---|---|---|---|
| short | the live session | the session | pi's own context |
| medium — `journal.md` | one digest per session: Done / Tried / Failed / Decided / Open / Next | `journal.ttlDays` (30), then one promotion pass moves lasting facts into chapters | the last `journal.recall` (2) digests at session start |
| long — chapters | durable facts: preferences, decisions, conventions, gotchas | until changed | chapter list + matching notes at session start |
| archive | pi's own session files, verbatim | as long as pi keeps them | only on request: `memory` action `history` |

Size routes too, in code: a note is one fact of at most 300 characters; a
"fact" longer than that is moved into the session's digest; digests are at
most 8 bullets of 240 characters; code, logs and long explanations are never
stored — they stay searchable in the archive.

- **Recall** — before the first prompt of a session (and again after a
  compaction), one message: the chapters in scope, the last sessions' digests
  (at most 5 lines each, open and decided items first) and the matching notes.
  Reads are budgeted and bullet-level: each fact is scored on its own and only
  matching facts are shown under their heading, until `recall.budgetTokens` is
  spent — on LoCoMo this delivers the same evidence as whole-section reads for
  about a third fewer tokens. Search is BM25 plus embeddings fused with RRF; a note must reach
  `minCos` similarity to be recalled, and search falls back to keywords when
  the embedding server is down. Shown as one `● Memory · …` line; Ctrl+O expands.
- **Capture** — after each agent run, one small model call reads the new turns
  against the notes already on the subject and proposes add / update / delete —
  usually nothing. Plain acknowledgements skip the call. Credentials, notes over
  300 characters and updates that only reword a note are refused in code.
- **`memory` tool** — `search`, `read` a chapter or `INDEX`, `write` /
  `update` / `delete` a note, `history` (keyword search over past sessions).
- **Commands** — `/remember <fact>` (the model files it; saved verbatim to
  `notes › Inbox` if the model call fails), `/memory` (status and recent
  captures), `/memory search <q>` (ranks), `/memory reindex`, `/memory tidy`
  (merges duplicates and drops stale notes, one chapter at a time).

**Models** go in `agent/pi-book.json` (per machine; see `pi-book_example.json`
and [docs/memory.md](docs/memory.md#configuration)):

```json
{
  "model": "litellm/GLM-5.3-Flash",
  "mode": "microcall",
  "embedding": "litellm/Qwen3-Embedding-8B"
}
```

`mode` is `"microcall"` (a pi session, any provider) or `"normal"` (a direct
OpenAI-compatible call); providers resolve from `models.json` / `auth.json`.
The long form below also works there (or in `model-state.json` `"memory"`, the
older home). Everything has a default:

```json
"memory": {
  "llm":    { "mode": "pi" },
  "embed":  { "url": "http://127.0.0.1:8090/v1", "model": "embeddinggemma" },
  "recall": { "enabled": true, "budgetTokens": 400, "maxChars": 2800, "minCos": 0.3 },
  "capture": "auto",
  "journal": { "enabled": true, "ttlDays": 30, "recall": 2, "maxBullets": 8 }
}
```

`llm.mode` picks how capture and tidy reach a model:

- `"pi"` — a minimal isolated pi session through `microcall.ts` (from the CLI,
  one built from pi's SDK). Required for providers that only accept a coding
  agent's own traffic, such as OpenCode Go. `"model": "provider/id"` pins one;
  without it the `"micro"` chain is used.
- `"raw"` — a plain OpenAI-compatible `/chat/completions` call, for a server you
  run (llama-server, vLLM) or a provider that allows direct API use:
  `{ "mode": "raw", "baseUrl": "http://127.0.0.1:8081/v1", "model": "…",
  "apiKeyEnv": "…", "extraBody": { "chat_template_kwargs": { "enable_thinking": false } } }`.
  OpenCode Go URLs are refused in this mode.

`embed.url` is any OpenAI-compatible `/embeddings` endpoint; set it to `""` for
keyword-only search. EmbeddingGemma, Qwen3-Embedding and nomic get their task
prefixes automatically; others take `queryPrefix` / `docPrefix`. On
nixos-desktop the endpoint is the `llama-embed` home-manager user service
(`NixOS/home/nixos-desktop/llama-embed.nix`): EmbeddingGemma-300M on
llama-server, CPU only (the GPU is hidden from the unit, `Nice=10`), ~500 MB
RAM, ~13 ms a query, ~25 new sections a second.

**CLI** — `node ~/.pi/agent/extensions/pi-book/cli.ts status | search <q> |
recall <prompt> | capture < transcript | history <q>` works outside pi (`--project <id>`;
`PI_MEMORY_DIR` points it at another book).

## 9. Checklist (user-provided, outside this repo)

These are **not in this repo** — supply them before first run:

- [ ] `~/.pi/agent/models.json` — provider configuration (you set this up, step 2).
- [ ] `~/.pi/agent/auth.json` — created automatically by `/login`.
- [ ] `web-search.json` — optional. Only needed for a private SearXNG
      backend; `pi-web-access` works keyless otherwise (see Prerequisites).
- [ ] `~/.pi/agent/mcp-adapter.json` — yours to write; suggestions in step 5.
- [ ] `obscura` binary on `PATH`; `uvx` on `PATH`.

## 10. Verify

```bash
pi                       # launches; no config errors
# inside pi:
/mcp-adapter             # lists every server you configured, each "connected"
# tools from whichever servers you configured should appear
/memory                  # pi-book status (step 8)
```

Then check that an extension tool like `ask_user_question` or the pi-lens
diagnostics tools resolve. If a STDIO MCP server shows disconnected, run its
`command` + `args` manually to see the startup error, and confirm `env`/`PATH`
are set.

Confirm the npm extensions are live: run `pi config` and check the package list
from step 4 shows everything enabled; try a tool provided by one of them (e.g.
`ask_user_question` or the pi-lens diagnostics tools).

Also confirm the two things that fail quietly:

```bash
~/.pi/setup.sh --check                             # packages, memory embeddings, git safeguards
git -C ~/.pi status --short                        # only config you meant to change
```

In pi, `/todo` should respond (from `@gamaraan/todos-tool`), and the footer's
second line should show your starship prompt and a real token count like
`22k/1.0M` (step 6b).
