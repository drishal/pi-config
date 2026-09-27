# microcall: one-shot model calls as minimal pi sessions

`agent/extensions/microcall.ts` lets other extensions make small side calls — a
YES/NO judgement, a JSON extraction — without a hand-built HTTP client.

## Why not call the API directly

Some providers accept only a real coding agent's traffic. OpenCode Go rejects
requests without pi's `x-opencode-session` header and expects the client to be
pi itself. A microcall *is* a genuine pi `AgentSession`, so every request
carries exactly the headers the main session sends, and any provider pi can
talk to works: built-in, `models.json`, or one another extension registered.
Never spoof those headers from your own client — that is what this avoids.

## What each call gets

A fresh in-process session, built in ~12 ms:

- no extensions, skills, prompt templates or AGENTS.md — memory extensions
  cannot recurse into their own calls
- no tools unless the caller passes an allow-list
- the caller's system prompt verbatim and one user message
- in-memory session and settings: no session file, no compaction, no retries
  (the fallback chain retries instead), cache warming off
- thinking `off` unless asked for

## Model chain

The first model that answers wins; an error, timeout or empty reply moves on:

1. `request.model` — a caller's override
2. `PI_MICRO_MODEL=provider/id[,provider/id…]` — env, for one-off tests
3. `model-state.json` → `"micro": { "model": "p/id", "fallbacks": ["p/id", …] }`
4. `request.defaultModel` — the caller's own default
5. the session's current model

On the reference machine: `opencode-go/deepseek-v4.1-flash`, falling back to
`opencode-go/mimo-v2.6-flash`.

## API

Look it up at call time, so extension load order does not matter:

```ts
const micro = (globalThis as any)[Symbol.for("pi.microcall")];
const { text, model, ms, attempts } = await micro({
  system: "Reply YES or NO.",
  prompt: "…",
  label: "judge",          // shown in /microcall
  timeoutMs: 60_000,       // per attempt
  // model, defaultModel, tools, thinking, signal — all optional
});
```

Throws when every model in the chain failed; `attempts` lists one line per
model tried.

## Commands

- `/microcall` — the chain in effect and the last calls (model, ms, outcome)
- `/microcall test` — a one-word round trip through the chain

## Outside pi

memory-book's `llm.ts` builds the same kind of session from pi's installed SDK
when running as a CLI ("pi" mode), and the benchmark's `pi-bridge.mjs` exposes
it as an OpenAI-compatible endpoint for tools that only speak that API — still
real pi sessions, no header spoofing.
