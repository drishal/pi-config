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
# entry, e.g. npm:pi-zentui@0.25.0, when something depends on it). pi's own
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

# --- 3b. memory storage ---------------------------------------------------
# mem0ai (behind the mem0 extension) imports some of its PEER dependencies at
# load time — better-sqlite3 for the local store, and pg, which it imports even
# though the SQLite store never uses it. pi installs with peers disabled, so
# after `pi install` memory fails with "Mem0 init failed: Cannot find package".
# Load mem0 and install whatever it reports missing (at mem0ai's declared peer
# range) until it loads, with pi's own npm flags (--legacy-peer-deps): plain
# `npm install` would also pull in every other package's peers (~370 modules).
mem0_missing() {   # first package mem0 cannot load; "" if fine; "!msg" otherwise
	(cd "$PI/npm" && node -e '
		import("mem0ai/oss")
			.then(() => { new (require("better-sqlite3"))(":memory:"); })
			.catch((e) => {
				const m = /Cannot find (?:package|module) \x27([^\x27]+)\x27/.exec(e.message);
				console.log(m ? m[1] : `!${String(e.message).split("\n")[0]}`);
			});' 2>/dev/null)
}
MEM0="$PI/npm/node_modules/mem0ai/package.json"
if [ -f "$MEM0" ]; then
	for _ in 1 2 3 4 5 6; do
		miss="$(mem0_missing)"
		[ -z "$miss" ] && { ok "mem0 dependencies load"; break; }
		case "$miss" in '!'*) say "  FAILED  mem0 does not load: ${miss#!}"; break ;; esac
		name="$(node -p "const s='$miss'; s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]")"
		range="$(node -p "require('$MEM0').peerDependencies?.['$name'] ?? 'latest'")"
		VERB=install act "$name@$range (mem0 peer)"
		[ $CHECK -eq 1 ] && break
		npm install "$name@$range" --prefix "$PI/npm" --legacy-peer-deps --no-audit --no-fund \
			</dev/null >/dev/null 2>&1 || { say "  FAILED  npm install $name@$range"; break; }
	done
	# mem0ai imports @langchain/core only once its "langchain" LLM is in use —
	# smart-capture.ts uses it to send extraction through microcall.ts — so the
	# load test above never asks for it. Same peer range, same npm flags.
	if (cd "$PI/npm" && node -e 'import("@langchain/core/messages")' >/dev/null 2>&1); then
		ok "@langchain/core (mem0 extraction via microcall)"
	else
		range="$(node -p "require('$MEM0').peerDependencies?.['@langchain/core'] ?? 'latest'")"
		VERB=install act "@langchain/core@$range (mem0 peer, lazy)"
		[ $CHECK -eq 1 ] || npm install "@langchain/core@$range" --prefix "$PI/npm" --legacy-peer-deps --no-audit --no-fund \
			</dev/null >/dev/null 2>&1 || say "  FAILED  npm install @langchain/core@$range"
	fi
	# The shared settings block names no models: remember-model.ts exports
	# them from model-state.json's "mem0" section, which only this machine has.
	for k in llm embedder; do
		jq -e --arg k "$k" '.mem0[$k] | strings | length > 0' "$PI/model-state.json" >/dev/null 2>&1 ||
			say "  NOTE    model-state.json has no mem0.$k; memory cannot run (SETUP.md step 8)"
	done
fi

# --- 4. the silent one ----------------------------------------------------
# The zentui patch lives INSIDE node_modules, which is untracked. A fresh
# install yields unpatched zentui with no error — percentages instead of real
# token counts in the footer.
say "patches:"
if [ -x "$PI/patches/apply-zentui-patch.sh" ]; then
	if [ $CHECK -eq 1 ]; then
		"$PI/patches/apply-zentui-patch.sh" --check | sed 's/^/  /'
	else
		"$PI/patches/apply-zentui-patch.sh" | sed 's/^/  /'
	fi
else
	say "  patches/apply-zentui-patch.sh missing"
fi

# --- 5. what this script cannot do ----------------------------------------
cat <<EOF

Private, per machine — never tracked (see SETUP.md):
  $PI/auth.json          pi auth login
  $PI/models.json        provider config incl. LAN IPs and keys
  $PI/models-store.json  xai oauth token store
  $PI/mcp.json           MCP servers; carries inline credentials (SETUP.md step 5)
  $PI/.env               optional per-machine env and secrets; overrides the
                         shared agent/pi.env (extensions/00-env.ts; /env lists both)
  $PI/skills/            your skills — personal, like mcp.json (SETUP.md step 7b)
  $PI/model-state.json   model pick + "mem0"/"micro" sections (remember-model.ts;
                         agent/model-state_example.json shows the shape)

Before committing: git status shows only allowlisted config. settings.json is
staged through the clean filter (local model keys stripped); the pre-commit
hook refuses private paths and token-shaped strings.
EOF
