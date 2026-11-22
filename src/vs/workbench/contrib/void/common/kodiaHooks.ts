/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Kodia Lifecycle Hooks (Mandate Part 3M).
 *
 * Pure types, config parsing, matcher evaluation, and stdout/exit-code semantics shared
 * between the renderer (ChatThreadService) and the main-process hook runner.
 *
 * Supported config files (workspace-relative):
 *   - .kodia/hooks.json
 *   - .claude/settings.json / .claude/settings.local.json (Claude Code compatible `hooks` block)
 *
 * Execution semantics:
 *   - Hook receives JSON payload on stdin and environment variables:
 *     KODIA_HOOK_EVENT, KODIA_WORKSPACE_DIR, KODIA_THREAD_ID, KODIA_TOOL_NAME (when applicable).
 *   - Exit 0: allow (unless JSON stdout specifies `decision: "block" | "deny" | "ask"` or `continue: false`).
 *     JSON stdout may also provide `systemMessage`, `reason`, and `updatedInput` (for PreToolUse).
 *   - Exit 2: block the operation; stderr (or stdout) is surfaced as the block reason.
 *   - Any other non-zero exit: logged as a non-blocking hook error (does not deadlock the agent).
 */

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const KODIA_HOOKS_CHANNEL = 'void-channel-hooks';

export const KODIA_HOOK_EVENTS = [
	'SessionStart',
	'UserPromptSubmit',
	'PreToolUse',
	'PermissionRequest',
	'PostToolUse',
	'PostToolUseFailure',
	'Notification',
	'Stop',
	'SubagentStart',
	'SubagentStop',
	'TaskCompleted',
	'CheckpointCreate',
	'ConfigChange',
	'WorktreeCreate',
	'WorktreeRemove',
	'SessionEnd',
] as const;

export type KodiaHookEvent = typeof KODIA_HOOK_EVENTS[number];

export const KODIA_HOOK_EVENT_SET: ReadonlySet<string> = new Set(KODIA_HOOK_EVENTS);

export interface KodiaHookDefinition {
	readonly event: KodiaHookEvent;
	readonly command: string;
	readonly matcher?: string;
	readonly timeoutMs: number;
	readonly enabled: boolean;
	readonly description?: string;
	readonly sourcePath?: string;
}

export interface KodiaHookPayload {
	readonly event: KodiaHookEvent;
	readonly threadId: string;
	readonly workspaceDir?: string;
	readonly timestamp: string;
	readonly toolName?: string;
	readonly toolCallId?: string;
	readonly toolInput?: Record<string, unknown>;
	readonly toolResult?: string;
	readonly toolError?: string;
	readonly userPrompt?: string;
	readonly agentType?: string;
	readonly subagentSessionId?: string;
	readonly taskId?: string;
	readonly taskTitle?: string;
	readonly message?: string;
	readonly worktreePath?: string;
}

export type KodiaHookDecision = 'allow' | 'block' | 'ask';

export interface KodiaHookExecutionEntry {
	readonly event: KodiaHookEvent;
	readonly command: string;
	readonly sourcePath?: string;
	readonly matcher?: string;
	readonly decision: KodiaHookDecision;
	readonly reason?: string;
	readonly systemMessage?: string;
	readonly updatedInput?: Record<string, unknown>;
	readonly exitCode: number | null;
	readonly durationMs: number;
	readonly timedOut: boolean;
	readonly error?: string;
	readonly timestamp: string;
}

export interface KodiaHookRunResult {
	readonly decision: KodiaHookDecision;
	readonly reason?: string;
	readonly systemMessages: string[];
	readonly updatedInput?: Record<string, unknown>;
	readonly entries: KodiaHookExecutionEntry[];
}

export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;
export const MAX_HOOK_TIMEOUT_MS = 60_000;

export const IKodiaHooksMainService = createDecorator<IKodiaHooksMainService>('kodiaHooksMainService');

export interface IKodiaHooksMainService {
	readonly _serviceBrand: undefined;
	runHooks(workspaceFolders: string[], payload: KodiaHookPayload): Promise<KodiaHookRunResult>;
	listConfiguredHooks(workspaceFolders: string[]): Promise<KodiaHookDefinition[]>;
	getAuditLog(limit?: number): Promise<KodiaHookExecutionEntry[]>;
}

/**
 * Clamp timeout to safe bounds [500ms, 60_000ms].
 */
export function normalizeHookTimeout(timeoutMs: unknown): number {
	const n = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_HOOK_TIMEOUT_MS;
	return Math.max(500, Math.min(MAX_HOOK_TIMEOUT_MS, Math.round(n)));
}

/**
 * Parse hooks from either Kodia `.kodia/hooks.json` or Claude Code `.claude/settings.json`.
 *
 * Format A (Kodia flat):
 *   { "hooks": { "PreToolUse": [{ "matcher": "edit_file|write_file", "command": "...", "timeoutMs": 5000 }] } }
 *
 * Format B (Claude Code nested):
 *   { "hooks": { "PreToolUse": [{ "matcher": "Edit", "hooks": [{ "type": "command", "command": "...", "timeout": 10 }] }] } }
 */
export function parseHooksConfig(rawJson: string, sourcePath?: string): KodiaHookDefinition[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawJson);
	} catch {
		return [];
	}
	if (!parsed || typeof parsed !== 'object') { return []; }
	const root = parsed as Record<string, unknown>;
	const hooksObj = (root.hooks && typeof root.hooks === 'object' ? root.hooks : root) as Record<string, unknown>;

	const out: KodiaHookDefinition[] = [];
	for (const [eventKey, rawList] of Object.entries(hooksObj)) {
		if (!KODIA_HOOK_EVENT_SET.has(eventKey) || !Array.isArray(rawList)) { continue; }
		const event = eventKey as KodiaHookEvent;

		for (const item of rawList) {
			if (!item || typeof item !== 'object') { continue; }
			const entry = item as Record<string, unknown>;
			const matcher = typeof entry.matcher === 'string' && entry.matcher.trim() ? entry.matcher.trim() : undefined;

			// Format B: nested `hooks: [{ type: 'command', command, timeout }]`
			if (Array.isArray(entry.hooks)) {
				for (const sub of entry.hooks) {
					if (!sub || typeof sub !== 'object') { continue; }
					const s = sub as Record<string, unknown>;
					if (s.type && s.type !== 'command') { continue; }
					if (typeof s.command !== 'string' || !s.command.trim()) { continue; }
					const timeoutMs = typeof s.timeoutMs === 'number'
						? normalizeHookTimeout(s.timeoutMs)
						: typeof s.timeout === 'number'
							? normalizeHookTimeout(s.timeout * 1000)
							: DEFAULT_HOOK_TIMEOUT_MS;
					out.push({
						event,
						command: s.command.trim(),
						matcher,
						timeoutMs,
						enabled: s.enabled !== false && entry.enabled !== false,
						description: typeof s.description === 'string' ? s.description : typeof entry.description === 'string' ? entry.description : undefined,
						sourcePath,
					});
				}
				continue;
			}

			// Format A: flat `{ command, matcher?, timeoutMs?, enabled?, description? }`
			if (typeof entry.command === 'string' && entry.command.trim()) {
				const timeoutMs = typeof entry.timeoutMs === 'number'
					? normalizeHookTimeout(entry.timeoutMs)
					: typeof entry.timeout === 'number'
						? normalizeHookTimeout(entry.timeout * 1000)
						: DEFAULT_HOOK_TIMEOUT_MS;
				out.push({
					event,
					command: entry.command.trim(),
					matcher,
					timeoutMs,
					enabled: entry.enabled !== false,
					description: typeof entry.description === 'string' ? entry.description : undefined,
					sourcePath,
				});
			}
		}
	}
	return out;
}

/**
 * Evaluate whether a hook's matcher applies to `target` (e.g. tool name or agent type).
 * No matcher or "*" matches everything. Supports pipe-separated literals and JS RegExp.
 */
export function matchesHookMatcher(matcher: string | undefined, target: string | undefined): boolean {
	if (!matcher || matcher === '*' || matcher === '.*') { return true; }
	if (!target) { return false; }
	if (matcher.length > 256) { return false; }

	// Fast exact or pipe-separated literal match
	if (/^[a-zA-Z0-9_|.-]+$/.test(matcher)) {
		const parts = matcher.split('|');
		return parts.includes(target);
	}

	try {
		return new RegExp(matcher).test(target);
	} catch {
		return matcher === target;
	}
}

/**
 * Interpret a hook process's exit code and output according to Kodia/Claude Code hook semantics.
 */
export function parseHookOutput(
	exitCode: number | null,
	stdout: string,
	stderr: string,
	timedOut: boolean,
): { decision: KodiaHookDecision; reason?: string; systemMessage?: string; updatedInput?: Record<string, unknown>; error?: string } {
	if (timedOut) {
		return { decision: 'allow', error: 'Hook timed out and was terminated' };
	}

	const trimmedOut = stdout.trim();
	const trimmedErr = stderr.trim();

	// Exit code 2 explicitly blocks the action
	if (exitCode === 2) {
		return {
			decision: 'block',
			reason: trimmedErr || trimmedOut || 'Blocked by lifecycle hook (exit code 2)',
		};
	}

	// Non-zero exit (other than 2) is a non-blocking hook error
	if (exitCode !== 0) {
		return {
			decision: 'allow',
			error: trimmedErr || trimmedOut || `Hook exited with code ${exitCode ?? 'unknown'}`,
		};
	}

	// Exit 0: optionally parse structured JSON output
	if (trimmedOut.startsWith('{') && trimmedOut.endsWith('}')) {
		try {
			const obj = JSON.parse(trimmedOut) as Record<string, unknown>;
			let decision: KodiaHookDecision = 'allow';
			if (obj.continue === false || obj.decision === 'block' || obj.decision === 'deny') {
				decision = 'block';
			} else if (obj.decision === 'ask') {
				decision = 'ask';
			}
			const reason = typeof obj.reason === 'string'
				? obj.reason
				: typeof obj.stopReason === 'string'
					? obj.stopReason
					: undefined;
			const systemMessage = typeof obj.systemMessage === 'string'
				? obj.systemMessage
				: typeof obj.additionalContext === 'string'
					? obj.additionalContext
					: undefined;
			const updatedInput = obj.updatedInput && typeof obj.updatedInput === 'object' && !Array.isArray(obj.updatedInput)
				? obj.updatedInput as Record<string, unknown>
				: undefined;
			return { decision, reason, systemMessage, updatedInput };
		} catch {
			// Plain text stdout — treat as informational context if short
		}
	}

	return { decision: 'allow' };
}
