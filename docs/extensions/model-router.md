# model-router: opt-in virtual model `router/auto`

`agent/extensions/model-router/` registers a virtual model, `router/auto`, that
picks a physical OpenCode Go or Command Code model for each request from the
plan-aware table in `agent/model-router_example.json`. It is **opt-in**:
select it with `/model` or `pi --model router/auto`. The extension never
writes `defaultProvider` / `defaultModel`.

## How a request is routed

1. **Hard rules** (no model call): an explicit "use flint" / `provider/id` in
   the prompt wins (except training/contributor ids, which are refused);
   image turns go only to OpenCode Go vision models; a large transcript
   prefers 1M-class models; DeepSeek is skipped during its weekday 2× peak
   windows (06:30–09:30 and 11:30–15:30 Asia/Calcutta); $15-cap models are
   avoided when a higher-limit option exists.
2. **Stickiness.** Tool follow-ups (`continuation`) stay on the model that
   started the turn, so the prompt cache survives. Compaction and other
   `direct` requests go to a cheap/free model.
3. **Task guess.** Clear wording (tests/flicker, hard debug, typo fix, …)
   is classified locally. Unclear prompts are sent to **Jev**
   (`typesafe/jev` on Command Code's `/provider/v1/systemone`), with only the
   truncated latest user prompt. A 2.5s timeout or any error falls open to
   heuristics / `routine_fix`. Low Jev confidence does not upgrade to a
   harder (more expensive) tier.
4. **Fallback.** A 429, quota, overload or context-overflow error retries
   the next model in that task's list.

Hard debugging is one line in the config: through **2026-11-22** (inclusive,
Asia/Calcutta) the first choice is `opencode-go/glm-5.3` (Go promo). After
that it is `command-code/z-ai/glm-5.3-flash` ($100 GOAT cap), escalating to
`command-code/zai-org/GLM-5.3` ($70) on retry.

Subagents inherit `router/auto` when the parent selected it. Optional
per-type pins live under `subagentPins` in the config (empty by default).
You can also pin a type in `subagents-lite.json` / agent frontmatter, which
pi-subagents-lite already supports.

## Commands

- `/router` or `/router status` — config source, promo state, Jev readiness, pin, last decision
- `/router explain` — the last decision in this process (also written to
  `agent/model-router-last.json`, which is private)
- `/router pin free|hard|provider/id` — pin this session; `/router pin auto` (or `off`) unpins
- `/router reload` — re-read the config files

## Configuration

Tracked defaults: `agent/model-router_example.json`. Optional machine overlay:
`agent/model-router.json` (never committed). The extension merges the overlay
over the example, so a fresh clone works with no copy step. To change the
post-promo hard-debug model, edit `hardDebug.afterPromo` (and
`afterPromoEscalate`) — that is the one-line change.

Env (optional):

| Variable | Effect |
|---|---|
| `PI_ROUTER_VERBOSE=1` | print each decision to stderr (useful with `pi -p`) |
| `PI_ROUTER_FORCE_JEV=1` | skip heuristics and always ask Jev on a new user turn |

Jev reuses `CMD_API_KEY` or `COMMAND_CODE_API_KEY` (already loaded from
`.env`). The official Command Code chat provider does not expose `/systemone`,
so this extension POSTs to `https://api.commandcode.ai/provider/v1/systemone`
itself (and also registers a classifier-only `command-code-jev` catalog
entry). Jev is not a `/model` entry and never drives a session. pi's built-in
System One client is not attachable from a local extension today, which is
why the call is made directly.

## Tests

```bash
node --experimental-strip-types --test ~/.pi/agent/extensions/model-router/policy.test.ts
```
