#!/usr/bin/env bash
# Set up pi from this repo. ~/.pi IS the repo: config is tracked in place (see
# .gitignore — an allowlist), everything else in ~/.pi is pi's private state.
#
#   git clone <repo> ~/.pi && ~/.pi/setup.sh     a fresh machine
#   ~/.pi/setup.sh                              re-run any time; idempotent
#   ~/.pi/setup.sh --check                      report what is missing, change nothing
#   ~/.pi/setup.sh [--auth] [--agents] --export DIR
#                                               write a portable snapshot of this pi install
#                                               to DIR/pi-export-YYYYmmdd-HHMMSS.zip; unzip it
#                                               into ~/.pi on another machine and pi resumes
#                                               there. --auth includes the API keys (the zip
#                                               then logs in as you; treat it like a
#                                               password). --agents also packs ~/.agents.
#
# Settings are split: agent/settings.shared.json is the tracked, hand-picked
# part; agent/settings.json is pi's own private file, which it rewrites on every
# toggle. Step 3 merges the shared file into it (.githooks/sync-settings.mjs,
# also run by the git hooks after pull/checkout/rebase).
#
# Packages are not pinned by a lockfile: settings.shared.json `packages[]` is the
# source of truth and step 4 runs `pi install` for each entry (pin a version in the
# entry, e.g. npm:<package>@1.2.3, when something depends on it). pi's own
# lockfile under agent/npm (written with --legacy-peer-deps) stays machine-local.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI="${PI_CODING_AGENT_DIR:-$ROOT/agent}"
CHECK=0; EXPORT_DIR=""; INCLUDE_AUTH=0; INCLUDE_AGENTS=0
[ "${1:-}" = "--check" ] && { CHECK=1; shift; }
while [ $# -gt 0 ]; do
	case "$1" in
		--auth)   INCLUDE_AUTH=1 ;;   # also pack agent/auth.json, secrets/, agent/.env, agent/models-store.json
		--agents) INCLUDE_AGENTS=1 ;; # also pack ~/.agents (skills shared with other harnesses) under _agents/, restore to ~/.agents
		--export) shift; EXPORT_DIR="${1:-}"; [ -n "$EXPORT_DIR" ] || { say "error: --export needs a directory" >&2; exit 1; } ;;
		*) say "error: unknown option: $1 (see the header of this script)" >&2; exit 1 ;;
	esac
	shift
done

say() { printf '%s\n' "$*"; }
ok()  { printf '  ok      %s\n' "$*"; }
act() { printf '  %s %s\n' "$([ $CHECK -eq 1 ] && echo 'MISSING' || echo "${VERB:-set}    ")" "$*"; }


# --- portable export (--export) ------------------------------------------
# A copy of this whole ~/.pi, meant for another machine: unzip it there and
# pi picks up where this machine left off — sessions, skills, new extensions,
# memories, the npm packages, and the pi runtime itself all travel.
# Secrets do NOT, by default: --auth adds agent/auth.json, secrets/, agent/.env
# and agent/models-store.json. A zip made with --auth IS your login: treat it
# like a password, keep it on media you control, delete it after the move.
# Shallow prunes only: .git, pi's crash logs, all but the current runtime
# release, *.tmp/*.bak debris; nothing pi reads. Needs Info-ZIP (zip -y stores
# the runtime's symlinks: npm .bin shims resolve through them).
if [ -n "$EXPORT_DIR" ]; then
	[ $CHECK -eq 1 ] && { say "error: --export and --check do not combine" >&2; exit 1; }
	for c in zip git; do command -v "$c" >/dev/null || { say "error: $c is not on PATH" >&2; exit 1; }; done
	mkdir -p "$EXPORT_DIR" || exit 1
	EXPORT_DIR="$(cd "$EXPORT_DIR" && pwd)"
	STAGE="$(mktemp -d)"
	trap 'rm -rf "$STAGE"' EXIT
	say "export: collecting files (sessions, skills, extensions, memories, packages, runtime) …"
	EXC=(--exclude='/.git/'
	    --exclude='agent/*.log' --exclude='agent/themes/stylix.yaml'
	    --exclude='*.tmp' --exclude='*.bak'
	    --exclude='agent/npm/node_modules/.cache')
	cur="$(cat "$ROOT/agent/install/current-version" 2>/dev/null)"
	for d in "$ROOT"/agent/install/releases/*/; do
		[ "$(basename "$d")" = "$cur" ] || EXC+=(--exclude="agent/install/releases/$(basename "$d")")
	done
	[ $INCLUDE_AUTH -eq 0 ] && EXC+=(--exclude='agent/auth.json' --exclude='agent/.env' --exclude='agent/models-store.json' --exclude='secrets')
	rsync -a "${EXC[@]}" -- "$ROOT/" "$STAGE/pi/"
	# ~/.agents is outside ~/.pi (skills shared with other harnesses); with
	# --agents it travels in the zip as _agents/, unzip to ~/.agents.
	if [ $INCLUDE_AGENTS -eq 1 ] && [ -d "$HOME/.agents" ]; then
		mkdir -p "$STAGE/pi/_agents"
		tar -C "$HOME" --exclude='.agents/skills/*/.git' -cf - .agents | tar -C "$STAGE/pi/_agents" -xf - --strip-components=1
	fi
	mkdir -p "$STAGE/pi/secrets"
	{
		say "exported: $(date -u +%Y-%m-%dT%H:%M:%SZ)   from: $(id -un)@$(hostname) ($HOME)"
		if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
			say "repo:     $(git -C "$ROOT" remote get-url origin 2>/dev/null || echo '<no origin>') @ $(git -C "$ROOT" rev-parse --short HEAD)"
			[ -n "$(git -C "$ROOT" status --porcelain)" ] && say "          (working tree had uncommitted changes; the zip has the tree, not a commit)"
		else
			say "repo:     this ~/.pi is not a git checkout"
		fi
		if [ $INCLUDE_AUTH -eq 1 ]; then
			say "auth:     INCLUDED — this zip logs in as you (agent/auth.json, secrets/, agent/.env, models-store.json)"
		else
			say "auth:     NOT included; pi will ask for the LiteLLM key on first run (or copy agent/auth.json by hand)"
		fi
		[ $INCLUDE_AGENTS -eq 1 ] && say "agents:   ~/.agents included as _agents/ in the zip (restore to ~/.agents)"
	} > "$STAGE/pi/EXPORT-INFO.txt"
	OUT="$EXPORT_DIR/pi-export-$(date +%Y%m%d-%H%M%S).zip"
	[ -e "$OUT" ] && { say "error: $OUT already exists" >&2; exit 1; }
	(cd "$STAGE/pi" && zip -qry "$OUT" .)
	if [ $INCLUDE_AUTH -eq 1 ]; then
		say "  WARNING  $OUT contains your keys; anyone with it is logged in as you — keep it on media you control, delete when done" >&2
	fi
	ok "exported $OUT ($(du -h "$OUT" | cut -f1))"
	say "on the target machine, with pi itself already installed there:"
	say "    mkdir -p ~/.pi && unzip -q $OUT -d ~/.pi && pi"
	[ $INCLUDE_AGENTS -eq 1 ] && say "    unzip -qo $OUT '_agents/*' -d /tmp/piagents && cp -a /tmp/piagents/_agents/. ~/.agents/ && rm -rf /tmp/piagents"
	say "  (or, to try it without touching the target's own pi: unzip to ~/.config/pi/officetemp and"
	say "   start it with PI_CODING_AGENT_DIR=~/.config/pi/officetemp/agent pi)"
	exit 0
fi
say "pi setup: $ROOT"

# --- 1. prerequisites -----------------------------------------------------
for cmd in pi npm node jq git; do
	command -v "$cmd" >/dev/null || { say "  $cmd not on PATH — install it first"; exit 1; }
done
mkdir -p "$PI/npm"

# --- 2. git safeguards (per clone: git never versions its own config) -----
# The hooks re-check staged paths and content (pre-commit) and keep pi's
# settings.json merged with the shared file after pull/checkout/rebase.
say "git:"
if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
	if [ "$(git -C "$ROOT" config --get core.hooksPath)" = ".githooks" ]; then ok "core.hooksPath"; else
		act "core.hooksPath"
		[ $CHECK -eq 1 ] || git -C "$ROOT" config core.hooksPath .githooks
	fi
	for hook in "$ROOT"/.githooks/*; do
		[ -x "$hook" ] && continue
		act "chmod +x .githooks/${hook##*/}"
		[ $CHECK -eq 1 ] || chmod +x "$hook"
	done
	# The settings.json clean filter older clones defined is gone with .gitattributes.
	if git -C "$ROOT" config --get-regexp '^filter\.pi-local-keys\.' >/dev/null; then
		act "remove the old filter.pi-local-keys config"
		[ $CHECK -eq 1 ] || git -C "$ROOT" config --remove-section filter.pi-local-keys
	fi
else
	say "  $ROOT is not a git checkout — skipping hooks"
fi

# --- 3. settings: agent/settings.shared.json → pi's agent/settings.json ------
say "settings:"
if [ $CHECK -eq 1 ]; then
	node "$ROOT/.githooks/sync-settings.mjs" --check | sed 's/^/  /'
else
	node "$ROOT/.githooks/sync-settings.mjs" | sed 's/^/  /'
	ok "settings.json merged with settings.shared.json"
fi

# --- 4. packages ----------------------------------------------------------
# One `pi install` per missing/mismatched packages[] entry. pi resolves peers
# its own way (--legacy-peer-deps), so we never run npm here directly.
# Installed-but-unpinned packages are left alone: upgrading is `pi update`.
say "packages (from settings.shared.json, via settings.json):"
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

# --- 4b. memory (extensions/pi-book) ----------------------------------
# Nothing to install: pi-book is plain TypeScript with no npm dependencies.
# Its embeddings come from an OpenAI-compatible endpoint (pi-book.json
# "embedding", default llama-embed on 127.0.0.1:8090); without one, memory
# search still works on keywords alone. The endpoint and its key are resolved
# by pi-book's own loader, so this probes exactly what pi-book will call —
# with the key, since a gateway answers 401 without it. The key goes to curl
# on stdin, never on its command line.
EMBED="$(MEMORY_TS="$ROOT/agent/extensions/pi-book/memory.ts" AGENT="$PI" node --input-type=module -e '
	const { loadConfig } = await import(process.env.MEMORY_TS);
	const c = loadConfig(process.env.AGENT);
	for (const w of c.warnings ?? []) console.error(w);
	console.log([c.embed.url ?? "", c.embed.model ?? "", c.embed.apiKey ?? ""].join("\t"));' 2>/dev/null)"
IFS=$'\t' read -r EMBED_URL EMBED_MODEL EMBED_KEY <<<"$EMBED"
if [ -z "$EMBED" ]; then
	say "  NOTE    could not read pi-book's config (node too old to load .ts?); skipped the embedding check"
elif [ -z "$EMBED_URL" ]; then
	ok "memory embeddings off (pi-book.json); search is keyword-only"
elif printf 'Authorization: Bearer %s\n' "$EMBED_KEY" | curl -sf -m 5 -H @- "$EMBED_URL/models" >/dev/null 2>&1; then
	ok "memory embeddings answer: $EMBED_MODEL @ $EMBED_URL"
else
	say "  NOTE    no embedding server answers at $EMBED_URL ($EMBED_MODEL); memory search is keyword-only (SETUP.md step 8)"
fi
unset EMBED EMBED_KEY

# --- 5. what this script cannot do ----------------------------------------
cat <<EOF

Private, per machine — never tracked (see SETUP.md):
  $PI/auth.json          pi auth login
  $PI/models.json        provider config incl. LAN IPs and keys
  $PI/models-store.json  xai oauth token store
  $PI/mcp.json   MCP servers; carries inline credentials (SETUP.md step 5)
  $PI/.env               optional per-machine env and secrets; overrides the
                         shared agent/pi.env (extensions/00-env.ts; /env lists both)
  $PI/skills/            your skills — personal, like mcp.json (SETUP.md step 7b)
  $PI/settings.json      pi's own settings: toggles, model picks, plus everything
                         merged in from agent/settings.shared.json (step 3)
  $PI/pi-book.json       pi-book's models: "model", "mode" (microcall|normal), "embedding"
                         (agent/pi-book_example.json shows the shape; docs/memory.md)
  $PI/model-state.json   our extensions' model config: the "micro" chain
                         (agent/model-state_example.json shows the shape)

Before committing: git status shows only allowlisted config; the pre-commit
hook refuses private paths and token-shaped strings. Shared settings live in
agent/settings.shared.json — after \`pi install\`, share new packages with
  node .githooks/sync-settings.mjs --promote packages
EOF
