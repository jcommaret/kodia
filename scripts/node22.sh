#!/usr/bin/env bash
# Wrapper: activates Node 22 via nvm then runs the given command.
# npm sets npm_config_prefix which conflicts with nvm — unset it first.
unset npm_config_prefix
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
command -v nvm &>/dev/null && nvm use --silent
exec "$@"
