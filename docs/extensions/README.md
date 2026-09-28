# Local extensions

Everything under `agent/extensions/`. pi loads local extensions before npm
packages, in byte-sorted order (which is why `00-env.ts` has its prefix).
Packages are listed in [SETUP.md](../../SETUP.md) step 6.

| Extension | One line |
|---|---|
| [`00-env.ts`](#00-envts) | loads `pi.env` and `.env` before everything else |
| [`pi-book/`](#pi-book) | long-term memory as Markdown notes — [full doc](../memory.md) |
| [`microcall.ts`](#microcallts) | one-shot model calls as minimal isolated pi sessions — [full doc](microcall.md) |
| [`statusline.ts`](#statuslinets) | two-line footer with the real starship prompt |
| [`neat-render.ts`](#neat-renderts) | compact, Claude-Code-shaped transcript rows |
| [`local-llama-autodetect.ts`](#local-llama-autodetectts) | registers a running llama-server with its real limits |
| [`litellm-auto.ts`](#litellm-autots) | registers every model of a LiteLLM gateway — [recipe](litellm-auto.md) |
| [`eval/`](#eval) | persistent Python / JavaScript kernels as a tool |
| [`skill-manage.ts`](#skill-managets) | the model writes and improves skills; `/learn`, `/skill-review` |
| [`sudo-session.ts`](#sudo-sessionts) | `/sudo` for the bash tool |
| [`tmux-stream.ts`](#tmux-streamts) | live view of `pi -p` runs in tmux |
| [`read-guard/`](#read-guard) | trims a `read` only when it would overflow the context |
| [`compaction-continue/`](#compaction-continue) | nudges pi when a turn stalls |
| [`base16-theme.ts`](#base16-themets) | base16/base24 YAML schemes as pi themes |
| [`herdr-agent-state.ts`](#herdr-agent-statets) | agent state for the herdr desktop integration |

## 00-env.ts

pi reads no env file, so switches that extensions read from `process.env` would
otherwise live in each machine's shell profile. Loads, later winning:

- `agent/pi.env` — shared, tracked, non-secret switches only
- `agent/.env` — this machine only, never tracked; secrets go here

A variable already in the environment wins — unless a parent pi exported it
(listed in `PI_ENV_FROM_FILES`), in which case it is reloaded from the files.
`KEY=value` lines, `#` comments, optional `export`, single or double quotes, no
interpolation. `/env` lists names and sources, never values.

## pi-book/

Recall at session start, capture after each run, a journal of recent sessions,
and search over pi's past sessions. Tool `memory`; commands `/remember`,
`/memory`. Everything is in [memory.md](../memory.md).

## microcall.ts

`globalThis[Symbol.for("pi.microcall")]({ system, prompt, … })` runs one
isolated pi session: no extensions, skills, AGENTS.md or tools, in memory,
thinking off. Being a real pi session, its requests carry pi's own provider
headers — so it works with OpenCode Go, which rejects raw SDK traffic. Model
chain from `model-state.json` `"micro"`. `/microcall`, `/microcall test`.
Details and API: [microcall.md](microcall.md).

## statusline.ts

A two-line footer. Line 1: model · provider · thinking level (· session name)
and the other extensions' statuses. Line 2: the real `starship prompt` for the
cwd (minus its prompt character), then context in real token counts, tokens
in/out, prompt-cache hit rate, cost and the last reply's tokens/s.

- Context warns at a percentage *or* an absolute token count, whichever comes
  first — on a 1M window a percentage alone stays quiet far too long.
- starship never runs while drawing: it refreshes in the background.
- Narrow terminals drop whole segments, lowest priority first.

`settings.json` (all optional):

```json
"statusline": {
  "hide": [],
  "contextThresholds": { "warning": [70, 150000], "error": [90, 500000] },
  "separator": " · ",
  "starship": true
}
```

`/statusline` toggles it for a session. It replaced `pi-zentui`, whose footer
needed a local patch inside `node_modules`.

## neat-render.ts

Compact transcript chrome without wrapping any tool: it patches the render
methods of pi's tool, user-message and batch components, so it works for every
tool, including those of other extensions.

- user messages in a framed card whose background fills the interior
- tool rows as call + outcome; running commands wrapped as `└ $ …`
- inline edit diffs; a pulsing bullet while a tool runs
- a bash command's leading `# comment` lines shown dimmed above the call
- thinking blocks as one opencode-style line: `● Thinking: <title>` while it
  streams, `▸ Thought: <title> · ~340 tokens` when collapsed, `▾ Thought: …` with
  the reasoning indented when open. Ctrl+T and clicks still toggle them; the
  title is a bold opening line or the first sentence
- Ctrl+O: an omp-style frame — syntax-highlighted command, `Output` divider,
  status in the bottom border

Env switches (all default on unless noted): `NEAT_RENDER=0` (off),
`NEAT_RENDER_CARD`, `NEAT_RENDER_ROWS`, `NEAT_RENDER_SPLIT`,
`NEAT_RENDER_BATCH=1` / `NEAT_RENDER_RULES=1` (restore batch headers / rules),
`NEAT_RENDER_PULSE`, `NEAT_RENDER_COMMENTS`, `NEAT_RENDER_HIGHLIGHT`,
`NEAT_RENDER_FRAME`, `NEAT_RENDER_FOLD_THINKING`, `NEAT_RENDER_THINKING`,
`NEAT_RENDER_INSET=n`.
Do not combine with other extensions that patch the same components
(`pi-tool-call-markers`, `pi-content-layout`, `pi-cc-extensions`).

## local-llama-autodetect.ts

Finds a running llama.cpp `llama-server` (`$LOCAL_LLAMA_URL`, else the
`local-model` baseUrl in `models.json`, else `localhost:8081`, then `8080`),
reads `/props` and `/v1/models`, and registers the `local-model` provider with
the server's real model id, context window, output limit, thinking levels and
image support. `/local-model` re-detects after you restart the server with
another model. Registers nothing when no server answers.

## litellm-auto.ts

Registers every chat model of a self-hosted LiteLLM-compatible gateway
(`/v1/model/info`) with its real context window, cached on disk and refreshed
in the background. The gateway URL comes from `~/.pi/secrets/litellm.url` (or
`LITELLM_BASE_URL`) and the key from `auth.json`; with neither, it does
nothing — safe on every machine. Recipe: [litellm-auto.md](litellm-auto.md).

## eval/

The `eval` tool: Python (`runner.py`, plain CPython — `python3` on PATH or
`EVAL_PYTHON`) and JavaScript (`kernel.cjs`, Node REPL semantics) in one
persistent kernel per language per session, so imports, data and functions
survive between calls. Trailing-expression values, top-level await, `!cmd` and
`%pip` in Python. A timeout or Esc interrupts the cell; a kernel that will not
stop is restarted and the result says its state is gone. `EVAL_TIMEOUT` (default
120 s). Modelled on oh-my-pi's `eval`.

## skill-manage.ts

A port of Hermes' skill machinery. The `skill_manage` tool lets the model
create, patch, edit and delete skills and their files; `/learn <topic>`
gathers sources and writes one skill; `/skill-review` codifies what the current
conversation taught (never automatic); `/skills-show`. Skills go to
`~/.pi/agent/skills/`, which is never tracked. Includes a deterministic
efficiency check for SKILL.md size and structure.

## sudo-session.ts

`/sudo` asks for the password once and wraps only the `bash` tool (read, write
and edit are untouched), keeping sudo valid with a periodic `sudo -v` until
`/sudo-off` or the session ends. Tools `request_sudo` / `revoke_sudo`; the
password stays in memory and is wiped on revoke or shutdown.

## tmux-stream.ts

In `pi -p` (no TUI) reasoning and tool calls are invisible until the run ends.
This mirrors them live into a tmux session — `tmux attach -r -t pi-stream` —
and logs them to `~/.pi/agent/stream/` (never tracked; logs hold session
content). `PI_TMUX_STREAM=0/1` forces it off/on, `PI_TMUX_SESSION` renames the
session, `PI_TMUX_MAX_RESULT` caps each tool result (default 4000 bytes).

## read-guard/

From little-coder (Apache-2.0, see its NOTICE). Trims a `read` result only when
keeping it whole would push the context past the window: the model gets the
first 30 lines plus a directive to use grep or a narrower range. Replaced
`pi-mono-context-guard`, which capped every read at 120 lines regardless.

## compaction-continue/

`@badliveware/pi-compaction-continue`, vendored (upstream unmaintained since
2026-05). When pi goes idle after a compaction, or a turn ends saying it will
continue, it sends a watchdog nudge; the agent answers through
`watchdog_answer` instead of prose. The compaction half was fixed upstream in pi
0.84.4; the stalled-turn half is still useful.

## base16-theme.ts

Put a tinted-theming or stylix scheme in `~/.pi/agent/themes/<name>.yaml` and
select `"theme": "<name>"`; this writes the pi JSON theme next to it at load
time (so it works on first launch; `/reload` regenerates). base24 schemes use
their extra colours; the accent defaults to base09 and can be set with a
top-level `accent:` line. It never overwrites a hand-written or symlinked theme.

## herdr-agent-state.ts

Installed and overwritten by herdr's integration: reports the agent's state to
the herdr desktop app over its socket when `HERDR_ENV=1`. Do not edit it; put
custom hooks beside it.
