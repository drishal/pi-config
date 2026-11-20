# Router policy

Compact catalog for the configured decider (default: Command Code Jev). Dates are inclusive; timezone is Asia/Calcutta unless noted. Prefer free or high-limit models when quality is adequate. Never pick a model that is not in the candidate list.

## Plans

### OpenCode Go ($10/mo)
Shared monthly allowance across paid Go models (not per-model). Free Go models do not spend the pool.
DeepSeek 2× peak (weekdays only): 06:30–09:30 and 11:30–15:30 — avoid DeepSeek then unless nothing else fits.
GLM-5.3 promo through 2026-11-22: $500/mo on `opencode-go/glm-5.3`. After that day the Go GLM-5.3 cap is unknown — prefer `command-code/z-ai/glm-5.3-flash` ($100 GOAT) for hard debug, escalate to `command-code/zai-org/GLM-5.3` ($70) on retry.
OpenCode Go vision flags in `pi --list-models` are trustworthy. Prefer Go models when the turn has screenshots.

### Command Code GOAT ($10/mo)
Rolling caps: $20 / 5h, $50 / 7d, $100 / month — shared across paid GOAT models. Free `:free` models do not spend the cap.
`pi --list-models` often marks Command Code models as images=no even when they accept images; trust the `images:` field here. Still prefer OpenCode Go when a screenshot must be seen.
Not on GOAT (never pick even if listed in pi): Fable, Opus, and other frontier models that bill outside the plan.

## Defaults
- fallback: `opencode-go/glm-5.3-flash`
- direct: `command-code/recursive/flint-v1.0:free`
- pin-free: `command-code/recursive/flint-v1.0:free`
- pin-hard: `opencode-go/glm-5.3`
- order: `command-code/recursive/flint-v1.0:free`, `command-code/stealth/glyph-cluster:free`, `command-code/thinkingmachines/inkling-2-small:free`, `opencode-go/beam-free`, `opencode-go/longcat-2.5-free`, `opencode-go/glm-5.3-flash`, `command-code/z-ai/glm-5.3-flash`, `opencode-go/glm-5.3`, `command-code/zai-org/GLM-5.3`, `opencode-go/deepseek-v4.1-flash`, `command-code/deepseek/deepseek-v4.1-flash`, `command-code/inclusionai/ling-3.1-flash-1019`, `command-code/inclusionai/ling-3.1-flash`, `command-code/meituan/LongCat-2.0`, `opencode-go/claude-haiku-5-5`, `opencode-go/gpt-6-luna`, `opencode-go/kimi-k3.1-pro`, `command-code/moonshotai/Kimi-K3.1-Pro`, `command-code/claude-sonnet-5-5`, `command-code/tencent/hy4-flash`

## Models

### `command-code/recursive/flint-v1.0:free`
- plan: Command Code GOAT
- tier: free
- cost: $0, does not spend the $100 cap
- context: 200K
- images: no
- trains: no
- strengths: cheapest tight-loop and micro replies
- weaknesses: weak on hard debug and long context
- fit: render_loop, tests, typechecks, one-word checks, compaction / direct

### `command-code/stealth/glyph-cluster:free`
- plan: Command Code GOAT
- tier: free
- cost: $0
- context: 200K
- images: no
- trains: no
- strengths: free fallback when Flint is a poor fit
- weaknesses: uneven quality
- fit: render_loop, micro, free fallback

### `command-code/thinkingmachines/inkling-2-small:free`
- plan: Command Code GOAT
- tier: free
- cost: $0
- context: 200K
- images: no
- trains: no
- strengths: tiny free alternative
- weaknesses: small model
- fit: micro, last free option

### `opencode-go/beam-free`
- plan: OpenCode Go
- tier: free
- cost: $0, does not spend the Go pool
- context: 200K
- images: no
- trains: no
- strengths: free Go option
- weaknesses: not for hard debug
- fit: render_loop, micro

### `opencode-go/longcat-2.5-free`
- plan: OpenCode Go
- tier: free
- cost: $0; 1M-class free model
- context: 1M
- images: yes
- trains: no
- strengths: free long-context and a Go vision fallback
- weaknesses: weaker than paid flashes
- fit: long_context fallback, cheap vision, free general

### `opencode-go/glm-5.3-flash`
- plan: OpenCode Go
- tier: cheap
- cost: spends the shared Go pool; trustworthy vision
- context: 1M
- images: yes
- trains: no
- strengths: default workhorse; screenshots; long context
- weaknesses: spends the shared allowance
- fit: routine_fix, ui_review, long_context, general fallback

### `command-code/z-ai/glm-5.3-flash`
- plan: Command Code GOAT
- tier: cheap
- cost: $100/mo GOAT cap (best high-limit flash after the Go promo)
- context: 1M
- images: yes
- trains: no
- strengths: post-promo hard-debug default; high monthly cap
- weaknesses: pi may flag images=no — still vision-capable per this policy
- fit: hard_debug after 2026-11-22; routine_fix; fallback

### `opencode-go/glm-5.3`
- plan: OpenCode Go
- tier: cheap (promo)
- cost: $500/mo promo through 2026-11-22; cap unknown after that
- context: 1M
- images: no
- trains: no
- strengths: best high-limit hard-debug model during the promo
- weaknesses: text-only; do not prefer after 2026-11-22
- fit: hard_debug until 2026-11-22; architecture; pin-hard

### `command-code/zai-org/GLM-5.3`
- plan: Command Code GOAT
- tier: cheap
- cost: $70/mo GOAT cap
- context: 1M
- images: yes
- trains: no
- strengths: stronger GLM-5.3 when flash is not enough
- weaknesses: lower cap than flash ($70 vs $100)
- fit: hard_debug escalate after 2026-11-22; tough routine work

### `opencode-go/deepseek-v4.1-flash`
- plan: OpenCode Go
- tier: cheap
- cost: spends the shared Go pool; 2× during weekday peak windows
- context: 1M
- images: yes
- trains: no
- strengths: strong flash, long context, vision
- weaknesses: skip during DeepSeek 2× peak unless nothing else fits
- fit: long_context, routine_fix, ui_review — not during 06:30–09:30 or 11:30–15:30 weekdays

### `command-code/deepseek/deepseek-v4.1-flash`
- plan: Command Code GOAT
- tier: cheap
- cost: spends GOAT caps
- context: 1M
- images: yes
- trains: no
- strengths: DeepSeek on GOAT when Go is at peak or short
- weaknesses: same peak-window caution if billed 2× on this plan too — prefer non-DeepSeek first in those windows
- fit: long_context and routine fallback

### `command-code/inclusionai/ling-3.1-flash-1019`
- plan: Command Code GOAT
- tier: cheap
- cost: spends GOAT caps; 1M window
- context: 1M
- images: no
- trains: no
- strengths: capable flash fallback
- weaknesses: not first choice
- fit: routine_fix and long_context fallback

### `command-code/inclusionai/ling-3.1-flash`
- plan: Command Code GOAT
- tier: cheap
- cost: spends GOAT caps
- context: 262K
- images: no
- trains: no
- strengths: cheaper ling flash
- weaknesses: smaller window than the 1019 build
- fit: routine_fix fallback

### `command-code/meituan/LongCat-2.0`
- plan: Command Code GOAT
- tier: cheap
- cost: spends GOAT caps
- context: 1M
- images: no
- trains: no
- strengths: long context on GOAT
- weaknesses: not a first-line workhorse
- fit: long_context fallback

### `opencode-go/claude-haiku-5-5`
- plan: OpenCode Go
- tier: low
- cost: ~$15-class cap — avoid unless the user named it or nothing else remains
- context: 200K
- images: yes
- trains: no
- strengths: good small Claude, vision
- weaknesses: low cap
- fit: last-resort vision / quality

### `opencode-go/gpt-6-luna`
- plan: OpenCode Go
- tier: low
- cost: ~$15-class cap — avoid unless named or last resort
- context: 200K
- images: yes
- trains: no
- strengths: OpenAI-class fallback, vision
- weaknesses: low cap
- fit: last-resort vision / quality

### `opencode-go/kimi-k3.1-pro`
- plan: OpenCode Go
- tier: low
- cost: ~$15-class cap — avoid unless named or last resort
- context: 1M
- images: no
- trains: no
- strengths: long context when flashes are unavailable
- weaknesses: low cap
- fit: last-resort long_context

### `command-code/moonshotai/Kimi-K3.1-Pro`
- plan: Command Code GOAT
- tier: low
- cost: low cap — avoid unless named or last resort
- context: 1M
- images: no
- trains: no
- strengths: long context on GOAT
- weaknesses: low cap
- fit: last-resort long_context

### `command-code/claude-sonnet-5-5`
- plan: Command Code GOAT
- tier: low
- cost: low cap — avoid unless named or last resort
- context: 200K
- images: yes
- trains: no
- strengths: strong general model
- weaknesses: burns the cap fast
- fit: last-resort quality

### `command-code/tencent/hy4-flash`
- plan: Command Code GOAT
- tier: low
- cost: low cap — avoid unless named or last resort
- context: 256K
- images: no
- trains: no
- strengths: extra flash fallback
- weaknesses: low cap
- fit: last-resort routine

### `opencode-go/iceman-contributor-free`
- plan: OpenCode Go
- tier: never
- cost: free, but trains on data
- context: 200K
- images: no
- trains: yes
- strengths: none for this router
- weaknesses: training / contributor model — hard-refused
- fit: never (listed only so the refusal is explicit)

### `opencode-go/muse-spark-1.2-contributor`
- plan: OpenCode Go
- tier: never
- cost: trains on data
- context: 200K
- images: no
- trains: yes
- strengths: none for this router
- weaknesses: training / contributor model — hard-refused
- fit: never

### `opencode-go/muse-spark-1.3-contributor`
- plan: OpenCode Go
- tier: never
- cost: trains on data
- context: 200K
- images: no
- trains: yes
- strengths: none for this router
- weaknesses: training / contributor model — hard-refused
- fit: never

### `command-code/meta/muse-spark-1.2-contributor`
- plan: Command Code GOAT
- tier: never
- cost: trains on data
- context: 200K
- images: no
- trains: yes
- strengths: none for this router
- weaknesses: training / contributor model — hard-refused
- fit: never

### `command-code/meta/muse-spark-1.3-contributor`
- plan: Command Code GOAT
- tier: never
- cost: trains on data
- context: 200K
- images: no
- trains: yes
- strengths: none for this router
- weaknesses: training / contributor model — hard-refused
- fit: never
