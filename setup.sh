#!/usr/bin/env bash
# Set up pi from this repo. ~/.pi IS the repo: config is tracked in place (see
# .gitignore — an allowlist), everything else in ~/.pi is pi's private state.
#
#   git clone <repo> ~/.pi && ~/.pi/setup.sh     a fresh machine
#   ~/.pi/setup.sh                              re-run any time; idempotent
#   ~/.pi/setup.sh --check                      report what is missing, change nothing
#
# Packages are not pinned by a lockfile: settings.json `packages[]` is the source
# of truth and step 3 runs `pi install` for each entry (pin a version in the
# entry, e.g. npm:<package>@1.2.3, when something depends on it). pi's own
# lockfile under agent/npm (written with --legacy-peer-deps) stays machine-local.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI="${PI_CODING_AGENT_DIR:-$ROOT/agent}"
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

say() { printf '%s\n' "$*"; }
ok()  { printf '  ok      %s\n' "$*"; }
act() { printf '  %s %s\n' "$([ $CHECK -eq 1 ] && echo 'MISSING' || echo "${VERB:-set}    ")" "$*"; }

say "pi setup: $ROOT"

# --- 1. prerequisites -----------------------------------------------------
for cmd in pi npm node jq git; do
	command -v "$cmd" >/dev/null || { say "  $cmd not on PATH — install it first"; exit 1; }
done
mkdir -p "$PI/npm"

# --- 2. git safeguards (per clone: git never versions its own config) -----
# The clean filter strips pi's runtime keys from settings.json on staging; the
# hook re-checks staged paths and content. See .gitattributes, .githooks/.
say "git:"
if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
	LOCAL_KEYS='del(.defaultProvider, .defaultModel, .defaultThinkingLevel, .lastChangelogVersion)'
	want_clean="jq --indent 2 '$LOCAL_KEYS'"
	for kv in "filter.pi-local-keys.clean=$want_clean" "filter.pi-local-keys.smudge=cat" \
		"filter.pi-local-keys.required=true" "core.hooksPath=.githooks"; do
		key="${kv%%=*}"; val="${kv#*=}"
		if [ "$(git -C "$ROOT" config --get "$key")" = "$val" ]; then ok "$key"; continue; fi
		act "$key"
		[ $CHECK -eq 1 ] || git -C "$ROOT" config "$key" "$val"
	done
	[ -x "$ROOT/.githooks/pre-commit" ] || { act "chmod +x .githooks/pre-commit"; [ $CHECK -eq 1 ] || chmod +x "$ROOT/.githooks/pre-commit"; }
else
	say "  $ROOT is not a git checkout — skipping filter and hook"
fi

# --- 3. packages ----------------------------------------------------------
# One `pi install` per missing/mismatched packages[] entry. pi resolves peers
# its own way (--legacy-peer-deps), so we never run npm here directly.
# Installed-but-unpinned packages are left alone: upgrading is `pi update`.
say "packages (from settings.json):"
spec_name() { local s="${1#npm:}" at=""; [ "${s:0:1}" = "@" ] && { at="@"; s="${s:1}"; }
	printf '%s%s' "$at" "${s%%@*}"; }
spec_ver()  { local s="${1#npm:}"; s="${s#@}"; [ "${s#*@}" != "$s" ] && printf '%s' "${s#*@}"; }
while IFS= read -r spec; do
	[ -n "$spec" ] || continue
	case "$spec" in npm:*) ;; *)
		[ $CHECK -eq 1 ] && { ok "$spec (non-npm, not checked)"; continue; }
		pi install "$spec" >/dev/null 2>&1 && ok "$spec" || say "  FAILED  $spec"; continue ;;
	esac
	name="$(spec_name "$spec")"; want="$(spec_ver "$spec")"
	pj="$PI/npm/node_modules/$name/package.json"
	have="$( [ -f "$pj" ] && jq -r .version "$pj")"
	if [ -n "$have" ] && { [ -z "$want" ] || [ "$have" = "$want" ]; }; then
		ok "$spec ($have)"; continue
	fi
	VERB=install act "$spec${have:+ (have $have)}"
	[ $CHECK -eq 1 ] && continue
	pi install "$spec" >/dev/null 2>&1 || { say "  FAILED  pi install $spec"; exit 1; }
done < <(jq -r '.packages[]? | if type=="string" then . else .source end' "$PI/settings.json")

# --- 3b. memory (extensions/memory-book) ----------------------------------
# Nothing to install: memory-book is plain TypeScript with no npm dependencies.
# Its embeddings come from an OpenAI-compatible endpoint (model-state.json
# "memory.embed", default llama-embed on 127.0.0.1:8090); without one, memory
# search still works on keywords alone.
EMBED_URL="$(jq -r '.memory.embed.url // "http://127.0.0.1:8090/v1"' "$PI/model-state.json" 2>/dev/null || echo "http://127.0.0.1:8090/v1")"
if [ -n "$EMBED_URL" ] && curl -s -m 3 "$EMBED_URL/models" >/dev/null 2>&1; then
	ok "memory embeddings answer at $EMBED_URL"
else
	say "  NOTE    no embedding server at ${EMBED_URL:-(disabled)}; memory search is keyword-only (SETUP.md step 8)"
fi

# --- 4. what this script cannot do ----------------------------------------
cat <<EOF

Private, per machine — never tracked (see SETUP.md):
  $PI/auth.json          pi auth login
  $PI/models.json        provider config incl. LAN IPs and keys
  $PI/models-store.json  xai oauth token store
  $PI/mcp.json           MCP servers; carries inline credentials (SETUP.md step 5)
  $PI/.env               optional per-machine env and secrets; overrides the
                         shared agent/pi.env (extensions/00-env.ts; /env lists both)
  $PI/skills/            your skills — personal, like mcp.json (SETUP.md step 7b)
  $PI/model-state.json   model pick + "micro"/"memory" sections (remember-model.ts;
                         agent/model-state_example.json shows the shape)

Before committing: git status shows only allowlisted config. settings.json is
staged through the clean filter (local model keys stripped); the pre-commit
hook refuses private paths and token-shaped strings.
EOF
