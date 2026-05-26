#!/usr/bin/env bash

set -e

# npm sets npm_config_prefix which conflicts with nvm — unset it first.
unset npm_config_prefix
# Load nvm and switch to the Node version specified in .nvmrc
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
if command -v nvm &>/dev/null; then
	nvm use --silent
fi

ROOT=$(dirname "$(dirname "$(realpath "$0" 2>/dev/null || readlink -f "$0")")")
cd "$ROOT"

exec npm-run-all2 -lp watch-client-transpile watch-client watch-extensions watch-copilot "$@"
