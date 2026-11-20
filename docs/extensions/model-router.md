# model-router: opt-in virtual model `router/auto`

`agent/extensions/model-router/` registers a virtual model, `router/auto`, that
picks a physical OpenCode Go or Command Code model for each request from the
markdown policy in `agent/router.md`. It is **opt-in**: select it with `/model`
or `pi --model router/auto`. The extension never writes `defaultProvider` /
`defaultModel`.

## How a request is routed

1. **Hard rules** (no model call): an explicit "use flint" / `provider/id` in
   the prompt wins (except training/contributor ids, which are refused unless
   the markdown says `trains: yes, allowed`); image turns go only to
   vision-capable models (`images: yes` in the policy, or a yes in pi's
   catalog); a large transcript prefers 1M-class models.
2. **Stickiness.** Tool follow-ups (`continuation`) stay on the model that
   started the turn, so the prompt cache survives. Compaction and other
   `direct` requests go to `defaults.direct` (usually a free model).
3. **Decider.** On a new user turn, surviving candidates are sent to
   `routerModel` (see below) with the compact policy and a truncated prompt.
   The choice must be one of those candidates. A timeout, parse error, unknown
   id, or low confidence falls open to `defaults.fallback` (low confidence
   never upgrades).
4. **Retry.** A 429, quota, overload or context-overflow error walks
   `defaults.order` and does **not** wait on the decider.

Promo dates, peak windows, caps, and task fit live in the markdown — the
decider reads them. They are not hardcoded in TypeScript.

Subagents inherit `router/auto` when the parent selected it. Optional
per-type pins live under `subagentPins` in `router.json` (empty by default).
You can also pin a type in `subagents-lite.json` / agent frontmatter, which
pi-subagents-lite already supports.

## The decider (`routerModel`)

`router.json` (tracked defaults: `router_example.json`) holds mechanics,
including `routerModel`: a pi `provider/id` chosen from the model registry.

Default: `command-code/typesafe/jev`. Command Code's public `/provider/v1/models`
does not list Jev, so the official pi provider never registers it. This
extension registers a companion classifier `command-code-jev/typesafe/jev`
with `contextWindow` **32768** (from [commandcode.ai/models/jev](https://commandcode.ai/models/jev))
so it appears in the registry and in `/router model`. Classification still
POSTs to `https://api.commandcode.ai/provider/v1/systemone` with
`$CMD_API_KEY` / `$COMMAND_CODE_API_KEY` — pi's built-in System One client is
not attachable from a local extension, and `registerProvider` would replace
the whole `command-code` catalog if we tried to add Jev there.

Other values of `routerModel`:

- **Classifier** in the registry: `ctx.modelRegistry.classify` with a choice
  over the surviving candidate ids.
- **Regular chat model**: prompted with the policy + candidates and required
  to answer `{"choice":"<id>"}` (or a bare id). The id is validated against
  the candidate list; otherwise the router fails open.

`/router model` with no argument opens a picker of registry models
(classifiers and chat). With an argument, it validates that `provider/id`
exists and writes `router.json`. `/router status` shows the current decider,
its context window, and **where that window number came from**.

Window resolution:

1. The selected model's `contextWindow` in pi's registry, when present
   (including the 32768 we register for Jev).
2. Otherwise `routerContextWindow` in `router.json` (set automatically by
   `/router model`; required for any unregistered decider).
3. Otherwise **32768** for `typesafe/jev`, or the same conservative default
   for any other unregistered decider (set `routerContextWindow` explicitly
   if that is wrong).

Optional `buildRouterModel`: if set, `/build-router` switches this session to
that model before injecting the prompt. If unset, the build turn uses
whatever model is currently selected in the main thread, so you can watch and
steer it.

## Context budget (hard gate)

Before `router.md` is activated — and again when the extension loads — the
validator counts tokens of the markdown the decider will receive, plus
reserved headroom for the truncated prompt and the choice question (plus a
small slack for JSON wrapping), using a conservative 3.25 chars/token. If
that total exceeds the decider's context window, activation is refused: the
previous `router.md` is left unchanged, and the error shows the size, the
window (and its source), and how much to trim.

On load, if the file on disk is over budget or invalid, the last valid
parsed policy (`router.parsed.json`) is kept.

## Commands

- `/router` or `/router status` — policy source, decider, window + source, pin, last decision
- `/router explain` — the last decision in this process (also written to
  `agent/model-router-last.json`, which is private)
- `/router pin free|hard|provider/id` — pin this session; `/router pin auto` (or `off`) unpins
- `/router model [provider/id]` — pick or set the decider from pi's registry
- `/router validate [file]` — parse and budget-check without writing
- `/router apply [file]` — activate a staging file only if it passes
- `/router reload` — re-read `router.md` and `router.json`
- `/build-router [prompt]` — inject a regular user turn (current model, or
  `buildRouterModel`) that researches plans and writes a staging policy.
  `/build-router --print` shows the prompt without injecting.

The bash equivalent of validate/apply (the agent cannot invoke `/router`
from a shell):

```bash
node --experimental-strip-types ~/.pi/agent/extensions/model-router/cli.ts validate ~/.pi/agent/router.staging.md
node --experimental-strip-types ~/.pi/agent/extensions/model-router/cli.ts apply ~/.pi/agent/router.staging.md
```

## Configuration

| File | Role | Tracked |
|---|---|---|
| `agent/router_example.md` | example policy | yes |
| `agent/router_example.json` | default mechanics | yes |
| `agent/router.md` | active policy | **no** |
| `agent/router.json` | machine overlay (`routerModel`, window, pins, …) | **no** |
| `agent/router.parsed.json` | last valid parsed policy (load fallback) | **no** |
| `agent/router.staging.md` | `/build-router` draft | **no** |
| `agent/model-router.json` | legacy v1 overlay; still read for leftover mechanics | **no** |

A missing `router.md` is fine — the tracked example is enough to run.
`subagentPins` is an empty object by default.

Env (optional):

| Variable | Effect |
|---|---|
| `PI_ROUTER_VERBOSE=1` | print each decision to stderr (useful with `pi -p`) |

Jev reuses `CMD_API_KEY` or `COMMAND_CODE_API_KEY` (already loaded from
`.env`). Jev is not a `/model` chat entry and never drives a session.

## Tests

```bash
node --experimental-strip-types --test ~/.pi/agent/extensions/model-router/*.test.ts
```
