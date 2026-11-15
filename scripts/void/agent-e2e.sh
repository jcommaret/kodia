#!/usr/bin/env bash
#---------------------------------------------------------------------------------------
#  Copyright 2025 Glass Devtools, Inc. All rights reserved.
#  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
#---------------------------------------------------------------------------------------

# Runs the Kodia agent end to end in the real app, with a fake model: what the unit tests can't see (the windows,
# the model detection, the agent host, the tools on a real folder).
#
#   npm run transpile-client   # and the React UI and the extensions built, as for scripts/code.sh
#   scripts/void/agent-e2e.sh
#
# It starts scripts/void/fake-llm.mjs on LM Studio's port, opens Kodia on an empty profile and a temporary folder,
# opens the Agents window from it, and asks the agent to read a file, create another, search the project and hand a
# task to a sub-agent. It passes when the model was sent every result and the file is on disk. Not run in CI: it needs a display and the full build.
#
# KEEP=1 leaves the app and the folder for a look; PORT is the fake model's port (1234, where Kodia looks for LM Studio).

set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PORT:-1234}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/kodia-agent-e2e.XXXXXX")"
WORKSPACE="$WORK/project"
LLM_LOG="$WORK/fake-llm.log"
RUN_DIR=""
LLM_PID=""

cleanup() {
	if [ -n "${KEEP:-}" ]; then
		echo "[agent-e2e] kept: $WORK (app: ${RUN_DIR:-not started}, fake model: pid ${LLM_PID:-none})"
		return
	fi
	[ -n "$LLM_PID" ] && kill "$LLM_PID" 2>/dev/null || true
	# only the app this script launched: its processes carry its own run folder in their arguments
	[ -n "$RUN_DIR" ] && pkill -f "$RUN_DIR" 2>/dev/null || true
	sleep 2
	rm -rf "$WORK" 2>/dev/null || true
	[ -n "$RUN_DIR" ] && rm -rf "$RUN_DIR" 2>/dev/null || true
}
trap cleanup EXIT
trap 'echo "[agent-e2e] FAILED: a step stopped at line $LINENO" >&2' ERR

fail() { echo "[agent-e2e] FAILED: $1" >&2; [ -f "$LLM_LOG" ] && sed 's/^/    /' "$LLM_LOG" >&2; exit 1; }

pw() { (cd "$REPO" && npx @playwright/cli "$@" 2>/dev/null); }
# the value of a script run in the page
page() { pw eval "$1" | sed -n '/### Result/,/### /p' | grep -v '^###' || true; }

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
	echo "[agent-e2e] port $PORT is taken (LM Studio?): stop it, or the agent would talk to a real model." >&2
	trap - EXIT; rm -rf "$WORK"; exit 2
fi

mkdir -p "$WORKSPACE"
echo '{"name":"agent-e2e"}' > "$WORKSPACE/package.json"

PORT="$PORT" node "$REPO/scripts/void/fake-llm.mjs" > "$LLM_LOG" 2>&1 &
LLM_PID=$!
disown "$LLM_PID"

echo "[agent-e2e] launching Kodia..."
INFO="$("$REPO/.agents/skills/launch/scripts/launch.sh" --repo "$REPO" --disable-workspace-trust --source-user-data-dir "$WORK/no-profile" -- "$WORKSPACE" 2>"$WORK/launch.log" | tail -n1)"
RUN_DIR="$(node -p 'JSON.parse(process.argv[1]).runDir' "$INFO")"
CDP="$(node -p 'JSON.parse(process.argv[1]).cdpPort' "$INFO")"
pw attach --cdp="http://127.0.0.1:$CDP" >/dev/null

# the editor window: leave the onboarding, wait for the fake model to be found, then open the Agents window
page "(async () => {
	const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
	for (let i = 0; i < 40 && !document.querySelector('li.open-in-agents-titlebar-widget'); i++) { await wait(500); }
	[...document.querySelectorAll('button,div,span,a')].find(e => e.textContent.trim() === 'Set up later')?.click();
	for (let i = 0; i < 60 && !document.body.textContent.includes('devstral'); i++) { await wait(500); }
	document.querySelector('li.open-in-agents-titlebar-widget')?.click();
	return document.body.textContent.includes('devstral');
})()" | grep -q true || fail "the editor window did not list the fake model (devstral)"

for _ in $(seq 1 30); do
	pw tab-list | grep -q '^- 1:.*Agents' && break
	sleep 1
done
pw tab-select 1 >/dev/null || fail "the Agents window did not open"

page "(async () => {
	const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
	for (let i = 0; i < 60 && !document.body.textContent.includes('devstral'); i++) { await wait(500); }
	document.querySelector('.monaco-editor .native-edit-context, .monaco-editor textarea')?.focus();
	return document.body.textContent.includes('devstral');
})()" | grep -q true || fail "the Agents window did not offer the fake model"

echo "[agent-e2e] asking the agent to read, create, search and delegate..."
# The input may not take the first keys right after the window opens: the plan is typed again until all of it is there.
for attempt in 1 2 3; do
	pw type 'CALL read_file {"uri": "package.json"}' >/dev/null
	pw press Shift+Enter >/dev/null
	pw type 'CALL create_file_or_folder {"uri": "notes.txt"}' >/dev/null
	pw press Shift+Enter >/dev/null
	pw type 'CALL search_codebase {"query": "agent-e2e name"}' >/dev/null
	pw press Shift+Enter >/dev/null
	# the task of the sub-agent is a plan too: the fake model follows it in the sub-agent's own conversation
	pw type 'CALL run_subagent {"task": "CALL ls_dir {}"}' >/dev/null
	page "(() => { const typed = [...document.querySelectorAll('.monaco-editor .view-lines')].at(-1)?.textContent ?? ''; return ['read_file', 'create_file_or_folder', 'search_codebase', 'run_subagent'].every(tool => typed.includes('CALL' + String.fromCharCode(160) + tool) || typed.includes('CALL ' + tool)) })()" | grep -q true && break
	[ "$attempt" = 3 ] && fail "the plan could not be typed in the Agents window"
	pw press Meta+a >/dev/null
	pw press Backspace >/dev/null
done
pw press Enter >/dev/null

# an approval the window asks for is given ("Allow", once), until the model has both results
for _ in $(seq 1 60); do
	[ "$(grep -c '^\[fake-llm\] DONE' "$LLM_LOG")" -ge 2 ] && break
	page "(() => { [...document.querySelectorAll('a,button')].find(e => e.textContent.trim() === 'Allow')?.click(); return 0 })()" >/dev/null
	sleep 1
done

grep -q '^\[fake-llm\] CALL read_file' "$LLM_LOG" || fail "the model was not asked for its first tool call"
grep -q '^\[fake-llm\] CALL ls_dir' "$LLM_LOG" || fail "the sub-agent did not run its own tool call"
[ "$(grep -c '^\[fake-llm\] DONE' "$LLM_LOG")" -ge 2 ] || fail "the model was not sent the results of its tool calls, the sub-agent's report included"
[ -f "$WORKSPACE/notes.txt" ] || fail "the agent did not create notes.txt"
page "document.body.textContent.includes('DONE') && document.body.textContent.includes('agent-e2e')" | grep -q true || fail "the Agents window does not show the model's reply"

echo "[agent-e2e] passed: the agent read package.json, created notes.txt, searched the project, ran a sub-agent and showed the model's reply."
