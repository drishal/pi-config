# Configuration files

What lives where under `~/.pi/agent/`, which files this repo tracks, and the
custom sections our extensions read. First-time setup is [SETUP.md](../SETUP.md).

## Tracked vs private

| File | Holds | Tracked |
|---|---|---|
| `settings.shared.json` | hand-picked shared settings: packages, `defaultTools`, theme, compaction, `statusline` | yes |
| `settings.json` | pi's live settings: the shared ones merged in, plus toggles, model picks and the per-machine `subagents` routing | **no** — per machine |
| `pi.env` | shared non-secret env switches | yes |
| `AGENTS.md` | the global system prompt: style, tool routing | yes |
| `extensions/`, `themes/` (YAML + hand-written JSON) | local extensions, themes | yes |
| `subagents.json` | per-extension config | yes |
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

## Subagent model routing (per machine)

`pi-subagents` reads its `subagents` block from pi's settings. It stays in the
private `settings.json`, never in `settings.shared.json`: every value names a
provider and model that exist on one machine, and those names bind the routing,
so a shared copy either leaks a private gateway or fails closed on a fresh
clone. The tracked `subagents.json` holds only the provider-neutral
concurrency limits.

The reference machine (`nixos-desktop`, OpenCode Go) routes by role:

| Role | Model | Thinking | Why |
|---|---|---|---|
| `scout` | `glm-5.3-flash` | low | 1M context, vision, 18B active — fast recon at 1/10 the GLM-5.3 price |
| `researcher` | `qwen3.8-flash` | — | 1M context, multimodal, independent family from the worker |
| `evidence-auditor` | `deepseek-v4-pro` | — | SWE-bench Verified 96.4 — the cheapest strong verifier at $1.98/M out |
| `worker` | `deepseek-v4.1-flash` | high | best agentic scores per dollar — the model the pool should mostly be spent on |
| `reviewer` | `minimax-m3` | — | SWE-bench Verified 80.5 at $1.20/M out; `glm-5.3` is the escalation for a hard diff |
| `oracle` | `xai/grok-4.7` | xhigh | AA Intelligence Index 46, a different vendor from every other role, and it spends the SuperGrok subscription rather than the pool; `kimi-k3` ($15/M out) and `glm-5.3` are the pool-side escalations |
| `delegate` | `inherit` | — | the parent's model, by definition |

Context is the other half of the cost. Only `oracle` (and its alias `advisor`)
ships `defaultContext: fork`; the other six start fresh, so a child gets the
system prompt, project context and the brief but not the conversation. Here
oracle is pinned to `fresh`: a forked call re-sent the whole session (477
messages, 290,612 tokens, $0.375 at list) where a brief sends 18,373 ($0.049).
The caller must therefore put the decision, the constraints and the question in
the task text — a bare question gets a context-free answer. The middle path,
`forkContext: { mode: "pruned", model: … }`, keeps a fork capped at 64 KiB with
overflow summarized, and is read from `~/.pi/agent/extensions/subagent/config.json`,
not from settings: a `subagents.forkContext` key there is silently inert, unlike
`subagents.agentOverrides.<name>.defaultContext`.
`defaultModel` is `deepseek-v4.1-flash`, so an agent without an override still
gets a cheap, strong model.

`modelScope` is deliberately absent. The Claude Code adapters honour it, and a
launch that pins no model then fails closed because the CLI's own default
cannot be checked — with `claude` and `codex` on `PATH`, a scope would turn
"use claude-code for a second opinion" into a launch error. A second allowance now
exists (SuperGrok), but the same trap applies, so fence specific agents instead of
setting a top-level allow.

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
| `mimo-v2.6-flash` | 0.14 | 0.28 |
| `qwen3.8-flash` | 0.15 | 0.47 |
| `glm-5.3-flash` | 0.15 | 0.50 |
| `deepseek-v4.1-flash` | 0.15 | 0.60 |
| `minimax-m3` | 0.30 | 1.20 |
| `deepseek-v4-pro` | 0.66 | 1.98 |
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
