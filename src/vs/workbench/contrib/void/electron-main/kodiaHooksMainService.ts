/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Main-process execution backend for Kodia Lifecycle Hooks (Mandate Part 3M).
 * Discovers project hooks from `.kodia/hooks.json` and `.claude/settings(.local).json`,
 * runs matching commands with strict timeouts and JSON stdin payloads, and keeps an audit log.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Disposable } from '../../../../base/common/lifecycle.js';
import {
	IKodiaHooksMainService,
	KodiaHookDefinition,
	KodiaHookExecutionEntry,
	KodiaHookPayload,
	KodiaHookRunResult,
	matchesHookMatcher,
	parseHooksConfig,
	parseHookOutput,
} from '../common/kodiaHooks.js';

const HOOK_CONFIG_RELATIVE_PATHS = [
	'.kodia/hooks.json',
	'.claude/settings.json',
	'.claude/settings.local.json',
] as const;

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_AUDIT_LOG = 200;

export class KodiaHooksMainService extends Disposable implements IKodiaHooksMainService {
	readonly _serviceBrand: undefined;

	private readonly _auditLog: KodiaHookExecutionEntry[] = [];

	private _discoverHooks(workspaceFolders: readonly string[]): KodiaHookDefinition[] {
		const defs: KodiaHookDefinition[] = [];
		for (const folder of workspaceFolders) {
			if (!folder) { continue; }
			for (const rel of HOOK_CONFIG_RELATIVE_PATHS) {
				const full = path.join(folder, rel);
				try {
					if (!fs.existsSync(full)) { continue; }
					const stat = fs.statSync(full);
					if (!stat.isFile() || stat.size > 512 * 1024) { continue; }
					const content = fs.readFileSync(full, 'utf8');
					defs.push(...parseHooksConfig(content, full));
				} catch {
					// Ignore unreadable config file
				}
			}
		}
		return defs;
	}

	async listConfiguredHooks(workspaceFolders: string[]): Promise<KodiaHookDefinition[]> {
		return this._discoverHooks(workspaceFolders);
	}

	async getAuditLog(limit = 50): Promise<KodiaHookExecutionEntry[]> {
		const n = Math.max(1, Math.min(MAX_AUDIT_LOG, limit));
		return this._auditLog.slice(-n);
	}

	async runHooks(workspaceFolders: string[], payload: KodiaHookPayload): Promise<KodiaHookRunResult> {
		const allHooks = this._discoverHooks(workspaceFolders);
		const target = payload.toolName ?? payload.agentType ?? payload.taskTitle;
		const matching = allHooks.filter(h =>
			h.enabled
			&& h.event === payload.event
			&& matchesHookMatcher(h.matcher, target)
		);

		if (matching.length === 0) {
			return { decision: 'allow', systemMessages: [], entries: [] };
		}

		const cwd = payload.workspaceDir || workspaceFolders[0] || process.cwd();
		const entries: KodiaHookExecutionEntry[] = [];
		const systemMessages: string[] = [];
		let finalDecision: 'allow' | 'block' | 'ask' = 'allow';
		let finalReason: string | undefined;
		let updatedInput = payload.toolInput ? { ...payload.toolInput } : undefined;

		for (const hook of matching) {
			const effectivePayload: KodiaHookPayload = updatedInput
				? { ...payload, toolInput: updatedInput }
				: payload;

			const entry = await this._executeSingleHook(hook, cwd, effectivePayload);
			entries.push(entry);
			this._recordAudit(entry);

			if (entry.systemMessage) {
				systemMessages.push(entry.systemMessage);
			}
			if (entry.updatedInput && payload.event === 'PreToolUse') {
				updatedInput = { ...(updatedInput ?? {}), ...entry.updatedInput };
			}
			if (entry.decision === 'block') {
				finalDecision = 'block';
				finalReason = entry.reason || `Blocked by ${hook.event} hook`;
				break; // stop remaining hooks once blocked
			}
			if (entry.decision === 'ask' && finalDecision === 'allow') {
				finalDecision = 'ask';
				finalReason = entry.reason || `Hook requested confirmation for ${hook.event}`;
			}
		}

		return {
			decision: finalDecision,
			reason: finalReason,
			systemMessages,
			updatedInput: updatedInput && payload.toolInput && JSON.stringify(updatedInput) !== JSON.stringify(payload.toolInput) ? updatedInput : undefined,
			entries,
		};
	}

	private _recordAudit(entry: KodiaHookExecutionEntry): void {
		this._auditLog.push(entry);
		while (this._auditLog.length > MAX_AUDIT_LOG) {
			this._auditLog.shift();
		}
	}

	private _executeSingleHook(hook: KodiaHookDefinition, cwd: string, payload: KodiaHookPayload): Promise<KodiaHookExecutionEntry> {
		const startedAt = Date.now();
		return new Promise<KodiaHookExecutionEntry>(resolve => {
			let stdout = '';
			let stderr = '';
			let timedOut = false;
			let settled = false;

			const env: NodeJS.ProcessEnv = {
				...process.env,
				KODIA_HOOK_EVENT: payload.event,
				KODIA_THREAD_ID: payload.threadId,
				KODIA_WORKSPACE_DIR: cwd,
				...(payload.toolName ? { KODIA_TOOL_NAME: payload.toolName } : {}),
				...(payload.agentType ? { KODIA_AGENT_TYPE: payload.agentType } : {}),
			};

			let child: cp.ChildProcess;
			try {
				child = cp.spawn(hook.command, {
					cwd,
					shell: true,
					env,
					windowsHide: true,
					stdio: ['pipe', 'pipe', 'pipe'],
				});
			} catch (err) {
				resolve({
					event: hook.event,
					command: hook.command,
					sourcePath: hook.sourcePath,
					matcher: hook.matcher,
					decision: 'allow',
					exitCode: null,
					durationMs: Date.now() - startedAt,
					timedOut: false,
					error: err instanceof Error ? err.message : String(err),
					timestamp: new Date().toISOString(),
				});
				return;
			}

			const finish = (exitCode: number | null, spawnError?: string) => {
				if (settled) { return; }
				settled = true;
				clearTimeout(timer);
				const interpreted = spawnError
					? { decision: 'allow' as const, error: spawnError }
					: parseHookOutput(exitCode, stdout, stderr, timedOut);

				resolve({
					event: hook.event,
					command: hook.command,
					sourcePath: hook.sourcePath,
					matcher: hook.matcher,
					decision: interpreted.decision,
					reason: interpreted.reason,
					systemMessage: interpreted.systemMessage,
					updatedInput: interpreted.updatedInput,
					exitCode,
					durationMs: Math.max(0, Date.now() - startedAt),
					timedOut,
					error: interpreted.error,
					timestamp: new Date().toISOString(),
				});
			};

			const timer = setTimeout(() => {
				timedOut = true;
				try {
					child.stdin?.destroy();
					child.stdout?.destroy();
					child.stderr?.destroy();
					if (process.platform === 'win32' && child.pid) {
						cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 3000 });
					}
					child.kill('SIGKILL');
				} catch { /* ignore */ }
				finish(null);
			}, hook.timeoutMs);

			child.stdout?.on('data', (chunk: Buffer) => {
				if (stdout.length < MAX_OUTPUT_BYTES) {
					stdout += chunk.toString('utf8').slice(0, MAX_OUTPUT_BYTES - stdout.length);
				}
			});
			child.stderr?.on('data', (chunk: Buffer) => {
				if (stderr.length < MAX_OUTPUT_BYTES) {
					stderr += chunk.toString('utf8').slice(0, MAX_OUTPUT_BYTES - stderr.length);
				}
			});
			child.on('error', err => finish(null, err.message));
			child.on('close', code => finish(code));

			try {
				child.stdin?.write(JSON.stringify(payload));
				child.stdin?.end();
			} catch { /* ignore broken pipe */ }
		});
	}
}
