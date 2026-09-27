# Configuration files

What lives where under `~/.pi/agent/`, which files this repo tracks, and the
custom sections our extensions read. First-time setup is [SETUP.md](../SETUP.md).

## Tracked vs private

| File | Holds | Tracked |
|---|---|---|
| `settings.json` | packages, theme, compaction, `statusline` | yes — pi's runtime keys stripped on staging |
| `pi.env` | shared non-secret env switches | yes |
| `AGENTS.md` | the global system prompt: style, tool routing | yes |
| `extensions/`, `themes/` (YAML + hand-written JSON) | local extensions, themes | yes |
| `pi-fff.json`, `subagents.json` | per-extension config | yes |
| `model-state_example.json` | the shape of `model-state.json` | yes |
| `model-state.json` | model pick, `micro` chain, `memory` settings | **no** — per machine |
| `.env` | per-machine env and secrets | **no** |
| `auth.json`, `models-store.json` | OAuth tokens | **no** |
| `models.json` | providers and API keys | **no** |
| `mcp-adapter.json` | MCP servers for pi-mcp-adapter, often with credentials | **no** — suggestions in SETUP.md step 5 |
| `skills/` | your skills | **no** — personal |
| `book/` | pi-book's notes | **no** — private |
| `sessions/`, `stream/`, `npm/`, caches | runtime state | **no** |

## model-state.json

Per machine, never synced; `model-state_example.json` shows the shape.

```json
{
  "provider": "opencode-go",
  "model": "deepseek-v4.1-flash",
  "thinkingLevel": "max",
  "modelThinkingLevels": { "opencode-go/deepseek-v4.1-flash": "max" },
  "micro": {
    "model": "opencode-go/deepseek-v4.1-flash",
    "fallbacks": ["opencode-go/mimo-v2.6-flash"]
  },
  "memory": { "llm": { "mode": "pi" } }
}
```

| Section | Read by | Doc |
|---|---|---|
| `provider`, `model`, `thinkingLevel`, `modelThinkingLevels` | `remember-model.ts` | [extensions](extensions/README.md#remember-modelts) |
| `micro` | `microcall.ts` | [microcall.md](extensions/microcall.md) |
| `memory` | `pi-book/` | [memory.md](memory.md#configuration) |

## pi.env and .env

`KEY=value` files loaded by `00-env.ts` before any other extension; `.env`
overrides `pi.env`, and your shell overrides both. `pi.env` is committed, so
secrets never go there. Currently: `PI_BG_FEATURES=process`
(pi-background-tasks without its ~3.9k tokens of extra tool definitions).

Env switches read by our extensions:

| Variable | Extension | Effect |
|---|---|---|
| `PI_MICRO_MODEL` | microcall | override the model chain |
| `PI_MEMORY_DIR`, `PI_MEMORY_CONFIG` | pi-book | another book / config file |
| `PI_TMUX_STREAM`, `PI_TMUX_SESSION`, `PI_TMUX_MAX_RESULT` | tmux-stream | force on/off, session name, result cap |
| `NEAT_RENDER*` | neat-render | see [extensions](extensions/README.md#neat-renderts) |
| `EVAL_PYTHON`, `EVAL_NODE`, `EVAL_TIMEOUT` | eval | interpreters, cell timeout |
| `LOCAL_LLAMA_URL` | local-llama-autodetect | server to probe first |
| `LITELLM_BASE_URL` | litellm-auto | gateway URL |

## settings.json keys of our own

pi ignores keys it does not know, so extensions keep their settings here:

- `statusline` — see [extensions](extensions/README.md#statuslinets)

Everything else in `settings.json` is pi's own (packages, theme, compaction,
markdown). pi also writes `defaultProvider`, `defaultModel`,
`defaultThinkingLevel` and `lastChangelogVersion` at runtime; the clean filter
keeps them out of commits ([repo.md](repo.md)).

## Models and providers

- **OpenCode Go** (built into pi) is the main provider on the reference
  machine. It accepts only pi's own traffic, so side calls go through
  microcall, never a raw client.
- **Local models**: `local-llama-autodetect.ts` registers a running
  llama-server as `local-model` with its real limits.
- **A LiteLLM gateway** (work machine): `litellm-auto.ts`.
- **Embeddings** for memory come from any OpenAI-compatible `/embeddings`
  server; on the reference machine the `llama-embed` home-manager service runs
  EmbeddingGemma-300M on the CPU.
