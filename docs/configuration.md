# Configuration files

What lives where under `~/.pi/agent/`, which files this repo tracks, and the
custom sections our extensions read. First-time setup is [SETUP.md](../SETUP.md).

## Tracked vs private

| File | Holds | Tracked |
|---|---|---|
| `settings.shared.json` | hand-picked shared settings: packages, `defaultTools`, theme, compaction, `statusline` | yes |
| `settings.json` | pi's live settings: the shared ones merged in, plus toggles and model picks | **no** — per machine |
| `pi.env` | shared non-secret env switches | yes |
| `AGENTS.md` | the global system prompt: style, tool routing | yes |
| `extensions/`, `themes/` (YAML + hand-written JSON) | local extensions, themes | yes |
| `subagents-lite.json` | `pi-subagents-lite` global config: default model, concurrency | **no** — per machine |
| `agents/` | `pi-subagents-lite` role definitions: model, thinking, tools, prompt per `.md` | **no** — per machine |
| `keybindings.json` | editor key overrides: Ctrl+Backspace (and Ctrl+H, the raw byte foot/tmux send for it) delete a word | yes |
| `model-state_example.json` | the shape of `model-state.json` | yes |
| `model-state.json` | our extensions' model config: the `micro` chain | **no** — per machine |
| `pi-book_example.json` | the shape of `pi-book.json` | yes |
| `pi-book.json` | pi-book's models (`model`, `mode`, `embedding`) and settings | **no** — per machine; see [memory.md](memory.md#configuration) |
| `.env` | per-machine env and secrets | **no** |
| `auth.json`, `models-store.json` | OAuth tokens | **no** |
| `models.json` | providers and API keys | **no** |
| `mcp.json` | MCP servers for pi-mcp-adapter, often with credentials | **no** — suggestions in SETUP.md step 5 |
| `web-search.json` | pi-web-access: search backends, `toolActivation` | **no** — can hold API keys; see SETUP.md (SearXNG) |
| `skills/` | your skills | **no** — personal |
| `book/` | pi-book's notes | **no** — private |
| `sessions/`, `stream/`, `npm/`, caches | runtime state | **no** |

## Subagent routing (personal)

`pi-subagents-lite` keeps its whole configuration out of this repo, because
every value names a provider and model that exist on one machine:

- `~/.pi/agent/subagents-lite.json` — global default model and concurrency.
- `~/.pi/agent/agents/<role>.md` — one file per role: model, thinking level,
  tool allowlist, and the system prompt as frontmatter plus body.

A shared copy would either leak a private gateway or fail closed on a fresh
clone. `pi-subagents-lite` replaces the older `pi-subagents`, whose routing
lived in a `subagents` block in `settings.json` and a tracked `subagents.json`.

Two roles cover the split that matters: cheap width for looking things up, an
expensive second opinion for deciding. The parent session implements and does
routine review itself — it already holds the conversation, the hashline anchors
and the diff, and handing that to a child only re-sends context.

| Role | Model | Thinking | Tools | Job |
|---|---|---|---|---|
| `task` | `deepseek-v4.1-flash` | low | read, bash, find + web tools | read-only recon and research; returns the minimum context the parent needs |
| `oracle` | `xai/grok-4.7` | high | read, bash, find + web tools | hard decisions, change review, verification of claims against the source |

`task` is read-only on purpose: a recon spawn that can write is a bug waiting
to happen. Both roles carry the web tools (~1.7k tokens per spawn) because
verification sometimes needs evidence that is not in the repo: provider syntax,
library behavior, a changelog that contradicts a comment. `oracle` sits on
`xai/*`, so it spends the SuperGrok subscription rather than the OpenCode pool;
`kimi-k3` ($15/M out) and `glm-5.3` are the pool-side escalations if the
subscription hits a limit.

`subagents-lite.json` deliberately sets no `agent.default`. Model precedence is
session override > project file > `subagents-lite.json` > agent frontmatter >
parent, so a config-wide default would silently outrank every role file: the
first version set one and `oracle` ran on `deepseek-v4.1-flash` instead of grok.
Each role names its own model; a role file that omits `model` inherits the
parent.

Each role file sets `include_system_prompt: false`, which is lite's `replace`
mode: the child gets a minimal generic prompt plus the agent body, not the whole
main-session prompt. `include_context_files: true` keeps AGENTS.md. Context is
the other half of the cost, and lite has no fork mode: a child gets the prompt,
the project context and the brief, never the conversation. The caller must
therefore put the decision, the constraints and the question in the task text.

Three things drive the map. Thinking levels only exist where the model
publishes a `thinkingLevelMap`; asking a model with no map for a level is a
silent no-op, and asking for a level that maps to `null` falls back to `high`.
Usage draws on **one shared pool**: every model spends it at its own token
prices, so price per token is the only lever. OpenCode's per-model dollar figures
are not separate allowances. Subscribers still report the monthly bar reaching
100% below the sum of their visible usage (#46365, #50457), so read the
percentage as approximate and the reset timestamps as exact. Models under `xai/*`
do not touch the pool at all: the xAI OAuth login is a SuperGrok/X Premium
subscription with its own allowance, which is why `oracle` sits there.

Price per 1M tokens for the models this map uses:

| Model | in | out |
|---|---|---|
| `deepseek-v4.1-flash` | 0.15 | 0.60 |
| `glm-5.3` | 1.40 | 4.40 |
| `qwen3.8-max`, `grok-4.7` | 2.00 | 6.00 |
| `kimi-k3` | 3.00 | 15.00 |

`GET https://opencode.ai/zen/go/v1/usage` with a Go API key returns the rolling,
weekly and monthly percentages plus their reset timestamps — the cheapest way to
watch the pool. The pay-as-you-go **balance** is the overflow: with "Use balance"
enabled a model that reaches its limit falls back to it instead of being blocked.

## model-state.json

Our extensions' model settings, per machine and never synced;
`model-state_example.json` shows the shape. The model you work with is pi's
own business: pick it with `/model` (Ctrl+S makes it the default) and pi keeps
it in its private `settings.json` as `defaultProvider` / `defaultModel`, with
`defaultThinkingLevel` and per-model `modelThinkingLevels` beside it.

```json
{
  "micro": {
    "model": "opencode-go/deepseek-v4.1-flash",
    "fallbacks": ["opencode-go/mimo-v2.6-flash"]
  }
}
```

pi-book's models moved to their own file, `pi-book.json`; a `"memory"` section
here is still read (and `pi-book.json` wins).

| Section | Read by | Doc |
|---|---|---|
| `micro` | `microcall.ts` | [microcall.md](extensions/microcall.md) |
| `memory` | `pi-book/` (prefer `pi-book.json`) | [memory.md](memory.md#configuration) |

## pi.env and .env

`KEY=value` files loaded by `00-env.ts` before any other extension; `.env`
overrides `pi.env`, and your shell overrides both. `pi.env` is committed, so
secrets never go there. It sets nothing at the moment.

Env switches read by our extensions:

| Variable | Extension | Effect |
|---|---|---|
| `PI_MICRO_MODEL` | microcall | override the model chain |
| `PI_BOOK` | pi-book | `off` turns it off entirely (benchmarks, scripted runs) |
| `PI_MEMORY_DIR`, `PI_MEMORY_CONFIG` | pi-book | another book / config file |
| `PI_TMUX_STREAM`, `PI_TMUX_SESSION`, `PI_TMUX_MAX_RESULT` | tmux-stream | force on/off, session name, result cap |
| `NEAT_RENDER*` | neat-render | see [extensions](extensions/README.md#neat-renderts) |
| `EVAL_PYTHON`, `EVAL_NODE`, `EVAL_TIMEOUT` | eval | interpreters, cell timeout |
| `LOCAL_LLAMA_URL` | local-llama-autodetect | server to probe first |
| `LITELLM_BASE_URL` | litellm-auto | gateway URL |

## Settings: shared and live

pi reads one global settings file, `agent/settings.json`, and rewrites it
whenever you toggle something (Ctrl+T, `/settings`, the model and thinking
pickers). So it is private, and the settings meant for every machine live in
the tracked `agent/settings.shared.json`. `.githooks/sync-settings.mjs`
merges the shared file into the live one — from `setup.sh` and from the git
hooks after pull, checkout and rebase:

- a shared key that **changed** since the last sync is applied (objects key by
  key); an unchanged one is left alone, so a machine can override it
- a key removed from the shared file is removed locally unless it was changed
- keys the shared file never had — toggles, model picks, `lastChangelogVersion`,
  anything a future pi adds — are never touched

`--check` reports what a sync would change; `--promote <key>` copies a key
from the live file into the shared one (e.g. `packages` after `pi install`).
The last applied shared file is kept in `agent/.settings.shared.applied.json`.

pi ignores keys it does not know, so extensions keep their settings here too:
`statusline` — see [extensions](extensions/README.md#statuslinets).

## Models and providers

- **OpenCode Go** (built into pi) is the main provider on the reference
  machine. It accepts only pi's own traffic, so side calls go through
  microcall, never a raw client.
- **Local models**: `local-llama-autodetect.ts` registers a running
  llama-server as `local-model` with its real limits.
- **A LiteLLM gateway**, where one exists: `litellm-auto.ts` registers its
  models; the extension stays inert while no gateway is configured. Nothing in
  the shared settings may name it — see the routing section above.
- **Embeddings** for memory come from any OpenAI-compatible `/embeddings`
  server; on the reference machine the `llama-embed` home-manager service runs
  EmbeddingGemma-300M on the CPU.
