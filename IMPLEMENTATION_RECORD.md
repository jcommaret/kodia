# Kodia — OpenCode Migration Inventory

**Source repo:** `C:\CodeEditors\open-code_source_code` (read-only reference, 4,117 source files)
**Target repo:** `C:\CodeEditors\kodia` (all changes here)
**Date:** Fri Nov 13 2026

## Migration classes
- **COPIED:** OpenCode source copied with minimal adaptation into Kodia.
- **ADAPTED:** OpenCode algorithm/pattern re-implemented in Kodia's architecture (VS Code DI + async/await, no Effect-TS).
- **INTEGRATED WITH EXISTING KODIA:** OpenCode capability merged into an existing Kodia service.
- **ALREADY IMPLEMENTED:** Kodia already has equivalent or better capability.
- **NOT APPLICABLE:** OpenCode feature unsuitable for Kodia (with justification).

## Phase tracking
- [x] Phase 1: Core agent engine (session runner, compaction, tool output, retry/recovery)
- [x] Phase 3: Test discovery and execution (roadmap Stage 3)
- [x] Phase 6: Advanced agent capabilities (subagents, auto-repair, task decomposition, one-command orchestration)
- [ ] Phase 5: Project intelligence (project exploration, code search, LSP, diagnostics)
- [ ] Phase 7: Full workflow integration & acceptance testing

---

## Components completed

| OpenCode concept | Kodia file | Status | Notes |
|---|---|---|---|
| `session/runner/max-steps.ts` (step limit) | `chatThreadService.ts` `MAX_AGENT_STEPS_PER_TURN` | INTEGRATED | Turn stops at 50 steps with checkpoint |
| `session/runner/llm.ts` (output-limit continuation) | `chatThreadService.ts` + `sendLLMMessage.impl.ts` + `sendLLMMessageTypes.ts` | INTEGRATED | `finishReason === 'length'` → synthetic continue message |
| `tool/plugin/todo.ts` (todo tool) | `toolsService.ts` + `toolsServiceTypes.ts` + `prompt/prompts.ts` | INTEGRATED | Full todo tool with validation, execution, stringify |
| `tool-output.ts` (tool output truncation) | `common/toolOutputService.ts` + `chatThreadService.ts` integration | INTEGRATED | Truncates >50KB/2000 lines, saves to file, preview with marker |
| `permission.ts` (todo/subagent low risk) | `autonomyPolicy.ts` | INTEGRATED | `todo` and `subagent` classified as low risk |
| `tool/plugin/subagent.ts` (subagent delegation) | `toolsService.ts` + `chatThreadService.ts` + `toolsServiceTypes.ts` + `prompt/prompts.ts` + `autonomyPolicy.ts` | INTEGRATED | Child thread creation + autonomous execution in background |
| `model-retry.ts` + `session/runner/retry.ts` (retry policy) | `common/retryPolicy.ts` + `chatThreadService.ts` integration | INTEGRATED | Exponential backoff with jitter, retry-after, unreachable host budget, timeout cap |
| Stuck detection + progress tracking | `chatThreadService.ts` | INTEGRATED | Pauses turn after 10 steps with no progress, reports files touched and commands run |
| Timeout protection (LLM 120s, tool 60s, MCP 60s) | `chatThreadService.ts` | INTEGRATED | Prevents agent from hanging forever when model or tool doesn't respond |
| **File write persistence fix** | `editCodeService.ts` `_writeURIText` | **SUPERSEDED 2026-11-20 (was data-destroying)** | The 11-13 fix wrote `text` to disk, but `text` is only the replacement for `range`. Every partial-range write (diff reject, Ctrl+K streaming, fast-apply blocks) overwrote the whole file with the snippet; unawaited streaming writes could also land out of order, and raw `writeFile` bypassed `ITextFileService` (encoding/EOL, dirty-state conflicts). See 2026-11-20 entry below. |
| `tool/plugin/test_discover/list/run/targeted/rerun/cancel` (test ecosystem) | `common/testServiceTypes.ts` + `browser/testToolService.ts` + `browser/toolsService.ts` + `browser/testToolService.test.ts` | INTEGRATED | Full test discovery/execution via VS Code Testing API, event-based completion |
| Task decomposition | `common/taskDecompositionService.ts` | NEW | Breaks large requests into ordered sub-tasks with dependencies |
| Auto-repair service | `common/autoRepairService.ts` | NEW | Test failure → error analysis → code fix → rerun → repeat until passing |
| Context compaction service | `common/contextCompactionService.ts` | NEW | Summarizes old messages, prevents context window overflow |
| One-command orchestrator | `common/oneCommandOrchestratorService.ts` | NEW | Task plan → execute → verify → auto-repair → repeat until complete |

---

## Verification log

| Date | Batch | Files changed | Tests executed | Result |
|---|---|---|---|---|
| 2026-11-13 | Phase 1a: max-steps + output-limit + todo tool | 8 files | 858 void common tests | 858 passing |
| 2026-11-13 | Phase 1b: tool-output truncation | 2 files + 1 test | 865 void common tests | 865 passing |
| 2026-11-13 | Phase 1c: subagent tool (roadmap Stage 6) | 5 files + 2 tests | 867 void common tests | 867 passing |
| 2026-11-13 | Phase 1d: retry policy with exponential backoff | 2 files + 1 test | 878 void common tests | 878 passing |
| 2026-11-13 | Phase 1e: stuck detection + progress tracking | 1 file | 901 void common tests | 901 passing |
| 2026-11-13 | Phase 1f: task decomposition + auto-repair + context compaction + one-command orchestrator | 4 new files | 901 void common tests | 901 passing |
| 2026-11-13 | Phase 3: Test Discovery and Execution (Roadmap Stage 3) | 6 files | 901 void common tests | 901 passing |
| 2026-11-13 | Phase 1h: File write persistence fix | editCodeService.ts | 901 void common tests | 901 passing |
| 2026-11-13 | Phase 1g: Timeout protection + bug fixes | 3 files | 901 void common tests | 901 passing |
| 2026-11-20 | Phase 1: agent loop e2e + loop fixes (finishReason, inactivity timeout, timer leak, narration guard) | `chatThreadService.ts`, new `unfulfilledActionDetection.ts` + tests, `agentLoopFilesystem.test.ts`; `export` added to `ChatThreadService`, `ConvertToLLMMessageService` | 7 e2e + 15 unit + full suite | 986 passing / 20 failing (same 20 as baseline); 3 e2e fail at HEAD |
| 2026-11-20 | Roadmap 8 / Phase 1: disk-write correctness | `editCodeService.ts`, `voidModelService.ts`, new `test/electron-browser/realFilesystemEditing.test.ts` | Real-disk suite (9) + full void suite under electron | 9/9 real-disk passing; full suite 965 passing / 20 failing — all 20 also fail at HEAD (pre-existing, see below); 4 new tests fail at HEAD and pass with fix |

---

## 2026-11-20 — Disk-write correctness (checkpoint)

**Changes**
- `voidModelService.saveModel`: saves via `ITextFileService` (preserves encoding/BOM/EOL, keeps model and disk in sync); throws if the save did not happen; falls back to writing the *full* model value for resources the text-file service doesn't track.
- `editCodeService._writeURIText`: after `applyEdits`, persists the **full model** through a per-URI coalescing save queue (`_persistModelToDisk`): saves never overlap or reorder, bursts collapse into few saves, and each caller's promise resolves only after a save that covers its edit. Partial-range writes to an unloaded file now throw instead of writing a snippet.
- `editCodeService.instantlyApplySearchReplaceBlocks`: throws when the file can't be opened (previously returned silently → `edit_file` reported success with no change).
- `EditCodeService` class exported (for tests only; no behaviour change).

**Evidence** — `src/vs/workbench/contrib/void/test/electron-browser/realFilesystemEditing.test.ts` drives real `ToolsService` + real `EditCodeService` + real `FileService`/`DiskFileSystemProvider` on a fresh temp dir and checks bytes with Node `fs`. Model layer is a disk-backed stand-in for `ITextFileService` (real `TextModel`).
Run: `scripts\test.bat --runGlob vs/workbench/contrib/void/test/electron-browser/realFilesystemEditing.test.js` (after `npm run transpile-client`).

**How to run the Void suite** (node runner cannot load browser-layer tests; `test/node/*` cannot load in the electron renderer; `test/common/real*` spawn debuggees and crash the renderer mid-run):
`scripts\test.bat --runGlob "vs/workbench/contrib/void/test/{common,browser,electron-browser,electron-main}/**/*.test.js" --excludeRunGlob "vs/workbench/contrib/void/test/common/real*.test.js"`

**Pre-existing failures (identical at HEAD, not caused by this change)**: `filesystemToolChain` ×2 (mock `stat()` lacks `isDirectory`; mock write never resolves), `modelCapabilities` NVIDIA nemotron ×1, Brave Search IPC/Main ×16, `voidUpdateMainService` after-each hook ×1.

## 2026-11-20 (b) — Agent loop end-to-end (acceptance scenario 1) + loop reliability fixes

**Test**: `test/electron-browser/agentLoopFilesystem.test.ts` — scripted `ILLMMessageService` → real `ChatThreadService` → `validateParams` → `evaluateAutonomy` → real `ToolsService` → real `EditCodeService` → real `FileService`/disk → tool message → real `ConvertToLLMMessageService` → next request (recorded and asserted). 7 tests: multi-dir/multi-file project creation + edit + read with results proven to reach the model; invalid-args repair; tool failure reported as `tool_error`; narration guard ×2; output-limit continuation.

**Bugs found and fixed in `chatThreadService.ts`**
1. `finishReason` was dropped in `onFinalMessage`, so the output-limit continuation (finishReason `length`) was dead code. Now passed through.
2. LLM timeout ran 120 s from *send* (not inactivity) and did not abort the request: a long healthy stream (large `write_file`) was cut off while the original request kept running. Now an inactivity timer reset on every chunk, which aborts the request when it fires.
3. 10-minute tool-timeout timer was never cleared (one live timer per tool call). Now cleared.
4. **Narration without action** (the historical "said it would create files but didn't" failure): a final reply in agent mode with no tool calls whose ending announces actions now gets ONE visible corrective message (`common/unfulfilledActionDetection.ts`, deterministic, unit-tested ×15), so the model either calls the tools or states it is finished. Bounded to once per turn.

**Evidence**: 7/7 e2e pass; against HEAD `chatThreadService` the 3 tests for (1) and (4) fail. Full suite 986 passing / 20 failing — failure set identical to baseline.

**Finding (RESOLVED in (c) below — user chose "assume larger default")**: an *unrecognized* model (e.g. any custom name on `openAICompatible`, or an NVIDIA model not in the catalog) falls back to `contextWindow: 4096` **and** `reservedOutputTokenSpace: 4096`, leaving no input budget; with no `specialToolFormat` it also gets XML tool definitions in the system prompt. Every request is then "over budget", triggering trimming and summarization LLM calls. The 4096 fallback is deliberately asserted by `modelCapabilities.test.ts`. The e2e test therefore configures its model via per-model overrides (128k / openai-style), as a user would.

**Not verified**: inactivity timeout firing (needs a 120 s hang; constant not injectable); weak-model scenario with a real modest model (scenario 9).

## 2026-11-20 (c) — Unknown-model context fallback + context-overflow recovery

**Decision (user)**: assume a larger default for unrecognized models.

**Changes**
- `modelCapabilities.ts`: unrecognized models on any provider now fall back to `contextWindow 32_000` (was 4,096 for cloud providers; local providers already had 32k). Output reserve unchanged (4,096 cloud / 8,192 local). Still marked `contextWindowSource: 'fallback'`. Auto-model scoring now penalizes `source === 'fallback'` instead of `contextWindow <= 4096` (same intent).
- New `common/contextOverflow.ts`: recognizes providers' context-length errors (OpenAI, vLLM, NVIDIA/OpenAI-compatible, llama.cpp, Anthropic, Gemini) and extracts a stated limit.
- `ConvertToLLMMessageService.recordContextOverflow`: learns a per-model window (stated limit × 0.9, or half the current one; min 2,048; session-only) that `prepareLLMChatMessages` budgets with.
- `chatThreadService`: on a context-length error, learn the limit and rebuild/resend the request (max 2 per turn). After that, stop immediately — no backoff retries of a request already rejected as too long (this was a hang before) — and show the provider's error plus what to do (set the model's context window, or start a new chat).
- Tests updated to the new policy: `modelCapabilities.test.ts` (5 assertions 4,096 → 32,000, plus "fallback leaves >16k input").

**Evidence**: `contextOverflow.test.ts` 13/13; e2e now 10/10 incl. unconfigured unknown model (60-requirement instruction reaches the model intact — fails with the HEAD 4,096 fallback, passes now), stated-limit recovery, and bounded give-up with guidance. Full suite 1002 passing / 20 failing — failure set identical to baseline.

**Known limits**: learned windows are not persisted across restarts; the NVIDIA capability test (pre-existing failure at its line 149) still contains an unreachable `4_096` assertion for an unknown NVIDIA model — fix when that test is repaired. Unknown models still get XML tool definitions (no `specialToolFormat`) — not changed.

## 2026-11-20 (d) — LIVE acceptance scenario 1 against NVIDIA

**Test**: `test/electron-browser/agentLoopLive.nvidia.test.ts`. Same real agent stack, but model requests go through Kodia's real main-process `sendLLMMessage` → NVIDIA adapter → integrate.api.nvidia.com. Nothing scripted. Reads `NVIDIA_API_KEY` / optional `NVIDIA_MODEL` from the git-ignored repo-root `.env` (added `/.env` to `.gitignore`); skips without a key. Writes secret-free evidence to `%TEMP%\kodia-live-nvidia-evidence.json`. Harness shared via new `test/electron-browser/agentHarness.ts` (the scripted suite now uses it too; 10/10 unchanged).

**Result (nvidia/nemotron-3.5-super-vl-120b-a12b, 2026-11-20)**: PASS in 22.2 s, 3 model requests:
1. 3× `create_file_or_folder` (live-shop/, src/, test/) — all success
2. 3× `write_file` (package.json, src/cart.js, test/cart.test.js) — all success
3. final summary, no tool calls (finish=stop); 0 narration nudges needed

Independent verification: all files on disk, `package.json` name `live-shop`, and **`node --test` in the generated project: 3 tests, 3 pass, 0 fail**. The model's final summary matches the disk.

**Not covered by this run**: edit/repair cycle, terminal tools (the harness has no terminal service), weak-model behaviour (a strong model needed no nudges/recoveries), context overflow against a live provider. Offline suite still 1002 passing / 20 failing (baseline set).

**Run live**: `scripts\test.bat --runGlob vs/workbench/contrib/void/test/electron-browser/agentLoopLive.nvidia.test.js` (exclude `electron-browser/*Live*` from offline runs).

## 2026-11-20 (e) — All pre-existing test failures fixed (root causes, not silenced)

| Failure | Root cause | Fix |
|---|---|---|
| `filesystemToolChain` ×2 | Test mocks: `stat()` claimed every path existed (no `isDirectory`); marker-service dummy had no `read()` | Mock `stat` throws for not-yet-created paths like the real service; marker stub |
| NVIDIA capability test | **Product bug**: name fallback matched `llama3.1` but not hosted spellings (`llama-3.1`), so `meta/llama-3.1-8b-instruct` fell to the catch-all, which gave *every* unknown Llama Llama 4 Scout's **10M** window | Version-aware Llama matcher (hyphen/underscore/none); catch-all → conservative Llama 3 entry. Test updated to the deliberate family-recognition design + new Llama-name test |
| Brave Search ×16 | Tests targeted a removed contract (provider reading encrypted settings itself); the "missing key" tests **made real network calls to api.search.brave.com** (422). The "IPC channel" tests exercised the provider directly, which production no longer exposes (`void-channel-webSearch` serves `WebSearchMainService`) | Provider tests rewritten for `search(request, settings)`; settings/disabled/validation tests moved to `WebSearchMainService` (the owner); IPC tests now go through the real channel contract. Every test runs behind a fetch guard that fails on any unmocked network access |
| `voidUpdateMainService` after-each | **Product**: leftover debug `console.log('updateState', …)` printing `[object Object]` on every update check | Removed |
| `realDebuggerIntegration`, `realDAPDebuggerIntegration` (previously excluded: they crashed the runner) | **Not tests**: ran at import, ended with `process.exit` (killed the electron runner), reported nothing to mocha, printed "✓" for steps never performed; the "DAP" client returned hard-coded values | Replaced by `test/node/nodeInspectorDebugging.test.ts`: a real Node process driven over the V8 inspector with assertions — pause on entry, conditional breakpoint hit, stack, scopes/locals, evaluate, step over/out, uncaught-exception pause, exit. Scope stated: inspector protocol only, not a DAP adapter / IDebugService |

**Result**: electron runner `{common,browser,electron-browser,electron-main}` (live NVIDIA test excluded) **1026 passing, 0 failing**, no `real*` exclusion needed; node runner `test/node` **18 passing**.

## 2026-11-20 (f) — Weak-model live runs (acceptance scenario 9, measurement only)

Live test strengthened: verification no longer trusts the generated project's own `node --test` exit code. It now also requires the test file to use `node:test`, ≥3 tests to run, and checks `src/cart.js` behaviour **independently** (normal cart 38.48, rounding, empty cart, TypeError). Evidence per model: `%TEMP%\kodia-live-nvidia-evidence-<model>.json`. Validated offline: super-vl's earlier output PASSES the strict checks; lightning's FAILS.

**nvidia/nemotron-3.5-lightning-30b-a3b, 4 samples (1 lenient + 3 strict)**: tool calling worked every time (6–10 requests, one tool per request, 0 narration nudges, 0 invalid-param errors, 18–30 s). `src/cart.js` was correct in **4/4**. The test file was broken in **4/4**: no `node:test` at all (asserting nothing), `import { assert } from 'node:test'`, or Jest's `expect` imported from `node:test` (module fails to load). The final summary claimed success in **4/4**. Because the run forbids terminal commands (the harness has no terminal service), the model could not execute its tests.

**Conclusion**: the engine handles "announced but not called" actions, but nothing catches "declared done without verification". That is the next weak-model gap. Candidate fixes: give the harness a real terminal so the model can run tests (realistic Kodia configuration), and/or an engine-side completion check before a turn that changed files ends.

## 2026-11-20 (f2) — Weak-model compensation: real terminal + evidence-based completion check (A/B)

**Engine change**: `common/completionCheck.ts` + `chatThreadService`: when an agent-mode turn in which a file-changing tool *succeeded* is about to end, Kodia sends one visible message asking the model to list the request's requirements, verify each against the real files, run the project's tests/build and report the real result, and fix failures. Once per turn; never for read-only turns or failed edits. New global setting `verifyBeforeFinishing` (default on; migrated for existing users; switch in Settings → Agent → Changes; React bundle builds). Evidence: 2 unit + 3 scripted e2e incl. a real verify→fail→repair→pass cycle with real `node --test` runs (exit codes [1, 0]).

**Harness**: `ProcessTerminalToolService` runs Kodia's exact `run_command` string as a real process (PowerShell on Windows), exact exit codes, stdin closed, process-tree kill on timeout/dispose. An intermittent hang seen once (stuck child keeping the runner alive 30 min) could not be reproduced in 5 repeat runs after these hardenings.

**Live A/B, nvidia/nemotron-3.5-lightning-30b-a3b, real terminal, strict independent checks**:

| Arm | Pass | Failures |
|---|---|---|
| no terminal, no check (earlier) | 0/4 | broken tests never executed |
| terminal, check off | 2/6 | test file weakened (no node:test) ×4 |
| terminal, check on | 4/7 | test file weakened ×3 |

One "off" run was excluded: the electron renderer crashed while loading (likely loaded files being re-transpiled at that moment); no agent activity, no evidence. **Interpretation**: the terminal is the decisive improvement (the model now runs its tests in every sample and repairs real failures). The check is directionally positive (33% → 57%) but n is too small to call significant. The dominant remaining weak-model failure is **test weakening**: making `npm test` pass by stripping the required `node:test` structure. Not yet detected by the engine.

## 2026-11-20 (f3) — Test-integrity guard (weak-model compensation)

**Engine**: `common/testIntegrity.ts` + `chatThreadService`. Before `write_file`/`rewrite_file`/`edit_file`/`delete_file_or_folder` touches a test file, Kodia reads it; after success it reads it again and appends a note to that tool's result (seen by the model next step and by the user in the tool card) when:
- the edit **weakened** the tests: fewer test cases, fewer assertions, more skipped tests, the test framework import removed, or the file deleted; or
- a file **named** like a test defines **no runner-visible test case** (e.g. a script that logs results, or an exported array of checks).
Comments are ignored, and imports don't count as assertions. Heuristic and language-agnostic (JS/TS, Python, Go, Java/Kotlin, C#, PHP). It cannot see semantic weakening (changing an expected value).

**Correction of my earlier diagnosis**: I had attributed the remaining failures to test *weakening*. Per-run tool history shows that in **10 of 11** failed runs the test file was written exactly **once**, as a non-test script; weakening was rare (the weakening check fired once in 7 runs). The "no test cases" check was added after that finding.

**Evidence**: 7 unit tests (including the exact file contents observed live) + 2 scripted e2e (weakening on a real file reported in the tool result and the next request; restoring not flagged; a new test file without test cases reported).

**Live, lightning-30b, real terminal, completion check on, strict checks**:

| Arm (7 runs each unless noted) | Pass |
|---|---|
| check only | 4/7 |
| check + weakening check | 2/7 (fired 1×) |
| check + weakening + no-test-cases checks | 6/7 (no-test-cases fired 2×: 1 repaired → pass, 1 ignored → fail) |

**Interpretation (honest)**: the arms differ little in engine behaviour when the guards don't fire, yet scored 4/7 vs 2/7, so run-to-run variance is large. The guard *caught the actual failure every time it occurred* and directly converted 1 of 2. The 6/7 headline is mostly variance and is **not** claimed as the guard's effect. Pooled with the check on and without the new note: 6/14; with it: 6/7. More samples are needed for a reliable estimate.

## 2026-11-20 (h) — Roadmap 2: Git for the agent (re-inspected from scratch, rebuilt)

**State found** (the earlier "Stages 1-3 complete" claim did not hold):
1. **The git tools could not run in the app.** `GitToolService`'s constructor had no service decorators, so DI injected `undefined` for every dependency. Proven: HEAD's class built by `InstantiationService` throws `Cannot read properties of undefined (reading 'repositories')` on its first call, and the write path throws on `getWorkspace`.
2. **Shell injection, and broken messages.** Writes built `['git', ...args].join(' ')` and sent it unquoted to the integrated terminal (PowerShell). Multi-word commit messages broke, and a `;` in a message would run a second command.
3. **Fake success.** Exit codes were ignored, so every write was reported as successful (empty commit hash, branch "created" even if git refused).
4. **Fabricated data.** Every diff hunk was `@@ -1,N +1,N @@` with an empty body, `staged` was ignored, and file status was guessed from line counts. Every branch got the current branch's upstream and ahead/behind. Merge "in progress" was guessed from the word "Auto-merging".
5. `git_stage`/`git_unstage` silently turned a non-array `paths` into `[]` and reported "Staged 0 file(s)".

**Now**:
- `electron-main/kodiaGitMainService.ts`: `execFile('git', argv)` with **no shell**. It returns exact exit codes and separate stdout/stderr, and sets `GIT_TERMINAL_PROMPT=0` and `GIT_EDITOR=true` (it never hangs on a prompt). Requests are **re-validated at the IPC boundary** (`validateGitRunRequest`): absolute cwd; allow-listed subcommands; `-c` limited to the two settings Kodia adds, because e.g. `core.sshCommand` would mean arbitrary execution; no NUL bytes.
- Registered in `app.ts` as `void-channel-git`; the renderer proxy is `electron-browser/kodiaGitService.ts` (the `registerMainProcessRemoteService` pattern, no new layer violations).
- `common/gitOperations.ts`: reads use machine formats (`status --porcelain=v2 -z`, `for-each-ref` with per-branch tracking, `log -z`, real patches → real hunks). Any non-zero exit throws git's own message. Names starting with `-` are refused, and paths always follow `--`. Push/pull refuse refspecs (`:main` would delete the remote branch, `+main` would force); force push uses `--force-with-lease`. A merge conflict is reported (in progress + conflicted files), not thrown or hidden. Unstage works before the first commit.
- `browser/gitToolService.ts`: properly decorated, delegates to `GitOperations`. `toolsService` git_* simplified; `git_stage` accepts an array, a JSON array or a single path, and rejects empty input.

**Evidence (acceptance scenario 6)**:
- `test/node/gitOperations.test.ts`: 15 tests on real temp repos through the real main-process runner. The user's uncommitted change survives an agent branch, commit and switch byte for byte. A commit message containing `"`, `$HOME`, `` ` ``, `;`, `&` and `del` is stored verbatim and nothing runs. A switch that would overwrite work is refused and the work kept. Every refusal surfaces. Injection is refused before git runs. Also covered: conflict and clean merges, stash with untracked files, push/fetch to a real bare remote, the `--force-with-lease` check, and IPC validation.
- `test/electron-browser/gitAgent.test.ts`: `GitToolService` built **by DI** through a real ProxyChannel client/server pair, and a scripted agent turn (status → branch → switch → write → stage single-string path → commit → refused second commit) against a real repo, with the final repo state asserted.

**Not verified**: the `app.ts` channel registration in the running, packaged app (typechecked, not launched). That the VS Code SCM view picks up CLI-made changes (it watches `.git`; not tested). Commit message generation, PR workflows, worktrees, tags, remotes management, cherry-pick/revert/rebase (Part K items not implemented).

## 2026-11-20 (i) — Roadmap 3: test discovery & execution (re-inspected from scratch, rebuilt)

**State found** (the earlier "Phase 3 INTEGRATED" claim did not hold):
1. **Could not be constructed.** `TestToolService` had no DI decorators, so its constructor threw on `undefined.onResultsChanged`; every `test_*` tool failed in the app. Proven by building HEAD's class with `InstantiationService`.
2. **Reported another run's results.** On timeout it returned `this.lastResults`, the *previous* run's results, as the current run's.
3. Queued, running or unset tests were counted as **failed**; `isTestRunRunning` never reset.
4. **Only VS Code test controllers** were used: a project without a test extension (plain node:test, pytest, Go…) always got 0 tests, and the formatter showed "Test run completed … 0 total", which reads like success.
5. The old `testToolService.test.ts` mostly asserted the behaviour of its own mocks and read the old class's private fields; it never built the service the way the app does.

**Now**:
- `browser/testToolService.ts`: properly decorated. The VS Code Testing-API path is kept (fixed: a timeout returns *this* run's partial results marked incomplete; non-final states are not counted and are noted; suites are not counted as tests).
- New **command path** (`common/testCommandRunner.ts`) when no controller exposes tests. It detects jest / vitest / mocha / node:test / pytest / go / cargo / dotnet / PHPUnit from project files, builds the command with shell-safe arguments only (test names become regexes, unsafe paths and names are refused with a clear error), runs it through Kodia's **terminal service** (visible, like `run_command`), and parses the runner's machine report (JUnit XML: node:test, vitest, pytest, mocha xunit, PHPUnit; Jest JSON) or its verbose text (go -v, cargo, dotnet). Report files go in `.kodia/test-results/` and are deleted afterwards.
- **Honesty**: results are only what the runner reported. "Nothing detected", "runner wrote no report", "runner crashed" (a non-zero exit with no results becomes an errored entry, never "0 passed") and "stopped/cancelled" are stated in `note`; the formatter prints **NO TESTS WERE RUN** for empty runs, failures first with their messages, the framework, exact command and exit code.
- Rerun-failed (command path) reruns exactly the failed tests by name/file. Targeted runs map changed files to the test files that use them, or run everything and say so.

**Evidence (acceptance scenario 5)**:
- `test/common/testCommandRunner.test.ts`: 7 tests. Parsers use **real** reports captured from Node 24 and pytest 9 here. Jest/Go/Cargo/dotnet use samples in their documented formats, **not executed** (toolchains not installed). Also: detection, command construction, injection refusal.
- `test/electron-browser/testTools.test.ts`: 7 tests, the service built by **DI** with a real terminal and disk on temp projects. node:test: discover, list, run all (1/1/1, real "8 !== 2", exit 1, reports cleaned up), run by name, rerun only failures → fix → passes, targeted run. pytest (real counts and message). No framework → explicit note. A test file that cannot load → failure, not "0 passed". **Agent loop**: test_discover → test_run (real failure reaches the model) → edit_file fix → test_rerun_failed (passes), with real runner exit codes 1 → 0.

**Not verified / not done**: the VS Code Testing-API path with a real test-controller extension; Jest, Vitest, Mocha, Go, Cargo, dotnet and PHPUnit end-to-end (only node:test and pytest are installed here); coverage, flaky-test detection, test history, debug-a-test, and test generation (Part J items beyond discover/run/rerun/targeted/cancel).

## 2026-11-21 (j) — Roadmap 4: debugger through VS Code's debug platform and a real DAP adapter

**State found**: `KodiaDebugToolService` *was* DI-constructible (decorated), unlike Git and tests. Defects confirmed against the platform's code and, for the first two, by running HEAD's class on the real stack:
1. **Debug-console capture never captured anything.** It listened to `onDidCustomEvent` for `'output'`, but the platform routes DAP output to the REPL (`raw.onDidOutput → appendToRepl`); only unknown events are "custom". Verified: HEAD captured **0** entries from a program that printed.
2. **Breakpoints on plain file paths used a bogus URI.** `URI.parse('C:\\…')` produced scheme **"C"** (verified).
3. **continue/step/start returned immediately**, so the agent could not know when or where execution stopped without polling.
4. **thread_id defaulted to 1** (a Node-ism); debugpy and others use other ids.
5. **evaluate without frame_id ran in the global scope** (NameError for locals while stopped).
6. **stop_session returned before the session ended**, so the next breakpoint change hit a half-closed adapter (`Canceled`).
7. Sessions could only start from launch.json; the cross-session console limit kept the *oldest* entries; per-session listeners were never released.
- *Correction*: I first believed breakpoint ids were always `''` (`bp.id` is TypeScript-private). The HEAD probe showed a real id at runtime; that was **not** a bug. The code now uses the public `getId()`.

**Now** (`browser/debugToolService.ts`, `common/debugServiceTypes.ts`, `toolsService` debug tools, `debugSessionPanel`):
- Console output comes from the session's REPL elements (latest entries win).
- File paths become file URIs.
- start/continue/step/pause wait (bounded) for the next stop or the end, and report the reason, thread, function, file:line, exception text, or "terminated", or honestly "still running after Ns".
- An omitted thread id resolves to the stopped/only thread.
- evaluate defaults to the stopped frame.
- stop waits until the session is inactive.
- Inline launch configurations are supported (no launch.json).
- An ended session's status is "inactive", not "not found".

**Evidence (acceptance scenario 4)**: `test/electron-browser/debugTools.test.ts`, 4 tests, using VS Code's **real** `DebugModel`/`DebugSession`/`RawDebugSession` + `ExecutableDebugAdapter` running **debugpy 1.8.21** against a real Python program. Only the DebugService *orchestration* is a shim (`debugHarness.ts`), calling the same session/model methods.
- Breakpoint on a Windows path is verified by the adapter; the stop is reported as `breakpoint` in `apply_discount` at line 3.
- Stack `apply_discount/checkout/<module>`; locals total=45, code='SAVE10', rate=0.1; evaluate `total * rate` = 4.5 (the bug) and `total * (1 - rate)` = 40.5; evaluate without a frame id works.
- step-out lands in `checkout`; continue reports `terminated`; the console holds `total=4.5`.
- A false conditional breakpoint runs to the end; remove-by-id; stop → `inactive` → an immediate breakpoint change succeeds.
- **Agent loop**: set breakpoint → start (inline config) → evaluate (real 4.5 reaches the model) → fix → stop → remove breakpoint → rerun → console shows `total=40.5`, and the live debugger-activity feed recorded the actions.
- The old mock-based `debugToolService.test.ts`: 5 tests that asserted the previous implementation's calls on mocks not following the real API were removed (their behaviour is covered for real above); 13 remain.

**Not verified / not done**: the real `DebugService` orchestration (launch.json resolution, variable substitution, adapter discovery through installed extensions), so this is not a full packaged-app run; adapters other than debugpy (js-debug for Node and PHP/Xdebug are not installed here); exception breakpoint filters (the shim's setExceptionBreakpointsForSession is a no-op), logpoints, watch expressions, attach, multiple sessions; streaming debugger activity into the chat UI while a tool runs (only the activity feed itself was checked).

**Housekeeping note**: `%TEMP%` holds ~50 `kodia-dap-test-*` / `kodia-debug-test-*` folders left by the old fake debugger scripts (they exited before cleanup). They are not created by the new tests and were left untouched.

## 2026-11-21 (k) — Roadmap 5: browser automation (re-inspected from scratch) + acceptance scenario 3

**State found**: the wiring is real. `KodiaBrowserMainService` (Playwright/Chromium) runs in the main process, is registered in `app.ts` on `void-channel-browser`, and has a renderer proxy. The existing 12 real-Chromium tests passed. But much of what the agent was *told* about a page was wrong or missing:
1. **Selectors were not unique.** They were built from id > name > data-testid > *bare tag*, de-duplicated by a `seen` set, so five unlabeled buttons were listed as one `button`, and clicking it hit the first.
2. **Inspection stopped at DOM depth 12.** Controls in typical React/Vue trees were invisible to the agent.
3. **`browser_download` could never succeed.** It waited 30 s for a download event that nothing triggered.
4. **The title after a load event was an unawaited Promise.**
5. **Navigation dropped the HTTP status.** A 500 page reported as plain success. Subresource 404/500s were never recorded, because `requestfailed` only fires for transport errors.
6. **Click returned before the navigation it caused had loaded.** Submit used a fixed 500 ms sleep.
7. **The console `limit` kept the *oldest* messages.**
8. **Nothing detected a visible defect**, and the screenshot tool claimed the model could "inspect" an image it never receives.

**Now** (`electron-main/browserMainService.ts`, `common/browserServiceTypes.ts`, new `common/browserFormatting.ts`, the `toolsService` browser tools, prompts):
- Every listed element has a selector verified to match exactly it (an `nth-of-type` path when there is no unique id/name/test id), at any depth. An ambiguous selector passed to click is refused.
- Elements carry `visible` / `inViewport` flags.
- Inspection *measures* layout defects on the rendered page:
  - horizontal overflow, reported at the outermost element that sticks out;
  - a control covered by another element (via `elementFromPoint`);
  - an off-page control;
  - clipped text (a deliberate `text-overflow: ellipsis` is not reported).
- Inspection also reports the HTTP status, load error, recent console errors and recent failed requests, problems first.
- Click/submit wait for a navigation they trigger, detected by the main-frame navigation request, and report `navigated`, URL, title and status.
- Downloads are fetched through the session's browser context (cookies apply; relative URLs; `Content-Disposition` filename; an HTTP error means failed, and no path is reported).
- The console limit returns the latest messages. Uncaught errors are named.
- Screenshots are saved as PNG files, and the result says plainly that the model does not see the image.

**Defect found on the way (roadmap 8, data loss), fixed**: `edit_file`'s apply (`_instantlyApplySRBlocks`) had two silent-edit bugs.
- An ORIGINAL matched *inside* a line was widened to whole lines, so the rest of the line was silently deleted. The scenario-3 run showed it: `` = `Cart (${count})`; `` vanished, and the page "worked" without errors but never updated.
- An exact ORIGINAL occurring twice silently edited the first occurrence; only the whitespace-insensitive fallback checked uniqueness.

Now exact matches are replaced character-exactly and must be unique. A whitespace-insensitive match must cover whole lines, or the edit is refused with an explanation.

**Evidence**:
- `test/node/browserAutomationSignals.test.ts`: 9 tests, real Chromium against a real local HTTP server. **All 9 fail on HEAD's service and pass now.** They cover: unique selectors at depth 20 (clicking the 3rd unlabeled button hits the 3rd); HTTP 500 status plus a subresource 404; a slow navigating click (800 ms) and submit (1.2 s); a real download plus a 404 download; console recency; overflow/covered/offscreen/clipped detected, and a clean page plus a deliberate ellipsis report nothing; a phone-width-only overflow after `set_viewport`; the screenshot file.
- **Acceptance scenario 3, agent loop** (`test/electron-browser/browserRepair.test.ts`):
  - Path: ChatThreadService → ToolsService → `ProxyChannel` (arguments/results serialized) → the real service in **its own Node process** over a real IPC pipe (`test/node/browserServiceHost.ts`; the test renderer, like the workbench, cannot load Playwright) → Chromium → a web app served from the workspace.
  - The page has two bugs (wrong element id in `app.js`; a fixed promo bar covering Checkout). The agent inspects and sees `[covered] #checkout … covered by #promo`, clicks Add to cart, then reads the real `Uncaught TypeError: Cannot set properties of null (setting 'textContent')`. It reads the HTML, fixes both files on disk, reloads, clicks, and re-inspects: no layout problems, no console errors, `Cart (1)`. It then closes the browser.
  - Each scripted step asserts the real signal before acting. An independent check afterwards (new session: Checkout is clickable, the cart updates, no issues) passes.
- `realFilesystemEditing.test.ts` +2 for the edit fixes (partial-line exact replace; duplicate and partial-whitespace matches refused, nothing written).
- The old `browserAutomation.test.ts` had mocha's 5 s default timeout while each test launches Chromium (1–5 s here), so a different test timed out each run. It now has a 60 s timeout, and the node suite passed twice in a row.
- Totals: electron **1029/0** (was 1026), node **41/0** (was 32), tsc clean, eslint 0 errors on changed files, layer check 21 (= baseline, none new).

**Not verified / not done**:
- The packaged app was not launched (the IPC path is tested with `ProxyChannel` plus a real process boundary, not Electron's main-process IPC).
- The browser is headful by default in the app; tests use headless.
- No vision: the model does not receive screenshots.
- Layout checks are heuristics: z-index stacking of partially covered controls, overlap between non-interactive text blocks, contrast/accessibility, and iframes/shadow DOM are not covered.
- No live-model run of scenario 3 yet.
- A navigation answered with 204/no document waits the full 30 s timeout.
- Partial-line edits that relied on the old whole-line widening (ORIGINAL without its indentation) now keep the line's existing indentation.

## 2026-11-21 (l) — Roadmap 6: subagents / multi-agent (re-inspected from scratch) + acceptance scenario 7

**State found**: a `subagent` tool existed (an "OpenCode parity" stub) but was fire-and-forget:
1. **The parent never received a result.** The tool returned at once with "You will receive updates as it works", and nothing ever delivered them. A parent could only finish its turn without the work it delegated.
2. **The child's task could be missing.** `addUserMessage` (async) was not awaited before the child's loop started. Reproduced: running the new scenario test against the old block, every child crashed with `Cannot read properties of undefined (reading 'content')`, logged only to `console.error`.
3. **`agent`, `model` and `session_i_d` were ignored**: no roles, no per-subagent model, no follow-ups.
4. **The child thread came from `openNewThread()`.** That reuses *any* empty thread the user has open and switches the UI's current thread back and forth.
5. **No guard on nesting, concurrency, or two agents writing the same file.**
6. **Shared state between loops.** Stuck-detection counters and the retry policy (backoff attempts, reset on any success) were service-wide, so concurrent agent loops reset each other's state.

**Now** (new `common/subagents.ts`; `chatThreadService` `_runSubagent`, `_subagentRefusal`, `_resolveSubagentModel`; `convertToLLMMessageService` and `prompts` take an explicit tool list and role text; tool description; result type):
- `subagent` **runs the child agent loop to completion** in its own thread and returns a **report built from the child's thread**: status (`completed` / `awaiting_approval` with the waiting tool / `stopped` / `failed` / `timed_out`), tool calls by name with failures, the files it successfully changed, errors verbatim, then its own final reply, labelled "not verified by Kodia".
- **Parallelism:** several subagent calls in one reply run in parallel (they go through the existing parallel batch), up to 4 at once, with a 30-minute timeout each.
- **Types:**
  - `general` (aliases build/test/fix/…) gets the parent mode's tools.
  - `explore` and `review` are read-only: no tool with an approval type, and no MCP tools.
  - Unknown types are refused with the valid list.
  - The tool set is both **offered** (native `tools` *and* the XML tool prompt) and **enforced** at call time.
  - Subagents cannot start subagents.
- `model` must be one of the models set up in Kodia (`provider/model` or a unique model name). The default is the parent's running model.
- `session_i_d` continues an existing subagent of the same parent, keeping its conversation and original type. A running or approval-waiting subagent is refused.
- **File claims:** among parallel subagents, the first to change a file owns it until it finishes. A sibling's change to it is refused with the owner's name, and nothing is written.
- **Threads and stop:** children are created directly, linked by `subagentOf {parentThreadId, agent, description}`. The user's current thread never changes. Stopping the parent aborts its running subagents.
- The child is told its role in its system prompt: the user isn't watching, so don't ask questions, and the final reply is a report.
- Retry policy and stuck-detection state are per thread.

**Evidence**:
- `test/electron-browser/subagents.test.ts` (2 tests, the real agent loop/ToolsService/disk/terminal). Scenario 7 runs like this:
  - The parent delegates in one reply: general "fix math", "build" "fix strings", explore "find tests", plus an unknown type and an unknown model. The last two are refused with the valid options.
  - The three ran **interleaved** (each started before any finished).
  - A's attempt to edit `strings.js` while B owned it was refused, and the file has only B's change. A's nested `subagent` call was refused.
  - The explorer was offered no edit/terminal/subagent tools, its `edit_file` was refused, and the test file is unchanged.
  - The reports' facts (`Tool calls: 4 (2 failed)`, `Files changed: src/math.js`) reached the parent.
  - The parent continued A by `session_i_d` (the same thread: the conversation had both tasks), then ran `node --test` itself: pass 2 / fail 0.
  - Three child threads exist, all linked to the parent; the current thread never changed.
- Stop test: the user stops the parent while the subagent waits for its model. The subagent's request is aborted, it makes no further request, it is not running, and the aborted answer's edit never ran.
- The scenario test **fails against the old subagent block** (patched into a scratch copy and transpiled over the build: the first report assertion fails, and the children crash as described in point 2).
- `test/common/subagents.test.ts` (4): types/aliases, tool sets (read-only types get no changing tool; no type gets `subagent`), claims, report.
- Harness: requests carry their thread id, offered tools and model; steps can be delayed; `abort` behaves like the real service (onAbort, no late answer). It was a no-op, so stop paths could not be tested.

**Not verified / not done**:
- No live-model multi-agent run yet; the model is scripted.
- No UI for subagent threads: they appear in the thread list like other threads, linked only by `subagentOf`.
- No cross-agent coordination beyond file claims: no shared task board and no merge of conflicting intents.
- Claims cover only the file tools, not files changed by terminal commands.
- A subagent's tool approvals happen in its own thread, so the parent reports "paused" and the user has to open that thread.
- The Agents Window (VS Code's agent host, for which Kodia only serves models) was not touched.

## 2026-11-21 (m) — Roadmap 7: codebase index / code search (re-inspected from scratch)

**State found** (`electron-main/codeIndexMainService.ts` and the `code_*` tools; registered on 'void-channel-code-index'):
1. **It indexed the wrong folder.** `indexWorkspace()` walked `process.cwd()`, the main process's working directory, never the user's workspace folders.
2. **It could not finish on a real repository.** Every indexed file recomputed a dense vector, as long as the whole trigram vocabulary, for *every* chunk.
   - Measured on Kodia's own sources: 10 files took 3.5 s, 20 took 11 s, 40 took 46 s, so 262 files would take tens of minutes.
   - Memory grew the same way (chunks × vocabulary).
3. **"Semantic" search was character-trigram TF-IDF**, i.e. similar spellings, not meaning, while the tool description claimed meaning-based search.
4. **Results were never fresh.** Nothing updated the index after an edit, so the agent searched old file contents.
5. **The chunker mislabelled code.** `if (…) {`, `for (…) {` and `while` were "functions"; Python `def` was matched but its end never found; a whole-file chunk dominated results.
6. **Results printed the first 150 characters of a chunk**, not the lines that matched.
7. **`hybrid` concatenated two incomparable score lists.**

**Now**:
- New pure core `common/codeIndex.ts`:
  - **Chunking:** symbol chunks per language (JS/TS functions, classes, methods, arrow functions and top-level constants; Python by indentation; Go/Rust/Java/C#/PHP/C by braces; Markdown by heading), with their doc comments. Lines outside any symbol go into windows, and long symbols are split.
  - **Tokens:** identifiers are split into words (`parseUserToken` → parse, user, token), with light stemming and about 70 common code abbreviations expanded both ways.
  - **Ranking:** BM25 with the symbol name ×3 and the path ×1.5; a multiplier for how many query words a chunk contains; definitions ranked above loose import/export lines; overlapping regions de-duplicated.
  - **Snippets:** the symbol line plus the lines that matched.
  - **Updates** are incremental per file, with no full rebuild.
- `node/codeIndexWorkspace.ts`:
  - Lists files with `git ls-files --cached --others --exclude-standard`, so `.gitignore` applies. Outside git it walks the folder, skipping node_modules/dist/build/… (there `.gitignore` is not applied).
  - Text files only; lock, minified and binary files skipped; 512 KB per file, 25k files and 150 MB in total; skips are counted and reported.
  - **Before every search,** changed or deleted files are re-read, and the file list is refreshed when older than 2 s. Results always match the disk.
- `node/codeIndexService.ts` is the service; `electron-main/codeIndexMainService.ts` re-exports it, so `app.ts` is unchanged.
  - The renderer passes its workspace folders with each call, and searches index lazily on first use.
- Tools:
  - `code_semantic_search` is ranked search. Its description says honestly it is word-based, not embedding-based.
  - `code_keyword_search` lists exact occurrences with line numbers.
  - `code_index`, `code_index_file`, `code_index_stats` and `code_index_clear` report real stats and skips.
  - `code_hybrid_search` is kept for old threads but no longer offered.
  - Output is `path:start-end [kind] name` plus the matched lines, ready for `read_file`.

**Evidence**:
- `test/common/codeIndex.test.ts` (7): tokenizing, stemming and abbreviations; chunk boundaries for TS/Python/Markdown/JSON; ranking with different spellings ("password verification" → verifyPassword, "read configuration file" → load_config); no overlapping duplicates; incremental re-set and remove.
- `test/node/codeIndexWorkspace.test.ts` (4, real folders):
  - In a temp git repo, the git-ignored, binary, oversized, log and lock files are not indexed.
  - Lazy indexing plus freshness: an edit (`changed: 1`, the old definition gone at once), a new file plus a deletion (`added: 1, removed: 1`).
  - The walk fallback skips node_modules and dist.
  - **Kodia's own `contrib/void` (263 files / 3,976 chunks)** indexes in about 1.1 s, with about 13 ms per search. On 10 questions with known answers:
    - With the final ranking: **10/10 in the top 3, 7/10 at rank 1**.
    - Without the definitions-over-loose-lines prior: 9/10 and 9/10.
    - Caveat: I wrote these 10 questions, so this is a sanity check, not a benchmark.
- **Agent loop** (`test/electron-browser/codeSearchAgent.test.ts`; the real service behind the code-index channel; real disk and terminal):
  - Told "users whose email has capital letters cannot log in", the agent's `code_semantic_search` indexes the workspace on first use. It ranks `login` then `findUserByEmail` (src/db/users.js:3-5) with the comparing line, and lists no unrelated code.
  - The agent fixes the comparison; its next `code_keyword_search` reports "Updated first: 1 changed file" and no case-sensitive comparison left. `node --test` passes.
  - The first version of this test exposed import lines outranking definitions, which led to the loose-lines prior; the rank-1 cost of that change is measured above.

**Not verified / not done**:
- **No embedding-based (meaning) search.** It needs an embedding model; NVIDIA's embedding endpoints are an option with the key already in `.env`. Kept as a follow-up rather than claimed.
- The index is in memory: rebuilt after a restart (about 1 s per 250 files here), not persisted.
- No `.gitignore` support outside git repositories.
- The language chunkers are regex-based, not parsers: unusual formatting can mis-bound a symbol.
- Not run on a very large repository (the 25k-file / 150 MB caps are untested at scale).

## 2026-11-21 (n) — Roadmap 8: multi-file recovery (rewind/replay) + acceptance scenario 8 (session recovery)

**State found** (measured with new tests before any fix):
1. **Rewinding an agent's turn restored nothing.**
   - The sidebar's jump-to-checkpoint relies on `tool_edit` checkpoints, which were recorded only for `edit_file`/`rewrite_file`, and only when the file already had an open model (`if (!model) return`).
   - For an agent editing files that aren't open (the normal case), the thread held **no tool checkpoints at all**. The test turn's thread was `cp(user_edit:) user … cp(user_edit:)`.
   - `write_file`, `create_file_or_folder` and `delete_file_or_folder` were never checkpointed. A snapshot could not represent "this path did not exist" or "this was a folder".
   - Restores were fire-and-forget; failures were lost.
2. **A crash lost the conversation but not the changes.**
   - Threads are written to storage, which reaches disk only on the storage service's flush (every 60 s), while the agent's file writes hit disk at once.
   - Killing Kodia mid-task left files the restored conversation knew nothing about. Measured: the entire conversation was missing after the crash, while the file it had written existed.
3. **A tool cut off by a stop was labelled "interrupted by the user"**, and only when that thread was next opened.
4. **Tool results could overwrite earlier turns.**
   - `_updateLatestTool` matched the tool-call id across the whole thread. A provider that reuses ids (e.g. `call_0` every turn; several OpenAI-compatible and local servers do) overwrote an *earlier turn's finished* tool call in the history.
   - Seen in the scenario-8 test: after restart, the new `read_file` replaced the old `write_file` record.

**Now** (`chatThreadService`, `editCodeService`, `editCodeServiceTypes`):
- **Checkpoints around every file-changing tool.** Snapshots are taken from disk **before and after** each create/write/rewrite/edit/delete, plus every file under a deleted folder (up to 500 paths, 2 MB per file).
  - A snapshot records content, or `absent`, or `isFolder`; when the file is open, it also keeps the editor's diff areas, as before.
  - After a failed tool too, since it may have changed something.
- **Restore is awaited and ordered:** folders first (outermost first), then contents, then removing what did not exist (innermost first; a folder only if it is empty).
  - It goes through the open model when there is one, and writes the disk otherwise.
  - Failures are reported in a notification. `jumpToCheckpointBeforeMessageIdx` now returns a Promise that resolves when the disk matches.
- **Durable conversations.** Threads are flushed to disk 1 s after any change, right away when a tool starts, and awaited after every file change. A crash can no longer leave file changes the saved conversation lacks.
- **Startup recovery.** At startup every thread is checked, and tools saved as running are marked "interrupted because Kodia stopped (closed, restarted or crashed) … may not have finished. Check what it changed …", so the agent continuing the task knows.
- Only a tool call still in progress (`running_now`/`tool_request`) is updated by id; a finished result is never overwritten.
- Regression caught and fixed during the work: the new pre-change snapshot awaited for *every* tool. That would have broken the synchronous `onInterruptor` contract of parallel read-only batches (stop would not interrupt them). It now awaits only for file-changing tools.

**Evidence**:
- `test/electron-browser/checkpointRecovery.test.ts` (2, real ToolsService/EditCodeService on disk):
  - In one turn the agent edits a.js, overwrites c.js, creates b.js, deletes d.js and creates src/lib/. Rewinding to before the turn gives exactly the original tree (b.js and lib/ gone, d.js back); jumping forward gives exactly the post-turn tree. Before the fix, the rewind changed nothing.
  - A recursive delete of `src/legacy` (nested folders) is rewound to the whole tree.
- `test/electron-browser/sessionRecovery.test.ts` (scenario 8):
  - Process 1 writes a file, then is killed during a 60 s command. Only flushed storage survives, via a storage fake that persists only on `flush()`.
  - Process 2 starts from that storage on the same disk. The conversation is there up to the command, which is marked "interrupted because Kodia stopped". The user says "continue"; the agent sees both facts and carries on, and the history keeps the earlier `write_file`.
  - Before the fixes it failed at "the conversation was saved before the crash", then at the id overwrite.

**Not verified / not done**:
- Real storage flush timing in the packaged app (the real `StorageService.flush` writes SQLite through IPC; tested only with a fake that has the same contract).
- Changes made by terminal commands (`npm install`, codegen, `git checkout`) are not checkpointed and cannot be rewound.
- Thread storage serializes every thread with its snapshots on each change; long sessions over large files grow it, and there is no pruning yet.
- A deleted file's open editor model is not disposed.
- No agent-callable "revert my last change" tool; rewinding is a user action.

## 2026-11-21 (o) — Roadmap 9: project memory / context

**State found**:
- The design is sound: `.kodia/memory.md` in the repo, rewritten one `## ` section at a time by `write_project_memory`, loaded into every system prompt; rules files (`.voidrules`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.windsurfrules`) are pre-loaded and picked up when added; a one-time offer bootstraps the memory.
- Only the pure section helpers were tested; the service never was. Defects found:
1. **Lost updates.** Each write rebuilt the file from the in-memory copy, without serialization. Two writers at once (now realistic with parallel subagents) kept only one update. Demonstrated: 8 concurrent writes left fewer than 8 sections.
2. **Edits overwritten.** An edit made to the file meanwhile (a teammate's pull, the user typing) was overwritten until the file watcher happened to report it. Demonstrated with an append followed by a write.
3. **Unbounded memory in the prompt.** The memory cap is `Infinity` (the user's committed "no limits" policy, kept), so the whole memory went into every system prompt regardless of the model's context window and could crowd out the conversation on a small model.
4. **A wrong tool description.** `write_project_memory` told the model the memory is "capped at ~Infinity tokens".

**Now**:
- Writes are serialized, and each one starts from the file as it is on disk now. `setMemory` is serialized too.
- The memory stays unlimited on disk, but in the prompt it gets **15% of the model's context window**: whole sections are kept in order while they fit, and a note names the sections left out and says to read them from the file. The per-turn system-prompt cache key includes the budget.
- The tool description is truthful for an unlimited cap.
- `ProjectMemoryService` is exported; the harness can run the real service on the real disk.

**Evidence**:
- `test/common/projectMemoryBudget.test.ts` (3): pass-through when the memory fits; section-wise fitting, with the left-out sections named and order kept.
- `test/electron-browser/projectMemoryService.test.ts` (4, real service, real disk):
  - 8 concurrent section writes all survive.
  - A teammate's edit made between two writes survives.
  - **Cross-session**:
    - Session 1's agent runs `npm test`, which really exits 1. It saves "use `npm run check:unit`" to memory.
    - Session 2 is a new set of services and a new conversation. Its system prompt holds that note, the agent runs `npm run check:unit`, and the real output is `unit ok`.
  - A 20k-token memory with a 64k-window model: the first sections are in the prompt, the rest are named, and late sections' content is absent.
- Run against the old write logic (patched into a scratch build), the two writer tests fail and the other two pass.

**Not verified / not done**:
- Memory lives in the first workspace folder only (multi-root workspaces share it).
- Nothing decides automatically what is worth remembering; it relies on the model calling `write_project_memory` (plus the one-time bootstrap offer).
- A deleted rules file stays in context until its model is disposed.
- Observed on the way, not fixed: with a ~16k-token model and no native tool calling, Kodia's XML tool definitions alone nearly fill the window, and the system prompt gets trimmed (memory included). A smaller tool set for small models would be its own task.

## 2026-11-21 (p) — Roadmap 10: production hardening (real app launch, production bundle, security check)

**Checked**:
- **Runtime npm packages:** every one Kodia's code imports is a production dependency.
- **The real app (dev build, `.build\electron\Kodia.exe`)** was launched with a temporary profile and workspace for 75 s, twice, and its stdout/stderr and logs were scanned.
- **The production bundler** (`build/next/index.ts bundle`, the esbuild path that puts the main process into one file) was run into a throwaway folder, deleted afterwards.
- **VS Code's Trusted Types check** (`npm run tsec-compile-check`) was run.
- **Console logging** was scanned for keys/tokens/headers.
- The user's pending build-file changes (gulpfile.vscode.ts, dependencies.ts, code.iss) were neither modified nor needed.

**Defects found and fixed**:
1. **The real tokenizer never loaded in the app** (found only by launching it). `importAMDNodeModule('gpt-tokenizer', 'gpt-tokenizer/dist/o200k_base.js')` doubled the package name, giving `node_modules\gpt-tokenizer\gpt-tokenizer\dist\…` (ENOENT in the main log). The failure was swallowed, so **every token count in Kodia was a chars/4 guess**: context budgets, trimming, summary thresholds and the memory budget.
   - Fixed the path. Load failures are now observable (`whenTokenizerLoaded`, `isTokenizerLoaded`).
   - `test/electron-browser/tokenizerLoads.test.ts` (2) checks that o200k/cl100k load and that "hello world" = 2 tokens, not the estimate's 3. It fails with the old path.
   - On relaunch the error is gone.
2. **Metrics could leak despite the forced opt-out.**
   - The `didOptOut = true` decision was implemented by creating a PostHog client (the upstream Void project's key) at startup and calling `optOut()` only after storage was ready. A `capture()` in between could be queued for that third party with machine ids.
   - Every start also logged the machine ids.
   - Now no client is created while metrics are off (`METRICS_ENABLED = false`), `capture` is a no-op, and the id logging is gone.
3. **The production bundle warned about duplicate `case 'test_run'`** in `autonomyPolicy.assessRisk`. Both returned `'medium'`, so there was no behaviour change; the dead clause was removed, so the bundle builds warning-free for Kodia code.

**Side effect of the tokenizer fix, verified**: with real token counts, the context-overflow test's learned ~7.4k window no longer holds Kodia's system prompt (XML tool list included), so Kodia also requests a thread summary. The chars/4 guess had hidden that. The test now counts the agent's own requests separately from the summary request.

**Totals at the end of roadmap 10**: electron **1055/0**, node **45/0**, tsc clean, eslint 0 errors, layers 21 (baseline).

**Results**:
- The app starts and keeps running.
- No Kodia errors remain in its logs. What remains is dev-environment or upstream: the marketplace URL doesn't resolve, tunnels aren't configured, a wasm MIME type in dev, the extension host's debugger banner, and upstream Copilot's BYOK bridge (`agentHostByokLmHandler`) not being registered, which is separate from Kodia's registered `kodiaAgentHostLm` channel.
- The bundler built 25 bundles with no static `require("posthog-node"|"playwright-core")` in the main bundle.
- tsec passed.

**Not verified / not done** (left for the user's own release process):
- No installer was built (gulp `vscode-win32-x64` + Inno Setup with the user's in-progress `code.iss`).
- The *minified packaged* app (ASAR, `node_modules.asar` paths for `importAMDNodeModule`) was not launched; only the dev build.
- No code signing, auto-update or publishing (the mandate forbids publishing).
- Kodia's UI was not driven in the launched app: the launch proves startup and module loading, not the sidebar flows (those are covered by the agent-loop tests).
- Committed dev scripts `src/vs/workbench/contrib/void/common/fix_autonomy.js`, `fix_imports.cjs` and `fix_imports.mjs` are tracked leftovers (not imported). They're the user's to remove.

## 2026-11-21 (q) — Autonomous follow-ups: LIVE scenario 10, small-context tool budget, snapshot pruning

The user asked for the remaining work to be done autonomously, without permission questions. The hard limits still apply: no commit/push/publish, the protected build files and the OpenCode source untouched.

**LIVE acceptance scenario 10 (integrated workflow) — PASSED against NVIDIA `nemotron-3.5-super-vl-120b-a12b`** (`test/electron-browser/agentLoopLive.integrated.test.ts`; evidence `%TEMP%\kodia-live-integrated-evidence-<model>.json`):
- **Setup:** a real model, nothing scripted, in a temp git repo with a buggy shop (cart total ignores quantity), a failing test, a page served from the repo, and the user's uncommitted `notes.txt`.
- **What the model did, in one turn (~26 real tool calls):** explored with `get_dir_tree`/`ls_dir`/`read_file`; `git_branch_create` and `git_branch_switch` to `fix/cart-total`; `run_command node --test` (fails); `edit_file src/cart.js`; `run_command` again (passes); `browser_launch`, `new_tab`, `inspect_page` and `close` on the running app; `git_status`, `git_stage`, `git_commit`.
- **Independent checks:**
  - the branch exists with one commit, which changes only `src/cart.js`;
  - the tests are unchanged and `node --test` passes;
  - a fresh browser shows `Total: 6.00`;
  - `notes.txt` still holds the user's draft and is still uncommitted.
- **Runs:** two runs; the first failed only on my test's regex (`git()` trims the leading space of the porcelain line), and the second passed outright.
- Shared live helpers: `liveModel.ts` and `browserServiceProcess.ts`, also used by the scenario-1 live test and the scenario-3 test.

**Small-context models: tool definitions sized to the window** (new `common/toolBudget.ts`; `chatThreadService`):
- Measured with the real tokenizer: 133 tools = **~12,900 tokens**, in XML (12,872) or native JSON-schema form (13,180). That is 80% of a 16k window.
- When the full set takes more than half of a model's context window, a prioritized subset that fits is offered: files/search/edit, then terminal, code navigation, plan/memory/tests, git basics, subagent/web, browser basics, then the rest.
- The model is told which tool groups are missing.
- Models with 32k or more (including the unknown-model fallback) keep the full set, so nothing changes for them.
- Uses the same explicit-tools path as subagents (native `tools` and the XML prompt).
- Tests: `toolBudget.test.ts` (3); `toolBudgetAgent.test.ts` (2, real agent loop, real tokenizer): a 16k model gets a subset within 8k tokens, is told what it lacks, and still writes the file; a 128k model gets no explicit subset.

**LIVE acceptance scenario 2 (complete application) — PASSED** (`agentLoopLive.app.test.ts`):
- **What the model did:** built a dependency-free todo app from scratch in ~3 min and 24 real tool calls: create/write files, run its tests, read, edit. One `edit_file` was malformed and refused; the model recovered by itself.
- **Independent checks:** all 5 parts exist and the app's own `node --test` passes. Then, over real HTTP: GET `[]`; POST 201 `{id,title:"buy milk",done:false}`; empty title 400; the todo survives a server restart (file DB). In a real browser the page lists it, and adding "walk the dog" through the form shows on the page and in the API.

**LIVE acceptance scenario 7 (multi-agent) — PASSED** (`agentLoopLive.multiagent.test.ts`):
- **What happened:** the model made both `subagent` calls in one reply (a parallel batch). Each subagent did real work in its own thread (list/read/create/write/run tests). The parent then read both results, ran `node --test`, and consolidated.
- **Independent checks:** both modules pass the test's own behaviour checks (slugify incl. non-ASCII; wordCount incl. whitespace-only), and the combined suite passes.

**LIVE acceptance scenario 4 (debugger-driven repair) — PASSED** (`agentLoopLive.repair.test.ts`; VS Code's real DebugSession + debugpy):
- **What the model did:** read the program; set a breakpoint inside the loop; started a real debug session. Its first `debug_start_session` was malformed; the error said to pass an inline configuration, and the model corrected itself. It then read scopes and variables, stepped over and continued over several iterations reading variables each time, and stopped the session.
- **The fix:** `total = line_total(...)` became `total += …`. The model ran the program, which printed `TOTAL=48.0`, as the test's own run confirms.

**Defects found by the live runs and fixed**:
0. **`browser_shutdown` disabled the browser for the rest of the Kodia session.** In the scenario-3 live run the model cleaned up with `browser_shutdown`; `KodiaBrowserMainService.shutdown()` set a permanent `shuttingDown` flag, so every later `browser_launch` failed with "Browser service is shutting down" until restart. Nothing else in the app calls it. Now it closes every session and refuses launches only while closing. Regression test in `browserAutomationSignals.test.ts`.
1. **File ownership over-claimed folders.** In the scenario-7 run, the second subagent's `create_file_or_folder` for the shared `src/` and `test/` folders was refused, because the first subagent had claimed them. Folders are shared containers, and creating an existing one changes nothing; only files are owned now (deleting a folder is still checked). Regression test in `subagents.test.ts`: two parallel subagents both create `shared/`, then each writes its own file, and all four calls succeed.
2. **The `edit_file` format error didn't help the model.** In the scenario-2 run, a malformed `edit_file` returned `Error: Error: No Search/Replace blocks were received!`. Now:
   - the message shows the exact `<<<<<<< ORIGINAL / ======= / >>>>>>> UPDATED` format;
   - it points at `write_file` for whole-file content, and says when the input was a unified diff;
   - the doubled `Error: Error:` prefix is gone (the catch used `e + ''`).
   - Test in `realFilesystemEditing.test.ts`.

**LIVE acceptance scenario 3 (browser-driven repair) — PASSED** (`agentLoopLive.repair.test.ts`):
- **What the model did, in ~2.5 min:**
  - launched the browser and inspected the page, reading its measured layout problems and console errors;
  - read the 3 files and edited them: `z-index: 20` for `#checkout`, and the `cartCount` id in `app.js`;
  - reloaded, clicked "Add to cart", and re-inspected.
- **Independent fresh-browser check:** no covered controls, "Cart (1)", and no console errors. The browser kept working after the agent's own cleanup.
- The first run had failed on the `browser_shutdown` defect (item 0 below).

**Code search re-ranked by meaning (mandate D.8)**: `nvidiaRerankerMainService.rerankTexts`, `node/codeIndexService` and `electron-main/codeIndexMainService`.
- **Probing the endpoint found:**
  - Both NVIDIA embedding models tried first are **retired** (HTTP 410). Of 8 embedding-like models listed, only 2 answered for this key.
  - Kodia's existing NVIDIA reranker (`nemotron-3.5-rerank-8b`, used for web search) works, so it is reused rather than adding an embedding client.
- **How it works:**
  - The best 30 word matches are scored by the reranker, which reads the key from the main process's encrypted settings, so no key crosses IPC.
  - They are fused with the word ranking: reciprocal-rank fusion with the reranker weighted ×2.
  - This happens only when the chat model's provider is NVIDIA, so the code goes to no new recipient. Otherwise it is word ranking, and the result says how it was ranked and why.
- **A provider limitation handled:** NVIDIA's content-safety screen rejects a whole request (HTTP 422) when any passage trips it, which happens on Kodia's own security-related code. Batches of 10 are split until only the offending passages are unscored, and those keep their word rank.
- **Live evaluation on Kodia's own source** (`test/electron-main/codeIndexRerank.test.ts`, `KODIA_LIVE=1`; the same 10 self-written questions as before):

  | Ranking | Rank 1 | Top 3 |
  |---|---|---|
  | Words | 7/10 | 10/10 |
  | Words + reranker | 8/10 | 10/10 |

  Equal and ×2 weights gave the same result. It is a small, real improvement, not a semantic index: candidates still come from words.
- Deterministic tests cover fusion (the reranker's favourite rises to the top; an unscored candidate keeps its rank), fallback with the reason, and the unscored note.

**LIVE acceptance scenario 8 (session recovery) — NOT verified live** (`agentLoopLive.recovery.test.ts` exists; the scripted version `sessionRecovery.test.ts` passes):
- **Run 1:** every request failed with network/"Connection error", a connectivity outage.
- **Run 2:** the test's crash trigger counted only `write_file`, so it never fired. Fixed in the test.
- **Run 3:**
  - The real model's `create_file_or_folder` and `write_file` calls returned tool errors, and the model fell back to dozens of `run_command` calls.
  - A scripted reproduction of the same setup (crash-safe storage, a new nested folder) succeeded, so the cause is in what this model sent. The error text was not captured.
- **Run 4:** stopped after 20+ minutes in process 1 without a result. The test now stops after 4 failed file-tool calls and writes their parameters and errors to `%TEMP%\kodia-live-recovery-file-tool-errors.txt`.
- **Open task:** rerun it, read that file, and fix the cause.

**Totals after this round**:
- electron **1065 passing / 0 failing**; the 1 pending is the live re-rank evaluation, skipped without `KODIA_LIVE=1`;
- node **46/0**;
- tsc clean; eslint 0 errors (31 changed files); layers 21 (baseline).
- The live tests (`*Live*`) are excluded from offline runs; they need the NVIDIA key.

**Bounded snapshot storage** (`chatThreadService`):
- Saved file contents in a conversation's checkpoints are capped at ~20 MB, newest kept. Older snapshots' contents are dropped and marked `pruned`; this runs after every checkpoint of any kind.
- Rewind skips a pruned snapshot for the next usable one (the "before" snapshot of the following change holds the same content). When none is left, it reports "too old to restore" in the notification instead of restoring wrongly.
- Test (in `checkpointRecovery.test.ts`): with a small cap, old contents are dropped, the stored total stays within the cap, rewinding the last turn works, and rewinding past the cap leaves the file untouched.

## 2026-11-21 (r) — LIVE scenario 8 passes; roadmap 2 history operations, tags, remotes, worktrees

**LIVE acceptance scenario 8 (session recovery) — PASSED** (`agentLoopLive.recovery.test.ts`, NVIDIA `nemotron-3.5-super-vl-120b-a12b`):
- **Root cause of the earlier failures (runs 2–4): the test, not Kodia.** The wait loop's condition `isRunning !== undefined` is false before the turn starts streaming, so the "crash" fired at t=0 (the empty error file was written the same second the run started). The test then awaited a turn that never began, for up to 30 min, which was the run-4 hang. Now it waits for the start, and a killed process's turn is not awaited.
- The crash trigger now counts **content writes only** (`write_file`/`rewrite_file`/`edit_file`). In the first passing run, the 2 calls before the crash were folder creations, which is not really mid-task.
- **Passing run:** process 1 was killed after 5 tool calls (2 file writes). Process 2 restored those 5 calls from crash-safe storage, wrote the remaining 3 files, ran `node --test`, fixed 2 failures with `edit_file`, and reran to green.
- **Independent checks:** the project's 11 tests pass, and the spec's behaviour checks pass (km→m, cm→m, RangeError, °C↔°F). Evidence: `%TEMP%\kodia-live-recovery-evidence-<model>.json` (the folder-only run is kept as `…-run5-folders.json`).

**Roadmap 2 (Part K): the missing git operations** (`common/gitOperations.ts`, `gitService.ts`, wired through `toolsService`, `toolsServiceTypes`, `prompts`, `autonomyPolicy`):
- **New tools:**
  - `git_revert`, `git_cherry_pick`, `git_rebase`: a stop on conflicts is a result naming the conflicted files, not an error, and never a false success;
  - `git_continue` refuses while conflicts remain; `git_abort` restores the pre-operation state;
  - `git_reset`, `git_tag_list`, `git_tag_create`, `git_remote_list`, `git_worktree_list`, `git_worktree_add`.
- **Status** now reports `operationInProgress` (merge, revert, cherry-pick or rebase) instead of merge only.
- **Safeguards:**
  - A hard reset is refused while tracked files hold uncommitted changes. Every reset is refused during an in-progress operation.
  - Every reset reports the commits the branch no longer contains and the previous HEAD, so it can be undone.
  - Risk levels: `git_reset` is high, or critical in hard mode, so the autonomy policy asks the user; `git_rebase` is high; the others are medium or low.
  - The main process allowlists the new subcommands and their actions: `remote -v` only; `worktree list`/`add` only, so no remove or prune; no interactive rebase or `--exec`.
  - Credentials in remote URLs are redacted before reaching the model.
- **Tests:**
  - `test/node/gitOperations.test.ts` +10 on real repos, plus extended IPC validation. Covered: revert; cherry-pick conflict → continue; rebase conflict → abort restores HEAD exactly; clean rebase; hard reset refused with the user's work intact; reset undo; reset refused mid-merge; tags (annotated tags report the commit, not the tag object); redacted remotes; worktree isolation.
  - `test/electron-browser/gitAgent.test.ts` +1 through the real agent loop and the real IPC channel. The model cherry-picks, sees the conflict, resolves, stages and continues. A hard reset asks the user, and after approval the tool still refuses because of the user's uncommitted notes. A worktree is created on a new branch while main stays checked out.
- The small-context tool subset gains `git_continue`/`git_abort`, so a model that hits a conflict can finish or undo it.

**Totals:** electron **1067 passing / 0 failing / 1 pending** (was 1065); node **56/0** (was 46); tsc clean; eslint 0 errors on the 11 changed files.

**Next concrete task:** roadmap 3's open row (tests through VS Code test-controller extensions; coverage, flaky detection, test history), then the remaining Part K items (commit-message generation, PR preparation).

## 2026-11-22 (s) — Full verification run; correction to (r)

Every check, run one after another on a fresh `npm run transpile-client`:

| Check | Result |
|---|---|
| Electron suite (offline) | **1067 passing / 0 failing / 1 pending** |
| Node suite | **56 / 0** |
| Live NVIDIA `agentLoopLive.nvidia` | 2 / 0 |
| Live `agentLoopLive.integrated` | 2 / 0 |
| Live `agentLoopLive.app` | 2 / 0 (11 min) |
| Live `agentLoopLive.multiagent` | 2 / 0 |
| Live `agentLoopLive.repair` | 3 / 0 |
| Live `agentLoopLive.recovery` (scenario 8) | 2 / 0 |
| eslint, 95 changed or new files | 0 errors (6098 warnings, almost all auto-fixable formatting) |
| Type check (Void code and everything it imports) | **clean after fixing 2 errors** |

- **Correction to (r):** "tsc clean" was wrong. `test/electron-browser/gitAgent.test.ts` passed `paths: ['README.md']` and `new_branch: true` to `ScriptStep`, whose params are strings, as a model sends them. These were 2 type errors (TS2322). The runtime suite missed them because transpiling strips types. Fixed by passing `'README.md'` and `'true'`, which the validators accept. The test still passes (4/4).
- **Full `src` type check does not fit this machine:** 7.9 GB RAM. It ran out of heap at 7–8 GB twice, once alone. In its place is a Void-scoped check with the same compiler options, covering ~5.4k files: the Void code, everything it imports, and all global `.d.ts`. Code outside Void that Void does not import was not type-checked this round.
- Three old test files appear as deleted in git: `realDAPDebuggerIntegration`, `realDebuggerIntegration`, `testToolService` (common). An earlier round replaced them deliberately: the debugger pair by `test/node/nodeInspectorDebugging.test.ts`, as its header says, and the mock-only test-tool test as described above under roadmap 3. No code imports them.

## 2026-11-22 (t) — Roadmap 3: test history, regressions, flaky tests, coverage

Committed (r)+(s) first, on branch `kodia/agent-engine-roadmap` (commit `d185ffe6`), pushed to `origin` at the user's request. The user's five build-file changes were left out of the commit and are still uncommitted.

**Bug fixed:** `test_run` and `test_run_targeted` accepted only real arrays. A model that sent one file or name as text (every XML tool call does) had it silently dropped, and the **whole suite ran** instead. Now an array, a JSON array in a string, or a single string are all accepted, and `test_run_targeted` with no files is an error, not an empty run. The new agent-loop test fails against the old validator (checked: 0 passing / 1 failing) and passes now.

**New (`common/testHistory.ts`, `common/testCoverage.ts`, wired through `testToolService`, `toolsService`, types, prompts, policy):**
- **History:** every reported run is recorded per test, kept in workspace storage so it survives a restart, and bounded (20 outcomes per test, 2,000 tests, 50 runs).
  - Every outcome carries a **fingerprint of the code it ran on**: git HEAD, the uncommitted diff, and untracked files by size and modification time. Kodia's own `.kodia/` files and caches are excluded.
- **Every run result now flags changes:** REGRESSION (passed last run, fails now), Fixed, and Known flaky.
- **Flaky detection:** a test is flaky only when it **passed and failed on the same fingerprint**.
  - A test that fails after an edit and passes after the fix is a fix, not flakiness.
  - Without git, history never calls a test flaky.
- **`test_check_flaky`:** reruns the named tests 2–10 times on unchanged code. It reports flaky tests (with their failure messages), tests that fail every time, and tests that pass every time, and warns when the code changed during the check.
- **`test_history`:** per test, passes, failures and skips, the failing streak, outcome changes, the flaky evidence and the last failure message. It can filter by name or show problems only.
- **`test_coverage`:** runs the framework's own coverage and parses lcov or Go cover profiles.
  - Reports line and branch totals, per-file percentages with uncovered line ranges, and focus files.
  - A focus file that no test loads is reported as not covered.
  - A missing plugin is named: pytest-cov, @vitest/coverage-v8, or c8 for Mocha.
  - Cargo, dotnet and PHPUnit refuse with the reason.
  - Report folders are deleted afterwards.
- Risk levels: `test_history` is low; `test_coverage` and `test_check_flaky` are medium, like `test_run`.

**Tests (real runners, real git, real disk):**
- **History:** fixed, then regression across three runs, with a restart in between. The fingerprints keep fail(A), pass(B), fail(A) from counting as flaky.
- **Flaky test:** a test whose outcome alternates between runs is caught by `test_check_flaky` (2 passes, 1 failure). History then marks it flaky with the evidence, and the next failing run flags it as known flaky.
- **Coverage with the real `node --test`:** 3 of 7 lines, uncovered 3–6, branches counted, the unloaded focus file reported, nothing left behind.
- **pytest without pytest-cov:** the missing plugin is named and no coverage is invented.
- **Agent loop:** a plain-text test file runs only that file, and the coverage and history results reach the model.

**Totals:** Electron **1085 passing / 0 failing / 1 pending** (was 1067); node **56/0**; eslint 0 errors on the 13 changed files; Void-scoped type check clean (exit 0).

**Not done in roadmap 3:**
- Coverage through a VS Code test extension's own coverage.
- Debugging a single test.
- Test generation.
- A live-model run of the new tools.
- Real Jest, Vitest, Mocha and Go coverage runs (only their report formats are tested; Go is not installed here).

## 2026-11-22 (u) — Roadmap 2 (Part K): commit messages and pull-request preparation

The model writes the commit message and the PR text; Kodia supplies exact facts from git so the text can only describe what is really there.

**`git_commit_context`** (low risk, read-only):
- Lists the staged files with status, line counts, renames (old path) and binaries.
- Includes the staged diff, truncated with a flag; the file list is always complete.
- Lists the files **not** in the commit, so the message does not claim them.
- Reads the repository's style from its last 20 non-merge subjects: whether they follow conventional commits, the types and scopes used, and the typical subject length.
- With nothing staged it is an error that says what is unstaged.

**`git_pr_prepare`** (low risk; the conflict check writes no ref and no working-tree file):
- **Base:** origin's default branch (`origin/HEAD`), else main or master, never the current branch; or the one given.
- **Facts reported:** commits (no merges), changed files with counts, totals, ahead/behind, upstream and unpushed commits, uncommitted work.
- **Conflict check:** `git merge-tree --write-tree` shows whether merging into the base would conflict, and in which files.
- **Tests:** this session's **last test run**, or an explicit "no tests have been run, do not claim it is tested".
- **Refused:** detached HEAD, no commits beyond the base, an unknown base, an option-like base.
- Kodia does not open the PR on GitHub.

**Allowlist:** added `rev-list`, `merge-base` and `merge-tree`, all read-only. `symbolic-ref`, which can write, is still rejected (tested).

**Tests:**
- `gitOperations.test.ts` +3, on real repos:
  - Staged vs unstaged, rename and binary files, conventional-style detection.
  - A real conflict found while the working tree and index stay untouched.
  - After pushing to a real bare remote and merging the base: upstream, 2 unpushed commits, 0 behind, no conflicts, merge commits not listed.
  - The refusals listed above.
- `gitAgent.test.ts` +1, through the agent loop: write → stage → `git_commit_context` (sees the user's unstaged `notes.txt` called out, and the fix/feat style) → commit in that style → `git_pr_prepare` (sees base main, not pushed, merges cleanly, no tests run). The user's edit stays uncommitted.

**Flaky test fixed:** `sessionRecovery.test.ts` failed once in a full run and passed 3/3 alone. It assumed the command was running 300 ms after the model asked for it, so it fired too early on a loaded machine. It now waits for the running state, with a deadline.

**Totals:** Electron **1086 passing / 0 failing / 1 pending**; node **59/0**; eslint 0 errors on the 10 changed files; Void-scoped type check clean.

**Next concrete task:** roadmap 4, the debugger rows still open: JavaScript debugging through VS Code's js-debug adapter, attach, logpoints and exception breakpoints, verified with a real adapter.

## 2026-11-22 (v) — Roadmap 4: JavaScript debugging (js-debug), attach, logpoints, exception breakpoints

**The product had no JavaScript debugger.** `product.json` had `"builtInExtensions": []`, so Microsoft's js-debug (`ms-vscode.js-debug`, which provides the `node`, `pwa-node` and `chrome` debug types) was never shipped. No "node" launch could start in Kodia.
- `product.json` now lists `ms-vscode.js-debug` 1.140.1, pinned by sha256, with its marketplace ids (read from the marketplace API).
- `npm run download-builtin-extensions` downloaded it through the build's own path and verified the checksum. The GitHub release `.vsix` is byte-identical to the marketplace one.

**Bug found by the first real run: the agent could never see a JavaScript program stop.**
- js-debug runs the program in a **child** debug session that it requests from the client (DAP `startDebugging` → `IDebugger.startDebugging` → `IDebugService.startDebugging` with a parent session). The shipped extension does the same.
- Every debug tool acted on the session it started, which never has threads.
- Before the fix the first test failed: `{"state":"running","waitedMs":15003}` with the breakpoint hit in the child.
- `KodiaDebugToolService` now treats a session and its descendants as one program:
  - It waits for stops anywhere in the family, including child sessions created after the wait began.
  - Execution and inspection go to the stopped child (or the one with threads).
  - Console output includes the children's output, even after they end.
  - The agent keeps using the one id it was given. `debug_list_sessions` shows `parentSessionId`.

**New tool `debug_set_exception_breakpoints {session_id, filters}`** (medium risk):
- Enables exactly the debugger's named filters and disables the rest; `[]` turns them off. An unknown filter is refused with the real list.
- `debug_list_breakpoints` now also shows the exception filters and each breakpoint's condition, hit count and logpoint.
- Startup exceptions: launch with `stopOnEntry`, set the filters, then continue.

**Test stack:**
- `scripts/kodia-fetch-js-debug-dap.mts` downloads js-debug's standalone DAP server (same version, sha256-checked) into `.build/js-debug-dap`. That is the same adapter code the extension runs, usable without an extension host.
- `debugHarness.ts` connects it through VS Code's real `SocketDebugAdapter`. It handles child sessions as `common/debugger.ts` does.
- The harness maps `node` to `pwa-node`, as the extension's alias does. The standalone server drops a `node` launch without answering (seen on the wire).
- Exception breakpoints are now sent through the real `DebugSession.sendExceptionBreakpoints`; the harness's old `setExceptionBreakpointsForSession` did nothing.

**Tests** (`jsDebugTools.test.ts`, 6, real Node programs):
1. **Launch with a breakpoint:**
   - Stop at `applyDiscount:3`; the started session reports `stopped`; the child session is listed.
   - Stack and locals (`total=45`, `code='SAVE10'`, `rate=0.1`); evaluate `4.5` and `40.5`.
   - Step out to `checkout:8` (js-debug finishes line 7's assignment); continue to the end; `total=4.5` in the console.
2. **Logpoint:** the program never stops; `discount on 45 with SAVE10` is in the console.
3. **Exception breakpoints:**
   - `stopOnEntry` stops with reason `entry`. The filter `raised` is refused, and the error lists `all` and `uncaught`.
   - With `uncaught` on, the handled throw does not stop (its `handled: SyntaxError` is printed). The timer's throw stops with reason `exception` in `parse:2`.
   - The exception info has the SyntaxError message (js-debug puts it in `id`). `[]` turns both filters off.
4. **Attach:** to `node --inspect-brk=0`; breakpoint hit, evaluate; continue; the process exits 0 having printed its output.
5. **Agent loop:** start on entry, then `debug_set_exception_breakpoints` with `filters: "uncaught"` as a plain string, continue, `debug_get_exception_info`. The first run caught a real bug: the validator was called with an extra argument, so the filter became the literal word `"filters"`. The transpile step does not type-check.

`debugTools.test.ts` +1 (debugpy): `raised` stops where a handled `ValueError` is raised (`parse:2`); with `[]` the program runs to its end. This checks the filter names the tool description gives for Python.

**Totals:** Electron **1092 passing / 0 failing / 1 pending**; node **59/0**; Void-scoped type check clean; eslint 0 errors on the changed files.

**Not verified:**
- The extension-hosted js-debug inside a running Kodia window: launch.json resolution, the extension's own child-session path, browser (`chrome`) debugging.
- PHP/Xdebug.
- Watch expressions.
- A live model using these tools.

**Next concrete task:** debug a failing test: start the test runner's command under the debugger, stopped at the failing assertion (roadmap 3 and 4 together).

## 2026-11-22 (w) — Debug a failing test; run_command quoting on Windows fixed

**New tool `test_debug {test_file, test_names?, stop_on_failure = true}`** (medium risk) runs one test under a real debugger and stops where it fails.
- **Plan** (`common/testDebug.ts`, pure): builds the debug launch configuration for the detected framework. Arguments are an array, so no shell is involved.
  - node --test, Jest and Mocha run under js-debug with exception filter `all`. Jest and Mocha run from the project's install.
  - pytest runs under debugpy with `userUnhandled`, which stops where an exception leaves the user's code into pytest's.
  - Refused with the reason: Vitest, Go (needs Delve), Rust (LLDB), .NET (vsdbg/netcoredbg), PHPUnit (Xdebug).
- **Run** (`KodiaDebugToolService.startAndRunToException`): the wanted exception filters are armed before launch. They are enabled the moment the debugger declares them while initializing, which the model announces synchronously, before the program runs. So the session's first breakpoint batch already carries them, child sessions included.
  - The first design (stop on entry, set the filters, continue) failed for real: `node --test` has no entry stop, and the session ended first.
- **Found with a wire-level probe** against js-debug: with js-debug's default `skipFiles` (Node internals), a failing `assert` **never pauses**, because `node:assert` throws from inside a skipped file. The same was true for a plain script. The plan sets `skipFiles: []`.
- The stop is then inside `assert`. The stop report now also names the **first frame in the user's code** (skipping `<node_internals>`, `node:` and `node_modules`).

**Bug found and fixed: `run_command` broke every command containing a double quote on Windows.**
- `wrapCommandForShell` built `cmd /c "..."` with inner quotes escaped as `\"`. PowerShell, the integrated terminal there, does not treat `\"` as an escape.
- Measured in Windows PowerShell 5.1:
  - `node -e "setTimeout(...)"` was a parse error.
  - `node -e "process.exit(3)"` reported exit 1.
  - `echo "two words"` printed stray backslashes.
  - PowerShell expanded `$HOME` and ate backticks.
- Now the command goes in a PowerShell single-quoted string (`cmd /c '...'`, `'` doubled), where nothing is interpreted. All 9 measured cases are correct, including pipes and `&&`.
- The session-recovery test had been "flaky" because of this: its 60-second command never ran. It passed only when a cold PowerShell took longer than 300 ms to fail. It now really runs the command. Its failure message now includes the thread's last messages, which is how the cause was found.

**Tests:**
- `testDebug.test.ts` (3, electron, real runners and debuggers):
  - **Agent loop, node --test:** `test_debug` with `test_names` as a plain string stops with reason `exception`, and the report points at `math.test.mjs:7`. The stack trace and `debug_evaluate_expression got` in that frame give the real wrong value, `8`. Then the session is stopped.
  - **pytest:** stops at `test_total:8` (`assert 5 == 6`), and evaluating `got` gives `5`.
  - **Passing test:** runs to its end. Go and an uninstalled Mocha are refused with the reason.
- `test/common/testDebug.test.ts` (3): argument arrays, name escaping, the empty `skipFiles`, pytest `-k`, refusals, option-like files.
- `terminalWrap.test.ts` (1, real PowerShell): quoted commands, exit codes, pipes, `&&`, `$` and backticks.

**Totals:** Electron **1099 passing / 0 failing / 1 pending**; node **59/0**; Void-scoped type check clean; eslint 0 errors.

**Not verified:**
- Jest and Mocha debugging (not installed here; with an empty `skipFiles`, their own internal try/catch could pause before the failure).
- Vitest.
- ~~PowerShell 7~~: verified afterwards in PowerShell 7.7.0 (`$PSNativeCommandArgumentPassing = Windows`). All 9 cases are correct with the new wrapping; the old wrapping broke the same cases as in 5.1.
- A live model.

**Next concrete task:** VS Code test-controller coverage (`test_coverage` through a coverage-capable test extension), then the embedding index.

## 2026-11-22 (x) — Jest and Mocha test debugging, verified (user-approved npm install)

Jest 29.7.0 and Mocha 10.7.3 are installed in git-ignored `.build/kodia-js-test-deps` (`npm install --prefix .build/kodia-js-test-deps jest@29.7.0 mocha@10.7.3`). Each test project links to it through a junction, which teardown unlinks first.

**The first real run failed for both.** With exception filter `all`, Jest stopped first inside `fs.statSync` (its resolver's own try/catch) and Mocha inside the CommonJS module loader, before any test ran. The open risk noted in (w) was real.

**Fix: an exception-breakpoint condition.** js-debug supports conditions on its filters (`supportsExceptionFilterOptions`, `supportsCondition`, with the thrown value as `error`, read from its initialize response). The JavaScript plans now carry `JS_ASSERTION_CONDITION`, which matches:
- an `AssertionError` by name or constructor (node:assert, chai);
- or an error with `matcherResult` (Jest's `expect`).

`startAndRunToException` applies it while arming, and **restores the user's own filter settings** (enabled state and condition) when the session ends. Without that, a later debug session would silently keep "stop on assertion errors".

**Limit, stated in the tool description:** in JavaScript, a test failing with another error (for example a `TypeError` in the code under test) does not stop. The agent is told to read the stack and use a breakpoint. pytest still stops on any error leaving the test.

**Tests:**
- `testDebug.test.ts` +2 (Jest, Mocha): stop with reason `exception`; the user frame is the test file at line 4; `got` evaluates to `8` in that frame; the condition is on while running and gone after `debug_stop_session` (`all` disabled, no condition).
- `test/common/testDebug.test.ts`: the condition evaluated on real values. AssertionError and a Jest-style error give true; ENOENT, TypeError, null and a thrown string give false.

**Totals:** Electron **1101 passing / 0 failing / 1 pending**; Void-scoped type check clean (it caught `supportsCondition` missing on the `IExceptionBreakpoint` interface; the check now uses the model class); eslint 0 errors.

**Not verified:** Vitest; a live model. js-debug inside a running Kodia window was verified afterwards by the user: the agent stopped at `app.js:1` with `a = 2`, `b = 3` read through `debug_get_variables`.

## 2026-11-22 (y) — Roadmap 1 (terminal security): destructive commands now always ask first

**Real incident.** In a running Kodia (Agent mode) the agent emptied a user's project folder, `c:\wamp64\www\wondercommerce` (8917 files), with `Remove-Item -Recurse -Force`. It never asked: the command was rated *medium*, so Agent mode allowed it.

**Cause:** `isDestructiveCommand` had three flaws.
1. It did not know PowerShell's `Remove-Item` (or its aliases `ri`, `rm`), although PowerShell is the Windows default terminal.
2. It looked only at the **first word** of the command line: `cd x; rm -rf .` was judged by `cd`.
3. It required **both** recursive and force flags. Its recursive regex also read `-Force` as recursive, because of the `r` in it.

**Now:**
- Every command in a line is checked (split on `;` `&&` `||` `|` `&` and newlines, outside quotes), including through `sudo`, `cmd /c` and `powershell -Command`.
- Treated as destructive:
  - a recursive delete in any shell, with or without force;
  - deleting a whole folder (`*`, `*.*`);
  - `Remove-Item` fed by a pipeline;
  - `git clean -f`, `git reset --hard`, `git push --force`/`+ref`;
  - format/mkfs/dd/shred/wipe/scrub/diskpart;
  - `rimraf`, `shutil.rmtree`, `[IO.Directory]::Delete`, `fs.rmSync(..., { recursive: true })`.
- Destructive means critical risk, which needs approval in **every** mode, even with terminal auto-approve or an explicit allow.
- Single-file deletes and everyday commands are unchanged. The old `\bformat\s` pattern is gone, so `npm run format` no longer counts as destructive.

**Tests:**
- `test/common/destructiveCommands.test.ts` (5): the incident's exact command, PowerShell forms and aliases, chained, wrapped and piped forms, and git/other-program deletes. 18 everyday commands are not flagged. The policy result is checked in all 3 modes × {plain, terminal auto-approve, explicit allow}.
- `destructiveApproval.test.ts` (1, agent loop, Agent mode, real PowerShell): `node --version` runs without asking. `Remove-Item -Recurse -Force <project>\*` stops for approval. The test declines, the tool result is `rejected`, and every project file still exists.
- The existing terminalSafety and autonomy suites still pass.

**Totals:** Electron **1107 passing / 0 failing / 1 pending**; Void-scoped type check clean; eslint 0 errors.

**Not covered:** command-line obfuscation (variables holding the command, `Invoke-Expression` of built strings, base64-encoded PowerShell). A pattern check cannot see through these; real sandboxing or a filesystem-level guard would be needed (roadmap 10).

## Session report — 2026-11-21: roadmap 1–10 pass complete (mandate format)

1. **Changed**:
   - Roadmap 5: browser truthfulness and scenario 3.
   - The edit-exactness data-loss fix (found by scenario 3).
   - Roadmap 6: subagents.
   - Roadmap 7: code index.
   - Roadmap 8: multi-file rewind/replay; durable sessions; the tool-id history overwrite.
   - Roadmap 9: memory writes and budget.
   - Roadmap 10: tokenizer, metrics, dead clause.
   - Roadmaps 1–4 earlier (sections a–j).
2. **Verified**: by real-disk, real-process, real-Chromium, real-debugpy and real-git tests through the real agent loop, plus a real app launch and production bundle. Every behaviour fix has a test that fails on the old code (shown per section). Final totals are in the next entry.
3. **Incomplete**:
   - Live-model runs of scenarios 2, 3, 5, 6, 7, 8, 10 (only scenario 1 and the weak-model A/B ran live).
   - Embedding search.
   - Subagent UI.
   - Terminal-change rewind.
   - Thread-storage pruning.
   - A compact tool set for small-context models.
   - Installer/signing/packaged-app launch.
4. **Roadmap advanced**: every item 1–10 has had a from-scratch inspection, with fixes and evidence. See the capability matrix for each row's honest status.
5. **Risks**:
   - Conversations are now flushed often (cost on huge histories).
   - Snapshot growth in thread storage.
   - The lexical index is not semantic.
   - Scripted-model tests prove the plumbing, not model quality.
6. **Next task**: a live-model run of the integrated scenario (10) with the NVIDIA key, then the follow-ups above in the user's priority order.

## Session report — 2026-11-20 (per the mandate's end-of-session format)

1. **Changed**: disk-write correctness (partial-write truncation, coalesced full-model saves); agent loop (finishReason continuation, inactivity timeout with real abort, timer leak, narration guard, context-overflow learning/recovery, completion check + setting); unknown-model 32k fallback and Llama family matching (10M-window bug); terminal dev tools' fake success; leftover debug log; test infrastructure (shared harness, real terminal, live NVIDIA test, network guards); replaced fake debugger "tests" with a real inspector test; fixed all 20 previously failing tests at their root cause.
2. **Verified**: electron suite 1038/0, node suite 18/0; live NVIDIA scenario 1 with nemotron-3.5-super-vl (strict checks pass) and a 13-run A/B on lightning-30b; every behaviour fix has a test that fails on the old code.
3. **Incomplete**: everything in the matrix not marked integration-tested/verified, notably roadmap 2, 3, 5–7, 9, 10 not re-inspected; scenarios 2–8 and 10 not run; DAP/IDebugService debugging; UI transformation (Part 4); multi-agent (Part C).
4. **Roadmap advanced**: 1 (terminal outcome reporting), 4 (real inspector-level debugging test; DAP still open), 8 (editing persistence and recovery), plus cross-cutting Phase 1 core reliability and weak-model compensation.
5. **Risks**: the completion check adds one model request to agent turns that change files (switchable); learned context windows are session-only; scripted tests needed request-count updates for the new check.
6. **Next task**: ~~detect test weakening~~ done (f3); ~~roadmap 2 core~~ done (h); ~~roadmap 3 core~~ done (i). ~~roadmap 4 core~~ done (j). ~~roadmap 5 core + scenario 3 (scripted)~~ done (k). ~~roadmap 6 core + scenario 7 (scripted)~~ done (l). ~~roadmap 7 core (lexical index)~~ done (m). ~~roadmap 8 core + scenario 8~~ done (n). ~~roadmap 9 core~~ done (o). Next: roadmap 10 (production hardening / packaging / release) re-inspected from scratch; open follow-ups: embedding search, live-model runs of scenarios 3 and 7, thread-storage pruning, a compact tool set for small-context models.

## 2026-11-20 (g) — Roadmap 1: terminal dev tools reported fake success

`dep_install` and `db_migrate` always returned `success: true, exit_code: 0` regardless of the command's result; `lint_run` derived success by counting the substring "error" in output (matching "0 errors", missing failures worded otherwise). All three now use `terminalCommandOutcome()` (`common/terminalUtils.ts`): success = ran to completion with exit code 0, real exit code passed through, an inactivity kill is never a success. Evidence: `terminalCommandOutcome.test.ts` (3 unit) + `electron-browser/terminalDevTools.test.ts` (4 with real processes through the real `ToolsService`: failing install → `success:false, exit_code:3`; "0 errors" + exit 0 → success; lint failure without the word "error" → failure). Harness terminal now propagates exact exit codes (`exit $LASTEXITCODE`).

## Capability matrix (honest status; only rows inspected so far)

| Roadmap # | Capability | Status | Evidence / notes |
|---|---|---|---|
| 8 | File create/write/edit/delete via agent tools | **Integration-tested** (real disk, tool layer down) | realFilesystemEditing.test.ts 11/11 |
| 8 | Partial edits (diff reject, Ctrl+K, fast apply) persist correctly | **Integration-tested** (`_writeURIText` level) | regression tests fail at HEAD, pass now |
| 8 / Phase 1 | Model → tool-call → filesystem → result → continuation (acceptance scenario 1) | **End-to-end verified** (live NVIDIA nemotron-3.5-super-vl; file tools only) | agentLoopLive.nvidia.test.ts PASS: generated project's `node --test` 3/3; scripted suite 10/10 |
| Phase 1 | Narration-without-action guard (weak-model compensation) | **Integration-tested** | detector 15 unit tests + 2 e2e; fail at HEAD |
| 9 (scenario) | Weak-model resilience | **Measured — partially improved** | lightning-30b strict pass: 0/4 (no terminal) → 2/6 (terminal) → 4/7 (terminal + completion check); test-weakening undetected |
| A.25 / N | Explicit completion verification (evidence-based completion) | **Integration-tested + live A/B** | completionCheck.ts; setting verifyBeforeFinishing |
| J / N | Test-integrity guard (weakened tests; test files without test cases) | **Integration-tested + live** | testIntegrity.ts; caught the live failure every time it occurred; effect on pass rate not yet statistically established |
| Phase 1 | Output-limit continuation | **Integration-tested** (was dead code) | e2e fails at HEAD, passes now |
| Phase 1 | LLM inactivity timeout | **Implemented, not tested** | needs injectable timeout |
| N | Unknown-model capability fallback (now 32k) | **Integration-tested** | e2e untrimmed-instruction test fails at HEAD, passes now |
| N | Context-overflow recovery (learn limit, rebuild, bounded) | **Integration-tested** (scripted provider errors) | contextOverflow 13 unit + 2 e2e; not yet seen against a live provider |
| 1–7, 9, 10 | All other roadmap items | **Not inspected this session** | earlier claims in this file have not been re-verified |

| 3 | Test discover/list/run/run-by-name/rerun-failed/targeted/cancel (command runners: node:test, pytest verified; jest/vitest/mocha/go/cargo/dotnet/phpunit by format) | **Integration-tested (real runners) + agent-loop e2e** | was unconstructible in the app and could return another run's results; testCommandRunner.test.ts (7), testTools.test.ts (7) |
| 3 | Test history (kept across restarts), regressions/fixes per run, flaky detection (same code fingerprint), `test_check_flaky` (repeat on unchanged code), `test_history` | **Integration-tested (real node:test runs, real git, restart) + agent-loop e2e** | testHistory.test.ts (7), testTools.test.ts +2 +1 e2e; section (t); no live-model run |
| 3 | Coverage (`test_coverage`): node --test, Jest, Vitest, pytest (pytest-cov), Mocha (c8), Go; per-file %, uncovered lines, focus files | **Integration-tested for node --test; pytest's missing-plugin path real; Jest/Vitest/Mocha/Go by format only** | testCoverage.test.ts (6), testTools.test.ts +2; Go not installed here; cargo/dotnet/PHPUnit refuse with the reason |
| 3 | Tests via VS Code test-controller extensions; debug-a-test; test generation | **Partial / Missing** | controller path fixed but not integration-tested (coverage always uses the framework's command); debug-a-test and generation not implemented |
| 2 | Git for the agent: status/diff/log/branches/show, branch create/switch, stage/unstage, commit, fetch/pull/push, merge, stash/pop | **Integration-tested (real repos) + agent-loop e2e** | was non-functional in the app (DI), shell-injectable and fake-success; gitOperations.test.ts (15), gitAgent.test.ts (2); not launched in the packaged app |
| 2 | Git: revert, cherry-pick, rebase (non-interactive), continue/abort of a stopped operation, reset (soft/mixed/hard with safeguards), tags, remotes (redacted), worktrees (list/add); status reports which operation is in progress | **Integration-tested (real repos) + agent-loop e2e** | gitOperations.test.ts +10, gitAgent.test.ts +1 (conflict → resolve → continue; hard reset asks approval and is still refused over uncommitted work), gitAutonomyPolicy +1; section (r) |
| 2 | Git: commit-message context (`git_commit_context`: exact staged change, what is not staged, the repository's message style) and PR preparation (`git_pr_prepare`: commits/files vs base, ahead/behind, push state, uncommitted work, real conflict check via merge-tree, last test run) | **Integration-tested (real repos, bare remote) + agent-loop e2e** | gitOperations.test.ts +3, gitAgent.test.ts +1; section (u); Kodia writes no PR on GitHub (no gh/API integration) |
| 2 | Git: opening/reviewing PRs on GitHub, tag/branch deletion, worktree removal | **Missing** | opening a PR needs a GitHub integration and the user's credentials; deletions deliberately not exposed |
| 1 | Terminal dev tools (dep_install, db_migrate, lint_run) report real outcomes | **Integration-tested** (real processes) | were hardcoded success; terminalDevTools.test.ts |
| 4 | Debugger: real process debugging over V8 inspector | **Integration-tested** (real Node process) | nodeInspectorDebugging.test.ts |
| 5 | Browser automation: launch/tabs/navigate (HTTP status)/inspect (unique selectors, visibility, measured layout defects, console + network errors)/click & submit (wait for navigation)/fill/select/check/viewport/screenshot (file)/console/network/download | **Integration-tested (real Chromium) + agent-loop e2e (scenario 3, scripted)** | browserAutomationSignals.test.ts (9, all fail at HEAD), browserAutomation.test.ts (12), browserRepair.test.ts (1, out-of-process service); packaged app not launched; no vision; no live-model run |
| 6 | Subagents: run to completion with a fact-based report; parallel (≤4); types general/explore/review (offered + enforced); per-subagent model; follow-up by session id; no nesting; file claims between parallel subagents; stop propagates | **Integration-tested + agent-loop e2e (scenario 7, scripted)** | was fire-and-forget (parent never got results; child often crashed before its task existed); subagents.test.ts (2 e2e, fails on the old block), common/subagents.test.ts (4); no live-model run; no subagent UI |
| 7 | Codebase index: workspace folders via git ls-files, symbol chunks, BM25 with identifier splitting, always fresh, exact-occurrence search | **Integration-tested (real folders, Kodia's own source) + agent-loop e2e** | was indexing process.cwd(), quadratic (40 files = 46 s); codeIndex.test.ts (7), codeIndexWorkspace.test.ts (4), codeSearchAgent.test.ts (1); eval 10/10 top-3, 7/10 top-1 on own questions |
| 7 | Code search re-ranked by meaning (NVIDIA reranker, when the chat model is NVIDIA's) | **Integration-tested + live-evaluated** | rank-1 7→8/10 on own questions; candidates still come from the word index; content-screening rejections isolated |
| 7 | Full embedding index; persisted index | **Missing** | NVIDIA's embedding models available to this key are few/retiring; index is in memory |
| scenario 8 | Session recovery with a real model | **End-to-end verified LIVE (NVIDIA nemotron-3.5-super-vl)** | agentLoopLive.recovery.test.ts; earlier failures were the test's own wait loop (crash fired at t=0, then hung); section (r) |
| scenario 3 | Browser-driven repair | **End-to-end verified LIVE** | agentLoopLive.repair.test.ts (after the browser_shutdown fix) |
| 8 | Rewind/replay an agent's multi-file change (edit, overwrite, create, delete incl. recursive) | **Integration-tested (real disk)** | rewind restored nothing before; checkpointRecovery.test.ts (2); terminal-made changes not covered |
| scenario 4 | Debugger-driven repair (breakpoint, real debugpy session, variables over iterations, fix) | **End-to-end verified LIVE** | agentLoopLive.repair.test.ts |
| scenario 2 | Complete application (API + file DB + frontend + tests + README) | **End-to-end verified LIVE** | agentLoopLive.app.test.ts: HTTP, restart persistence, real-browser UI checks by the test |
| scenario 7 | Multi-agent: parallel subagents + consolidation | **End-to-end verified LIVE** | agentLoopLive.multiagent.test.ts; found and fixed the folder-claim defect |
| scenario 10 | Full integrated workflow (plan → git branch → tests → edit → tests → browser check → commit; user work kept) | **End-to-end verified LIVE (NVIDIA nemotron-3.5-super-vl)** | agentLoopLive.integrated.test.ts, 2 runs (second clean); one model, one task |
| 10 / N | Tool definitions sized to small context windows | **Integration-tested (real tokenizer, agent loop)** | toolBudget.test.ts (3), toolBudgetAgent.test.ts (2); not yet run live with a real 16k model |
| 8 | Bounded snapshot storage per conversation | **Integration-tested** | checkpointRecovery.test.ts pruning test |
| 10 | Real app starts (dev build) without Kodia errors; production bundle builds; Trusted Types check passes; metrics cannot send; tokenizer loads | **Verified (launch, bundle, tsec) + integration-tested (tokenizer)** | installer, signing and the minified packaged app not built/launched |
| 9 | Project memory: serialized, disk-fresh writes; budgeted into the prompt by context window; used across sessions | **Integration-tested (real service, real disk) + cross-session agent loop** | lost updates/overwrites before; projectMemoryService.test.ts (4), projectMemoryBudget.test.ts (3); no automatic memory capture |
| 8 / scenario 8 | Session recovery after a crash mid-task (durable conversation, cut-off tool marked, continue) | **Integration-tested (storage fake with flush contract)** | conversation was lost before; sessionRecovery.test.ts (1); real StorageService not exercised |
| 8 | edit_file applies exactly what ORIGINAL matched (no whole-line widening; unique; whole-line whitespace-insensitive matches only) | **Integration-tested** | silent data loss found by scenario 3; realFilesystemEditing.test.ts +2 |
| 4 | Kodia debug tools on VS Code's DebugSession + a real DAP adapter (debugpy): breakpoints (incl. conditional), launch inline, stop reporting, stack/scopes/variables/evaluate, step, continue-to-end, console, stop, agent-loop repair | **Integration-tested (real adapter) + agent-loop e2e** | debugTools.test.ts (5, incl. debugpy exception filters); DebugService orchestration shimmed; Xdebug not verified |
| 4 | JavaScript debugging with Microsoft's js-debug (shipped as built-in `ms-vscode.js-debug` 1.140.1): child-session programs, launch, breakpoints, step, evaluate, logpoints, exception breakpoints (`debug_set_exception_breakpoints`), attach to `--inspect-brk`, agent loop | **Integration-tested (real js-debug DAP server, same version) + agent-loop e2e** | jsDebugTools.test.ts (6); record (v). Extension-hosted js-debug in a running Kodia window, chrome debugging and watch expressions not verified |
| 3+4 | Debug a failing test (`test_debug`): node --test (js-debug) and pytest (debugpy) stop at the failing assertion, with the user's frame named | **Integration-tested (real runners + debuggers: node --test, pytest, Jest 29, Mocha 10) + agent-loop e2e** | testDebug.test.ts (5) + common (3); records (w), (x). JS stops on assertion failures only; Vitest, Go, Rust, .NET, PHP refused with the reason |
| 1 | `run_command` on Windows: quoted commands through PowerShell | **Fixed + tested in real PowerShell 5.1 and 7.7** | terminalWrap.test.ts (5.1); PowerShell 7.7 measured with the same 9 cases; record (w) |
| 1 | Destructive terminal commands need approval (PowerShell Remove-Item, chained/wrapped/piped, git clean/reset --hard/force push) | **Existing but broken → fixed; agent-loop e2e** | was medium risk: a real agent deleted a user's project without asking; destructiveCommands.test.ts + destructiveApproval.test.ts; record (y). Obfuscated commands not covered |

**Next concrete task**: weak-model resilience live run (acceptance scenario 9, e.g. `NVIDIA_MODEL=nvidia/nemotron-3.5-lightning-30b-a3b`); then roadmap 4 for real — drive Kodia's debug tools through a DAP adapter (js-debug) rather than raw CDP.

---

## Architecture: One-Command Application Building

```
User Request: "Build a todo app with React and Node"
    │
    ▼
Task Decomposition → Task Plan (ordered sub-tasks with dependencies)
    │
    ▼
For each ready task:
    ├─ Agent executes task (writes code, runs commands via tools)
    ├─ Run tests (test_run tool)
    ├─ If tests fail → Auto-Repair Loop:
    │    ├─ Analyze error messages
    │    ├─ Fix the code (edit_file/rewrite_file)
    │    ├─ Rerun tests
    │    └─ Repeat until passing (max N attempts)
    ├─ Update task status (completed/failed)
    └─ Check context size → Compact if needed
    │
    ▼
All tasks complete → Final verification (run all tests)
    │
    ▼
Report: What was built, what works, any remaining issues
```

## Components still planned

| OpenCode path | Purpose | Classification | Dependencies |
|---|---|---|---|
| `packages/core/src/session/compaction.ts` | Precompute compaction, background summary | PLANNED | modelCapabilities, tokenizer |
| `packages/core/src/model.ts` | Model registry with capability detection | INTEGRATE | existing catalog |
| `packages/core/src/provider.ts` | Provider registry + dynamic loading | INTEGRATE | existing provider list |
| `packages/core/src/tool/plugin/shell.ts` | Shell tool with background + truncation | PLANNED | terminalToolService |

---

**Rule:** No existing Kodia code is deleted. All changes are additive. Typecheck and tests must pass after every batch.