# /build-router

You are writing (or rebuilding) the markdown policy file that the `router/auto` virtual model uses to pick a physical model for each turn. The user can watch this turn, steer you, and ask you to revise before anything is activated.

Work in the live pi-config checkout at `~/.pi` (or `$PI_CODING_AGENT_DIR`).

## What to produce

A compact, parseable `router.md`. Do **not** write `~/.pi/agent/router.md` yourself. Write a staging file, then run the validator. Activation is a hard gate: if the policy (plus reserved room for the truncated user prompt and the choice question) does not fit the **current decider model's context window**, the previous `router.md` is left unchanged.

Default staging path: `~/.pi/agent/router.staging.md`

## Research first

1. Read official plan docs (OpenCode Go, Command Code GOAT, and any other plans the user names). Prefer primary sources over memory for caps, promos, and peak windows.
2. Run `pi --list-models` for exact `provider/id` strings and context windows. Trust OpenCode Go vision flags; Command Code's `images=` flag in pi is often wrong — note that in the markdown and set `images:` from official docs / known-good policy.
3. Include only models the user can actually use (on-plan, authenticated). Do not list off-plan frontier models that would bill outside the plan.
4. Keep the file compact. The decider (often Jev at 32768 tokens; a chat model may have a much larger window) must receive the rendered policy + a reserved prompt + the choice question. Check the current window with the budget command below.

## Markdown format (required)

```markdown
# Router policy

## Plans
### Plan name ($price)
Shared-allowance / cap / peak / promo notes. Use inclusive dates and an explicit timezone (Asia/Calcutta unless the user says otherwise).

## Defaults
- fallback: `provider/id`
- direct: `provider/id`
- pin-free: `provider/id`
- pin-hard: `provider/id`
- order: `provider/id`, `provider/id`, ...

## Models

### `provider/id`
- plan: ...
- tier: free | cheap | low | never
- cost: short cap / price note
- context: 1M
- images: yes | no
- trains: no | yes | yes, allowed
- strengths: ...
- weaknesses: ...
- fit: ...
```

Rules:

- Every model heading (or `id:` field) must be the exact pi `provider/id`.
- `fallback` must be one of the listed models.
- `trains: yes` is hard-refused unless the value is `yes, allowed`.
- `images: yes` marks a vision-capable model (hard filter on image turns).
- Promo ends, peak windows, and "prefer X after date Y" belong in ## Plans and in the relevant model's cost/fit lines — the decider reads them; do not assume the TypeScript will interpret dates.
- Do not include API keys, `.env` values, or secret-shaped strings.

## Validate, then activate (mandatory)

The CLI is the activation gate. The slash command `/router apply` does the same thing if you are already in a pi session, but you cannot invoke `/router` from bash.

```bash
node --experimental-strip-types ~/.pi/agent/extensions/model-router/cli.ts budget ~/.pi/agent/router.staging.md
node --experimental-strip-types ~/.pi/agent/extensions/model-router/cli.ts validate ~/.pi/agent/router.staging.md
node --experimental-strip-types ~/.pi/agent/extensions/model-router/cli.ts apply ~/.pi/agent/router.staging.md
```

- `validate` / `budget` never write `router.md`.
- `apply` copies staging to `router.md` **only if** the file parses, the required fields are present, and the token budget fits the current decider window. On failure it prints the size, the window (and where that number came from), how much to trim, and leaves the previous `router.md` in place.
- If apply fails, trim the markdown (shorten plans and per-model prose first) and validate again. Do not force-write `router.md`.

Check `~/.pi/agent/router.json` for `routerModel` and `routerContextWindow` if you need to know which decider window is in effect. `/router status` also shows the window and its source.

## After a successful apply

Summarize for the user: which plans you encoded, the default / fallback / pin targets, the decider window (tokens used / remaining), and any models you excluded and why. Remind them `router/auto` is still opt-in (`/model router/auto`).
