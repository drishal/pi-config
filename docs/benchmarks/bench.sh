#!/usr/bin/env bash
# bench.sh <run-suffix> <amb run args...> -- <memory providers...>
# Runs AMB once per provider with local qwen35 (llama-server :8081) as answerer and judge.
# BENCH_DIR holds the AMB clone (amb/), the Python env path file and the outputs;
# default: this script's directory.
S="${BENCH_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
cd "$S/amb" || exit 1
export PYTHONPATH=src OMB_ANSWER_LLM=openai OMB_ANSWER_MODEL=qwen35 OMB_JUDGE_LLM=openai OMB_JUDGE_MODEL=qwen35
# AMB insists on a Gemini key even when no Gemini model is used; nothing is sent to Google.
export GEMINI_API_KEY=unused
export OPENAI_BASE_URL=http://127.0.0.1:8081/v1 OPENAI_API_KEY=local
export OPENAI_EXTRA_BODY='{"chat_template_kwargs":{"enable_thinking":false},"max_tokens":1024}'
PY="$(cat "$S/pyenv.path")/bin/python"
suffix=$1; shift
args=(); while [ $# -gt 0 ] && [ "$1" != "--" ]; do args+=("$1"); shift; done; shift
for m in "$@"; do
  echo "=== $m ($suffix) $(date +%T)"
  "$PY" -c "from memory_bench.cli import app; app()" run --dataset locomo --split locomo10 --memory "$m" \
    --name "$m-$suffix" -o "$S/amb-out" "${args[@]}"
  echo "=== $m done $(date +%T) exit $?"
done
echo "ALL-DONE"
