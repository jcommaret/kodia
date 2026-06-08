# Mistral Agent in the Agent Host — Roadmap

## North star

A `MistralAgent` implementing `IAgent`, registered alongside the existing
`CopilotAgent` and `ClaudeAgent`, that drives **local, tool-using coding
sessions** backed by the Mistral API (`@mistralai/mistralai`). Users provide a
Mistral API key and get Devstral / Codestral / Mistral-large agents in the
Agents Window — with the agentic loop and all tool execution running **locally
in the agent host process**, editing the user's real workspace.

## The defining constraint (read this first)

Unlike `ClaudeAgent`, **there is no drop-in coding-agent SDK for Mistral.**

- `ClaudeAgent` delegates the entire agentic loop — the turn loop, tool
  execution (Bash/Read/Write/Edit), permission hooks, JSONL persistence,
  subagents, checkpoints — to `@anthropic-ai/claude-agent-sdk`. The
  `ClaudeAgent` class is *just* a bridge from that SDK to the `IAgent`
  protocol.
- There is **no** equivalent local coding-agent package for Mistral
  (`@mistralai/agents`, `@mistralai/agent`, `@mistralai/mistralai-agent` all
  404 on npm). So the **harness is hand-written**: we own the local tool
  executors (Bash/Read/Write/Edit), permission gating, and the mapping to
  protocol `SessionAction` / `Turn` shapes.

### Chosen foundation: the Conversations / Agents API (already in 1.15.1)

We do **not** build on raw `chat.complete`, and we do **not** bump the SDK.
The installed `@mistralai/mistralai@1.15.1` already exposes the
**Conversations / Agents API**, which is a materially better base for an
agentic loop than stateless completions:

- `beta.conversations.startStream` / `appendStream` / `getHistory` —
  **server-managed conversation state + history + resume**. We don't manage or
  persist the message history ourselves; we map a session URI ↔ a Mistral
  `conversation_id`.
- `FunctionTool` (`type: 'function'`) + `FunctionResultEntry`
  (`type: 'function.result'`, `toolCallId`, `result`) — **client-executed
  function calling**: the model emits a `function.call` event, we run the tool
  locally, and append a `function.result` entry. This is exactly an agent turn
  loop minus the local execution, which is our job.

**Why not bump to 2.2.5:** it's a major bump (breaking changes) and Void's
autocomplete already imports `MistralCore` + `fimComplete` from the 1.x SDK
(`workbench/contrib/void/electron-main/llmMessage/sendLLMMessage.impl.ts`).
Bumping risks regressing FIM autocomplete for zero benefit — the Conversations
API we need is already present in 1.15.1.

**Privacy tradeoff (accepted):** conversation content lives on Mistral's
servers (state is server-managed). This was chosen over the fully-local
`chat.complete` path for the large reduction in persistence/loop code.

We reuse the agent host's shared, SDK-agnostic infrastructure:

- `SessionPermissionManager` — auto-approval policy + permission state.
- `AgentHostTerminalManager` — shell/Bash execution.
- `IAgentHostGitService` — diffs, branch/worktree isolation.
- `IDiffComputeService` — line-level diffs for the edit UI.
- `ISessionDataService` — per-session persistence (the DB row).
- `AgentSideEffects` — routes our signals/actions into root + session state.

## Architecture (target)

```
┌──────────────────────────────────────────────────┐
│ MistralAgent (node utility process)               │
│   implements IAgent                               │
│  ┌─────────────────────────────────────────────┐ │
│  │ MistralAgentSession (one per session)        │ │
│  │  session URI ↔ Mistral conversation_id       │ │
│  │  • conversations.startStream/appendStream ───┼─┼──► api.mistral.ai
│  │    (tools = FunctionTool[])                   │ │   (server-managed
│  │  • on 'function.call' event:                  │ │    state + history)
│  │      permission gate ─► SessionPermission     │ │
│  │      execute locally ─► TerminalManager / FS  │ │
│  │      appendStream(FunctionResultEntry)        │ │
│  │  • map message/function events ─► AgentSignal │ │
│  │    (SessionAction/Turn)                       │ │
│  └─────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
                     │ AgentSignal
                     ▼
        AgentSideEffects ─► AgentHostStateManager ─► root/session state
                     │ (IPC, ProxyChannel)
                     ▼
   Agents Window (browser) — auto-registers session type `agent-host-mistral`
   from rootState.agents (no browser code needed; see
   agentHostChatContribution.ts:151 `_registerAgent`)
```

The browser side is **fully data-driven**: once `MistralAgent` appears in
`rootState.agents`, `agentHostChatContribution._registerAgent` auto-creates the
`agent-host-mistral` session type, model picker, list controller, and session
handler. No browser-side code is part of this roadmap.

## Gating

Opt-in, mirroring Claude's SDK-path gate:

- Setting `chat.agentHost.mistralAgent.apiKey` (workbench) →
  env var `VSCODE_AGENT_HOST_MISTRAL_API_KEY`, forwarded by
  `electronAgentHostStarter` + `nodeAgentHostStarter`.
- `agentHostMain` / `agentHostServerMain` register `MistralAgent` only when the
  env var is non-empty.

(The agent host is a separate node utility process and cannot read Void's
renderer-side `IVoidSettingsService`; the key must be plumbed through as a
setting/env var, exactly like the Claude SDK path.)

## Phases

Each phase lands as one reviewable unit and ends at a verifiable boundary.

### Phase 1 — Scaffold + registration + gating  ⟵ IN PROGRESS

A registered `IAgent` whose lifecycle methods are stubbed.

- `id: AgentProvider = 'mistral'` — the provider id IS the URI scheme
  (`mistral:/<uuid>`).
- Constants: `AgentHostMistralApiKeySettingId`,
  `AgentHostMistralApiKeyEnvVar` in `common/agentService.ts`.
- `getDescriptor()` — provider / displayName / description.
- `getProtectedResources()` — `[]` (key-based, not OAuth bearer).
- `authenticate(resource, token)` — store the Mistral API key.
- `models` observable — seeded with the known tool-capable Mistral model set
  (devstral, codestral, mistral-large/medium/small, magistral). Real
  `modelsList` fetch is Phase 2.
- All other `IAgent` methods stubbed with `throw new Error('TODO: Phase N')`.
- `onDidSessionProgress` emitter wired (fired in Phase 4).
- Register conditionally in `agentHostMain.ts` + `agentHostServerMain.ts`;
  forward the setting in both starters.

Exit criteria: a workbench client sees "Mistral" listed in the Agents Window,
can pick a Mistral model, but cannot yet send a message.

### Phase 2 — Mistral Conversations client + real model listing

- `IMistralApiService` wrapping `@mistralai/mistralai@1.15.1`:
  - `startConversationStream(params)` / `appendConversationStream(params)` —
    thin wrappers over `Mistral.beta.conversations.startStream` /
    `appendStream`, yielding the typed conversation event stream.
  - `getConversationHistory(conversationId)` — for restoration (Phase 6).
  - `models()` — over `modelsList`.
  - Lazy `Mistral` client construction (key from the gate / `authenticate`).
- `models` observable derived from `modelsList`, filtered to models that
  advertise `function_calling` capability.
- Unit tests with a mocked Mistral client.

Exit criteria: the picker reflects the user's real, tool-capable Mistral
models; the client can open a streamed conversation against a stub.

### Phase 3 — Session lifecycle

- `MistralAgentSession` (`node/mistral/mistralAgentSession.ts`), holding the
  session URI ↔ Mistral `conversation_id` binding.
- Provisional/materialize model (CONTEXT M9): `createSession` returns a URI
  synchronously, no network; the Mistral conversation is created lazily on the
  first `sendMessage` (`startStream`), which fires `onDidMaterializeSession`.
- Persist only the `(session URI → conversation_id, model, cwd)` mapping in
  `ISessionDataService` — the transcript itself lives server-side.
- `disposeSession`, `listSessions` (from the mapping rows), `shutdown`.
- `resolveSessionConfig` / `sessionConfigCompletions` — schema for model,
  mode, isolation, branch, working directory.

Exit criteria: sessions create/list/dispose; agent host shuts down cleanly.

### Phase 4 — Turn loop over Conversations API (single-turn, no tools)

- `sendMessage` → `startStream` (first turn, creates the conversation) or
  `appendStream` (subsequent turns) with the user input.
- Consume the conversation event stream: map `message.output` deltas (and
  reasoning/think deltas for magistral/devstral) to protocol assistant-message
  parts; emit `IAgentActionSignal`s on `onDidSessionProgress`; assemble
  `Turn`s.
- Per-session `AbortController`, request serialization. No local message
  history to keep — the conversation state is server-side.

Exit criteria: a user sends "hi" and sees a streamed assistant response.

### Phase 5 — Tool execution layer  ✓ DONE

The heart of the harness. `node/mistral/mistralTools.ts` + the multi-round
tool loop in `mistralAgent.ts` (`_consumeStream` + the round loop in
`_runTurn`).

- Declares `FunctionTool[]` on `startStream`: `read_file`, `write_file`,
  `list_dir`, `run_bash` (the model can shell out for grep/glob). Focused set;
  more tools are additive.
- Local executors use `fs.promises` + `child_process.exec`, scoped to the
  session working directory.
- Loop: on a `function.call.delta` event → emit `SessionToolCallStart` +
  `SessionToolCallReady` → execute locally → emit `SessionToolCallComplete` →
  `appendStream` a `FunctionResultEntry` (`type: 'function.result'`,
  `toolCallId`, `result`) → the server continues until the model stops calling
  tools (capped at `MAX_TOOL_ROUNDS = 50`).

Deferred to Phase 6 (mirrors how the Claude integration deferred its
permission UX): mutating tools (`write_file` / `run_bash`) are currently
**auto-approved** (`confirmed: NotNeeded`).

Exit criteria: "run a command" completes end-to-end and the tool result drives
a follow-up assistant message. ✓

### Phase 6 — Controls + interactive permissions  ✓ (mostly)

Done:
- **Interactive tool approval**: mutating tools (`write_file` / `run_bash`)
  emit `SessionToolCallStart` (registers the call with the host) then an
  `IAgentToolPendingConfirmationSignal`; the host applies its auto-approval /
  session `AutoApprove` policy and otherwise prompts the client, and the
  verdict returns via `respondToPermissionRequest(toolCallId, approved)`
  (resolved through `_pendingPermissions` / `_awaitPermission`). Read-only
  tools stay auto-confirmed. Denials feed a "denied" `function.result` back to
  the model.
- `abortSession` aborts the session's turn controller (unblocks the stream
  *and* any pending approval wait → clean `SessionTurnComplete`).
- `changeModel` updates the model on the provisional record or live session
  (and persists it).
- `respondToUserInputRequest` is a no-op (the toolset uses no `ask_user`).
- `getSessionMessages` returns `[]` gracefully (no throw on reopen).

Remaining follow-ups:
- **Transcript restoration**: map `conversations.getHistory(conversationId)`
  entries → protocol `Turn`s in `getSessionMessages`, and surface
  previous-lifetime sessions in `listSessions`.
- **File-edit tracking**: `resourceRead`/`resourceWrite` +
  `IDiffComputeService` so `write_file` renders a diff with accept/reject.
- `setPendingMessages` (steering via mid-turn `appendStream`).
- `truncateSession`, `onArchivedChanged` (worktree cleanup) if isolation lands.

Exit criteria: parity with the Claude agent on stop / steer / switch-model /
reload-old-chat.

## Out of scope (follow-ups)

- Client-provided tools (in-process MCP) — Claude Phase 10 analog.
- Host customizations (CLAUDE.md-style instructions, slash commands, skills).
- Subagents.
- Checkpoints beyond per-file accept/reject.
- MCP server integration.

## Reference implementations

- `node/claude/claudeAgent.ts` — closest `IAgent` reference (provisional/
  materialize, sequencers, descriptor, models observable, shutdown memoization).
- `node/copilot/copilotAgent.ts` — second `IAgent` reference; richer
  ExitPlanMode shape, fork via `getNextTurnEventId`.
- `node/copilot/fileEditTracker.ts` — file edit tracking pattern (Phase 5).
- `node/agentSideEffects.ts` + `SessionPermissionManager` — host-side glue we
  reuse rather than reimplement.
- Void's own `chatMode: 'agent'` sidebar flow
  (`workbench/contrib/void/`) — reference for tool schemas and the
  Mistral OpenAI-style tool-calling format we already exercise in
  `sendLLMMessage.impl.ts`.
