#!/usr/bin/env bash
set -euo pipefail

# npm sets npm_config_prefix which conflicts with nvm — unset it first.
unset npm_config_prefix

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
	# shellcheck source=/dev/null
	. "$NVM_DIR/nvm.sh"
	if [ -f .nvmrc ] && command -v nvm &>/dev/null; then
		nvm use --silent 2>/dev/null || nvm use
	fi
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 22 ]; then
	echo "precommit requires Node.js 22+ (see .nvmrc). Current: $(node -v 2>/dev/null || echo unknown)" >&2
	echo "Run: nvm install && nvm use" >&2
	exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

exec node --experimental-strip-types build/hygiene.ts
