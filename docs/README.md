# Documentation map

What is where in this pi configuration. Start here; setup steps for a new
machine are in [../SETUP.md](../SETUP.md).

| Page | Covers |
|---|---|
| [memory.md](memory.md) | pi-book, the memory: storage, tiers, recall, capture, guards, search, the `memory` tool, commands, config, CLI |
| [memory-benchmarks.md](memory-benchmarks.md) | how memory was measured (LoCoMo, read budgets, write quality) and how it compares with mem0 |
| [benchmarks/](benchmarks/README.md) | the benchmark harness, to re-run those numbers |
| [extensions/README.md](extensions/README.md) | every local extension: what it does, commands, settings |
| [extensions/microcall.md](extensions/microcall.md) | one-shot model calls as minimal pi sessions (and why) |
| [extensions/litellm-auto.md](extensions/litellm-auto.md) | recipe: auto-register models from a LiteLLM gateway |
| [configuration.md](configuration.md) | every config file: tracked vs private, `model-state.json` sections, env switches |
| [repo.md](repo.md) | how `~/.pi` is a repo without leaking state: allowlist, pre-commit hook, clean filter, `setup.sh` |

## Layout

```
~/.pi/
  README.md, SETUP.md, setup.sh     entry points
  docs/                             this documentation
  .gitignore, .gitattributes, .githooks/   the safeguards (repo.md)
  agent/
    AGENTS.md                       global system prompt (style, tool routing)
    settings.json, pi.env           shared settings (configuration.md)
    extensions/                     local extensions (extensions/README.md)
      pi-book/                  memory (memory.md)
    themes/                         base16 YAML → pi themes
    — private, never tracked —
    model-state.json, .env, auth.json, models.json, mcp-adapter.json
    book/                           pi-book's notes
    sessions/, skills/, npm/, stream/
```
