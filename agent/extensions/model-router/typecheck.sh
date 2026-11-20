#!/usr/bin/env bash
# Strict type-check of the model-router extension against the installed pi's
# declarations (no repo-level package.json / node_modules exist on purpose).
#
#   agent/extensions/model-router/typecheck.sh
#
# Finds pi's global install from `pi` on PATH (or $PI_NODE_MODULES), and uses
# `typescript` + `@types/node` from $TSC_TOOLS (default: a cache dir it fills
# with `npm i` on first run). Nothing is written inside the repo.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -z "${PI_NODE_MODULES:-}" ]]; then
	pi_bin="$(command -v pi || true)"
	[[ -n "$pi_bin" ]] || { echo "pi is not on PATH; set PI_NODE_MODULES" >&2; exit 2; }
	pkg="$(cd "$(dirname "$(readlink -f "$pi_bin")")/../.." && pwd)" # .../@earendil-works/pi-coding-agent
	PI_NODE_MODULES="$(cd "$pkg/../.." && pwd)"
fi
[[ -f "$PI_NODE_MODULES/@earendil-works/pi-coding-agent/dist/index.d.ts" ]] ||
	{ echo "no pi-coding-agent declarations under $PI_NODE_MODULES" >&2; exit 2; }

tools="${TSC_TOOLS:-${XDG_CACHE_HOME:-$HOME/.cache}/pi-config-tsc}"
if [[ ! -x "$tools/node_modules/.bin/tsc" || ! -d "$tools/node_modules/@types/node" ]]; then
	mkdir -p "$tools"
	(cd "$tools" && { [[ -f package.json ]] || npm init -y >/dev/null; } && npm i --silent typescript@5 @types/node@24 >/dev/null)
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cat >"$tmp/tsconfig.json" <<JSON
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "noImplicitOverride": true,
    "skipLibCheck": true,
    "types": ["node"],
    "typeRoots": ["$tools/node_modules/@types"],
    "baseUrl": "$PI_NODE_MODULES",
    "paths": { "*": ["$PI_NODE_MODULES/*", "$PI_NODE_MODULES/@earendil-works/pi-coding-agent/node_modules/*", "$tools/node_modules/*"] }
  },
  "include": ["$here/*.ts"]
}
JSON
"$tools/node_modules/.bin/tsc" -p "$tmp/tsconfig.json" --pretty false
echo "model-router: typecheck OK"
