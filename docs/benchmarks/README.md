# Memory benchmark harness

Everything used for [../memory-benchmarks.md](../memory-benchmarks.md), so the
numbers can be re-run. Nothing here is installed by `setup.sh`; Python comes
from a temporary nix env, never pip.

| File | Purpose |
|---|---|
| `amb-adapters/` | adapters and a patch for [AMB](https://github.com/vectorize-io/agent-memory-benchmark), at the commit in `AMB_COMMIT` |
| `amb-adapters/book.py` | memory-book provider (`book`, `book-kw`, `book-extract`, `book-tiered`), driving `cli.ts serve` |
| `amb-adapters/mem0_local.py` | mem0 OSS 2.x provider fed the same input as `book.py` |
| `amb-adapters/amb.patch` | registry tolerant of missing heavy providers, with the book and mem0-local providers registered; OpenAI client `extra_body` + unparseable-output fallback; LoCoMo judge without the "unanswerable → correct" clause |
| `bench.sh` | AMB runs with local qwen35 (llama-server `:8081`) as answerer and judge |
| `bench-val.sh` | the same through OpenCode Go (pi sessions via `pi-bridge.mjs`) — no GPU |
| `pi-bridge.mjs` | OpenAI-compatible `/v1/chat/completions` answered by minimal pi sessions (`pi` mode), or by a local server with memory-book's raw settings (`--raw <url> <model>`) |
| `evidence.mjs` | LLM-free LoCoMo score: share of gold evidence turns present in each run's context |
| `budget-eval.mjs` | LLM-free: evidence delivered per token budget, section vs bullet reads, all 10 conversations |
| `write-quality/` | 23 coding-session scenarios and the runner that scores capture (junk, missed facts, scope, stale facts, secrets, journal) |
| `pyenv.nix`, `pyenv-mem0.nix` | the Python envs (the second adds mem0ai 2.2.1 from its PyPI wheel) |

## Setup

```bash
export BENCH_DIR=~/bench
mkdir -p $BENCH_DIR && cp -r ~/.pi/docs/benchmarks/. $BENCH_DIR/
git clone https://github.com/vectorize-io/agent-memory-benchmark $BENCH_DIR/amb
git -C $BENCH_DIR/amb checkout "$(cat $BENCH_DIR/amb-adapters/AMB_COMMIT)"
git -C $BENCH_DIR/amb apply $BENCH_DIR/amb-adapters/amb.patch
cp $BENCH_DIR/amb-adapters/*.py $BENCH_DIR/amb/src/memory_bench/memory/
nix build --no-link --print-out-paths --impure --file $BENCH_DIR/pyenv.nix > $BENCH_DIR/pyenv.path
nix build --no-link --print-out-paths --impure --file $BENCH_DIR/pyenv-mem0.nix > $BENCH_DIR/pyenv-mem0.path
```

`BENCH_FLAKE=git+file:///path/to/your/flake` pins nixpkgs to that flake's input.

## Runs

```bash
# LoCoMo, one conversation, local qwen35 (start it first: ~/Desktop/models/files/serve qwen35 --ctx 32768)
$BENCH_DIR/bench.sh c26 --unit conv-26 -c single-hop,temporal,multi-hop,open-domain -- bm25 book book-tiered
BOOK_BUDGET=1000 $BENCH_DIR/bench.sh c26-b1k --unit conv-26 -c single-hop,temporal,multi-hop,open-domain -- book-tiered

# mem0 on local qwen35: its LLM calls go through the bridge's raw mode (thinking off, temperature 0)
node $BENCH_DIR/pi-bridge.mjs 8097 --raw http://127.0.0.1:8081/v1 qwen35 &
MEM0_LLM_BASE_URL=http://127.0.0.1:8097/v1 MEM0_LLM_MODEL=qwen35 MEM0_DIR=$BENCH_DIR/mem0home/.mem0 \
  $BENCH_DIR/bench.sh c26 --unit conv-26 -c single-hop,temporal,multi-hop,open-domain -- mem0-local
#   (bench.sh uses pyenv.path; point it at pyenv-mem0.path for mem0 runs)

# no GPU: everything through OpenCode Go
node $BENCH_DIR/pi-bridge.mjs 8095 &
$BENCH_DIR/bench-val.sh val --unit conv-26 -c single-hop,temporal,multi-hop,open-domain -q 3 -- mem0-local book-tiered

# scoring and LLM-free evaluations
node $BENCH_DIR/evidence.mjs $BENCH_DIR/amb-out/locomo/*/rag/locomo10.json
node $BENCH_DIR/budget-eval.mjs            # LIMIT=n for a quick run
cd $BENCH_DIR/write-quality && node run.mjs deepseek '{"mode":"pi","model":"opencode-go/deepseek-v4.1-flash"}' 2
```

Run long jobs in tmux, and stop llama-server and the bridge when done.

## Pitfalls found the hard way

- **LoCoMo's prompt swaps the context for the provider's raw response.** A
  provider that returns any `raw_response` sends `json.dumps(raw)` to the
  answer model instead of the retrieved text. The adapters return `None`.
- **The stock LoCoMo judge marks "no information" answers correct** — its
  clause for unanswerable questions was applied to every question by a local
  judge. The patch removes it (adversarial questions are excluded anyway).
  Always run a `vanilla` (no memory) floor: it must score ~0%.
- **Grammar-constrained JSON can run away** (30k tokens in one answer) and
  block a single-slot server. The patch caps `max_tokens` via `OPENAI_EXTRA_BODY`.
- **AMB demands `GEMINI_API_KEY`** even when no Gemini model runs; the scripts
  set a placeholder.
- **mem0 writes `~/.mem0` at import**; set `MEM0_DIR`.
