# pi-config

Configuration for the [pi](https://github.com/earendil-works/pi) coding agent,
tracked in place: `~/.pi` is this repository, and an allowlist keeps pi's
private state (sessions, tokens, keys, memory) out of it.

- **New machine**: `git clone <this repo> ~/.pi && ~/.pi/setup.sh`, then
  [SETUP.md](SETUP.md).
- **What is in here and how it works**: [docs/](docs/README.md).

Highlights: long-term memory as a private Markdown "book" with hybrid search
and budgeted reads ([docs/memory.md](docs/memory.md)); one-shot model calls
that run as minimal pi sessions, so they work with providers that only accept
pi's own traffic ([docs/extensions/microcall.md](docs/extensions/microcall.md));
a starship-backed status line and compact transcript rendering
([docs/extensions/](docs/extensions/README.md)).
