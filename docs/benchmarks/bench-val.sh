#!/usr/bin/env bash
# bench-val.sh <run-suffix> <amb run args...> -- <providers...>
# Validation runs with no GPU: every LLM call (mem0 extraction, book capture,
# answer, judge) goes to OpenCode Go through pi sessions (pi-bridge.mjs / pi mode).
# BENCH_DIR holds the AMB clone (amb/), the Python env path file and the outputs;
# default: this script's directory.
S="${BENCH_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
cd "$S/amb" || exit 1
M=${VAL_MODEL:-opencode-go/deepseek-v4.1-flash}
export PYTHONPATH=src GEMINI_API_KEY=unused
export OMB_ANSWER_LLM=openai OMB_ANSWER_MODEL=$M OMB_JUDGE_LLM=openai OMB_JUDGE_MODEL=$M
export OPENAI_BASE_URL=http://127.0.0.1:8095/v1 OPENAI_API_KEY=local OPENAI_EXTRA_BODY='{}'
export MEM0_DIR=$S/mem0home/.mem0 MEM0_TELEMETRY=False MEM0_LLM_BASE_URL=http://127.0.0.1:8095/v1 MEM0_LLM_MODEL=$M
export BOOK_LLM="{\"mode\":\"pi\",\"model\":\"$M\",\"timeoutMs\":180000}"
PY="$(cat "$S/pyenv-mem0.path")/bin/python"
suffix=$1; shift
args=(); while [ $# -gt 0 ] && [ "$1" != "--" ]; do args+=("$1"); shift; done; shift
for m in "$@"; do
  echo "=== $m ($suffix) $(date +%T)"
  nice -n 15 "$PY" -c "from memory_bench.cli import app; app()" run --dataset locomo --split locomo10 --memory "$m" \
    --name "$m-$suffix" -o "$S/amb-out-val" "${args[@]}"
  echo "=== $m done $(date +%T) exit $?"
done
echo "ALL-DONE"
