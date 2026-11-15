#!/usr/bin/env bash
#---------------------------------------------------------------------------------------
#  Copyright 2025 Glass Devtools, Inc. All rights reserved.
#  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
#---------------------------------------------------------------------------------------

# Tries the Kodia agent in the real app with a real local model, served by LM Studio: what agent-e2e.sh can't
# tell with its fake model, which does what the prompt says. Does a small model hand a question to a sub-agent by
# itself, and is the answer right? To run by hand before a release: it needs LM Studio and a model, and takes minutes.
#
#   npm run transpile-client   # and the React UI and the extensions built, as for scripts/code.sh
#   MODEL=qwen3.5-4b-mlx scripts/void/agent-real-model.sh
#
# It loads MODEL in LM Studio, opens Kodia on a copy of the agent's own sources, and asks how many requests a
# sub-agent makes before it reports, to be handed to a sub-agent. It passes when a sub-agent ran and the agent's
# answer names the limit and its file. It ends with what the model was sent: the size of the system prompts and how
# many requests each made.
#
# LM Studio must serve on another port than 1234, where Kodia looks for it: the script listens there itself, to show
# Kodia this one model and to read the requests. LMS_PORT is LM Studio's port (read from `lms server status`),
# CONTEXT the context window the model is loaded with (16384), TIMEOUT how long the turn may take, in seconds (900).
# KEEP=1 leaves the app, the folder and the model for a look.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MODEL="${MODEL:?set MODEL to a model of LM Studio (see: lms ls)}"
CONTEXT="${CONTEXT:-16384}"
TIMEOUT="${TIMEOUT:-900}"
LMS="$(command -v lms || echo "$HOME/.lmstudio/bin/lms")"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/kodia-agent-real.XXXXXX")"
WORKSPACE="$WORK/project"
LOG="$WORK/proxy.log"
RUN_DIR=""
PROXY_PID=""
LOADED_HERE=""

cleanup() {
	if [ -n "${KEEP:-}" ]; then
		echo "[agent-real-model] kept: $WORK (app: ${RUN_DIR:-not started}, proxy: pid ${PROXY_PID:-none})"
		return
	fi
	[ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null || true
	# only the app this script launched: its processes carry its own run folder in their arguments
	[ -n "$RUN_DIR" ] && pkill -f "$RUN_DIR" 2>/dev/null || true
	# its folder goes once they are gone: a process that is still closing writes it again
	for _ in 1 2 3 4 5 6 7 8 9 10; do
		[ -n "$RUN_DIR" ] && pgrep -f "$RUN_DIR" >/dev/null 2>&1 || break
		sleep 1
	done
	[ -n "$RUN_DIR" ] && pkill -9 -f "$RUN_DIR" 2>/dev/null || true
	[ -n "$LOADED_HERE" ] && "$LMS" unload "$MODEL" >/dev/null 2>&1 || true
	sleep 1
	rm -rf "$WORK" 2>/dev/null || true
	# a helper of the app that is still closing writes its profile once more: the folder is removed until it stays so
	for _ in 1 2 3 4 5; do
		[ -n "$RUN_DIR" ] && [ -e "$RUN_DIR" ] || break
		rm -rf "$RUN_DIR" 2>/dev/null || true
		sleep 2
	done
}
trap cleanup EXIT
trap 'echo "[agent-real-model] FAILED: a step stopped at line $LINENO" >&2' ERR

summary() {
	[ -f "$LOG" ] || return 0
	echo "[agent-real-model] requests: agent $(grep -c '^\[request\] agent' "$LOG" || true), sub-agent $(grep -c '^\[request\] subagent' "$LOG" || true)"
	echo "[agent-real-model] system prompt: agent $(grep -m1 '^\[request\] agent' "$LOG" | sed 's/.*system=\([0-9]*\).*/\1/') characters, sub-agent $(grep -m1 '^\[request\] subagent' "$LOG" | sed 's/.*system=\([0-9]*\).*/\1/') characters"
}
fail() { echo "[agent-real-model] FAILED: $1" >&2; summary >&2; [ -f "$LOG" ] && tail -n 6 "$LOG" | cut -c1-400 | sed 's/^/    /' >&2; exit 1; }

pw() { (cd "$REPO" && npx @playwright/cli "$@" 2>/dev/null); }
# the value of a script run in the page
page() { pw eval "$1" | sed -n '/### Result/,/### /p' | grep -v '^###' || true; }

[ -x "$LMS" ] || { echo "[agent-real-model] LM Studio's command line (lms) is not installed." >&2; trap - EXIT; rm -rf "$WORK"; exit 2; }
"$LMS" server start >/dev/null 2>&1 || true
LMS_PORT="${LMS_PORT:-$("$LMS" server status 2>&1 | sed -n 's/.*port \([0-9][0-9]*\).*/\1/p' | head -n1)}"
[ -n "$LMS_PORT" ] || { echo "[agent-real-model] LM Studio's server is not running (lms server start)." >&2; trap - EXIT; rm -rf "$WORK"; exit 2; }
if [ "$LMS_PORT" = 1234 ] || lsof -nP -iTCP:1234 -sTCP:LISTEN >/dev/null 2>&1; then
	echo "[agent-real-model] port 1234 is taken: serve LM Studio on another port (lms server start --port 1235), and stop a fake model." >&2
	trap - EXIT; rm -rf "$WORK"; exit 2
fi

if ! "$LMS" ps 2>/dev/null | grep -q "^$MODEL "; then
	echo "[agent-real-model] loading $MODEL..."
	"$LMS" load "$MODEL" --context-length "$CONTEXT" -y >/dev/null 2>&1 || fail "LM Studio could not load $MODEL (lms ls lists its models)"
	LOADED_HERE=1
fi

# the project: the agent's own sources, with a rule the answer shows was followed
mkdir -p "$WORKSPACE"
cp "$REPO"/src/vs/platform/agentHost/node/kodia/*.ts "$WORKSPACE/"
echo 'Answer in French.' > "$WORKSPACE/AGENTS.md"
LIMIT="$(sed -n 's/^export const MAX_SUBAGENT_ROUNDS = \([0-9]*\);.*/\1/p' "$WORKSPACE/kodiaSubagent.ts")"
[ -n "$LIMIT" ] || fail "kodiaSubagent.ts no longer says how many requests a sub-agent makes: update this script's question"

PORT=1234 UPSTREAM="$LMS_PORT" ONLY="$MODEL" DUMP="$WORK" node "$REPO/scripts/void/lm-studio-proxy.mts" > "$LOG" 2>&1 &
PROXY_PID=$!
disown "$PROXY_PID"

echo "[agent-real-model] launching Kodia..."
INFO="$("$REPO/.agents/skills/launch/scripts/launch.sh" --repo "$REPO" --disable-workspace-trust --source-user-data-dir "$WORK/no-profile" -- "$WORKSPACE" 2>"$WORK/launch.log" | tail -n1)"
RUN_DIR="$(node -p 'JSON.parse(process.argv[1]).runDir' "$INFO")"
CDP="$(node -p 'JSON.parse(process.argv[1]).cdpPort' "$INFO")"
pw attach --cdp="http://127.0.0.1:$CDP" >/dev/null

# the editor window: leave the onboarding, wait for the model to be found, then open the Agents window
page "(async () => {
	const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
	for (let i = 0; i < 40 && !document.querySelector('li.open-in-agents-titlebar-widget'); i++) { await wait(500); }
	[...document.querySelectorAll('button,div,span,a')].find(e => e.textContent.trim() === 'Set up later')?.click();
	for (let i = 0; i < 60 && !document.body.textContent.includes('$MODEL'); i++) { await wait(500); }
	document.querySelector('li.open-in-agents-titlebar-widget')?.click();
	return document.body.textContent.includes('$MODEL');
})()" | grep -q true || fail "the editor window did not list $MODEL"

for _ in $(seq 1 30); do
	pw tab-list | grep -q '^- 1:.*Agents' && break
	sleep 1
done
pw tab-select 1 >/dev/null || fail "the Agents window did not open"

page "(async () => {
	const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
	for (let i = 0; i < 60 && !document.body.textContent.includes('$MODEL'); i++) { await wait(500); }
	[...document.querySelectorAll('.monaco-editor .native-edit-context')].at(-1)?.focus();
	return document.body.textContent.includes('$MODEL');
})()" | grep -q true || fail "the Agents window did not offer $MODEL"

echo "[agent-real-model] asking $MODEL a question to hand to a sub-agent (up to ${TIMEOUT}s)..."
STARTED=$SECONDS
pw type 'How many requests can a sub-agent make before it has to report, and in which file is that limit defined? Hand this research to a sub-agent.' >/dev/null
pw press Enter >/dev/null

# the agent's answer: a reply of its own, after a sub-agent ran, that names the limit and its file
answered() {
	awk '/^\[request\] subagent/ { ran = 1 } ran && /^\[reply\] agent / { print }' "$LOG" | grep "kodiaSubagent" | grep -q "$LIMIT"
}
until answered; do
	[ $((SECONDS - STARTED)) -lt "$TIMEOUT" ] || fail "no answer naming $LIMIT and kodiaSubagent.ts within ${TIMEOUT}s"
	# a sub-agent only reads, and so does this question: an approval the window still asks for is given once
	page "(() => { [...document.querySelectorAll('a,button')].find(e => e.textContent.trim() === 'Allow')?.click(); return 0 })()" >/dev/null
	sleep 5
done

summary
echo "[agent-real-model] passed in $((SECONDS - STARTED))s: $MODEL handed the question to a sub-agent and answered $LIMIT, in kodiaSubagent.ts."
