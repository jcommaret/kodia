/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * End-to-end integration tests for Kodia's extended agent platform through the REAL agent loop:
 *   - Custom slash commands (.kodia/commands/*.md) with $ARGUMENTS expansion
 *   - Real lifecycle hooks (.kodia/hooks.json via KodiaHooksMainService): PreToolUse blocking, PostToolUse context injection
 *   - Structured ExecutionObservabilityService spans & error classification
 *   - Custom agents (.kodia/agents/*.md) & specialist roles (security) running read-only in parallel
 *   - Task plan JSON-string parsing & persistence hydration across simulated restarts
 */

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { MarkerService } from '../../../../../platform/markers/common/markerService.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { CustomCommandsService } from '../../browser/customCommandsService.js';
import { KodiaWorkflowsService } from '../../browser/kodiaWorkflowsService.js';
import { VerificationLedgerService } from '../../browser/verificationLedgerService.js';
import { SoftwareFactoryService } from '../../browser/softwareFactoryService.js';
import { ExecutionObservabilityService } from '../../common/executionObservability.js';
import { KodiaHooksMainService } from '../../electron-main/kodiaHooksMainService.js';
import { createHarness, RecordedRequest, runTurn, ScriptedLLMService, ScriptStep } from './agentHarness.js';

suite('Kodia - Platform Integration (Hooks, Slash Commands, Custom Agents, Observability, Plan Hydration)', function () {
	this.timeout(60_000);

	let store: DisposableStore;
	let dir: string;
	const p = (rel: string) => path.join(dir, rel);

	setup(() => {
		store = new DisposableStore();
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-platform-')));
	});

	teardown(() => {
		store.dispose();
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	});

	test('custom /command expands for the model, PreToolUse hook blocks secret.env, PostToolUse appends note, observability tracks spans', async () => {
		fs.mkdirSync(p('.kodia/commands'), { recursive: true });
		fs.writeFileSync(p('.kodia/commands/scaffold.md'), [
			'---',
			'description: Scaffold a tiny module',
			'argument-hint: <moduleName>',
			'---',
			'Create module "$1" cleanly without touching secret.env.',
		].join('\n'));

		const guardScript = p('.kodia/guard.cjs');
		fs.writeFileSync(guardScript, `
			let data = '';
			process.stdin.on('data', c => data += c);
			process.stdin.on('end', () => {
				const payload = JSON.parse(data);
				if (payload.event === 'PreToolUse' && String(payload.toolInput?.uri || '').endsWith('secret.env')) {
					process.stderr.write('Protected secret.env cannot be written');
					process.exit(2);
				}
				if (payload.event === 'PostToolUse') {
					process.stdout.write(JSON.stringify({ decision: 'allow', systemMessage: 'post-hook-verified:' + payload.toolName }));
				}
			});
		`);
		fs.writeFileSync(p('.kodia/hooks.json'), JSON.stringify({
			hooks: {
				PreToolUse: [{ matcher: 'write_file', command: `node "${guardScript}"`, timeoutMs: 5000 }],
				PostToolUse: [{ matcher: 'write_file', command: `node "${guardScript}"`, timeoutMs: 5000 }],
			},
		}, null, 2));

		const hooks = store.add(new KodiaHooksMainService());
		const observability = store.add(new ExecutionObservabilityService());
		let step = 0;

		const llm = new ScriptedLLMService((_i, req: RecordedRequest): ScriptStep => {
			const payload = JSON.stringify(req.messages);
			switch (step++) {
				case 0:
					assert.match(payload, /Create module \\"hello-mod\\" cleanly/, 'custom /scaffold command expanded for the model');
					return {
						text: '',
						toolCalls: [{ name: 'write_file', params: { uri: p('secret.env'), new_content: 'API_KEY=bad' } }],
					};
				case 1:
					assert.match(payload, /Blocked by PreToolUse hook: Protected secret\.env cannot be written/, 'PreToolUse block message reached the model');
					return {
						text: '',
						toolCalls: [{ name: 'write_file', params: { uri: p('hello-mod.js'), new_content: 'export const ok = true;\n' } }],
					};
				default:
					assert.match(payload, /post-hook-verified:write_file/, 'PostToolUse hook note reached the model');
					return { text: 'Created hello-mod.js and respected the hook policy.' };
			}
		});

		const base = createHarness(dir, llm, store, {
			modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' },
			overridesOfModel: { openAICompatible: { 'kodia-scripted-model': { contextWindow: 128_000, specialToolFormat: 'openai-style' } } },
			globalSettings: { verifyBeforeFinishing: false },
			hooks,
			observability,
		});
		const customCommands = store.add(new CustomCommandsService(base.fileService, base.workspace));
		(base.chat as any)._customCommandsService = customCommands;

		const { threadId, messages } = await runTurn(base.chat, '/scaffold hello-mod', 30_000);
		assert.deepStrictEqual(llm.scriptErrors, []);
		assert.strictEqual(fs.existsSync(p('secret.env')), false, 'blocked file must never be created on disk');
		assert.strictEqual(fs.readFileSync(p('hello-mod.js'), 'utf8'), 'export const ok = true;\n');

		// User message keeps original slash command as displayContent
		const userMsg = messages.find(m => m.role === 'user');
		assert.strictEqual(userMsg?.displayContent, '/scaffold hello-mod');

		// Observability captured LLM turns, tool calls, and hooks
		const metrics = observability.getMetrics(threadId);
		assert.strictEqual(metrics.llmRequests, 3);
		assert.ok(metrics.toolCalls >= 1);
		assert.strictEqual(metrics.errorsByCategory.hook_blocked, 1);
	});

	test('custom .kodia/agents/auditor.md + specialist security role + task plan survives simulated restart', async () => {
		fs.mkdirSync(p('.kodia/agents'), { recursive: true });
		fs.writeFileSync(p('.kodia/agents/auditor.md'), [
			'---',
			'name: auditor',
			'description: Custom read-only SQL auditor',
			'readOnly: true',
			'---',
			'MARKER_CUSTOM_AUDITOR_GUIDANCE: Inspect queries only.',
		].join('\n'));
		fs.writeFileSync(p('query.js'), 'export const q = "SELECT * FROM users";\n');

		const storage = store.add(new InMemoryStorageService());
		let parentId = '';
		const stepOf = new Map<string, number>();
		const roleOf = new Map<string, string>();

		const llm1 = new ScriptedLLMService((_i, req: RecordedRequest): ScriptStep => {
			const payload = JSON.stringify(req.messages);
			const tid = req.threadId!;
			if (!roleOf.has(tid)) {
				roleOf.set(tid, tid === parentId ? 'P' : /CUSTOM-AUDIT/.test(payload) ? 'AUD' : 'SEC');
			}
			const role = roleOf.get(tid)!;
			const step = stepOf.get(tid) ?? 0;
			stepOf.set(tid, step + 1);

			if (role === 'P') {
				switch (step) {
					case 0:
						return {
							text: '',
							toolCalls: [{
								name: 'create_task_plan',
								params: {
									title: 'Security Audit',
									description: 'Run specialists',
									// JSON string format (as XML-tool models send)
									tasks: JSON.stringify([{ title: 'Audit SQL', description: 'Check query.js', dependencies: [], assignedAgent: 'auditor', priority: 'high' }]),
								},
							}],
						};
					case 1:
						assert.match(payload, /Audit SQL/);
						return {
							text: '',
							toolCalls: [
								{ name: 'subagent', params: { agent: 'auditor', description: 'custom sql audit', prompt: 'CUSTOM-AUDIT: inspect query.js' } },
								{ name: 'subagent', params: { agent: 'security', description: 'security check', prompt: 'SEC-CHECK: inspect query.js' } },
							],
						};
					default:
						assert.match(payload, /custom sql audit/);
						assert.match(payload, /security check/);
						assert.match(payload, /A \\"auditor\\" subagent cannot use write_file/);
						return { text: 'Audit complete.' };
				}
			}
			if (role === 'AUD') {
				if (step === 0) {
					assert.match(req.separateSystemMessage ?? payload, /MARKER_CUSTOM_AUDITOR_GUIDANCE/);
					assert.ok(!req.tools?.includes('write_file'), 'custom read-only agent is not offered write_file');
					return { text: '', toolCalls: [{ name: 'write_file', params: { uri: p('hacked.js'), new_content: 'nope' } }] };
				}
				return { text: 'Read-only auditor finished.' };
			}
			// SEC specialist
			assert.ok(!req.tools?.includes('edit_file'), 'security specialist is read-only');
			return { text: 'Security specialist finished.' };
		});

		const h1 = createHarness(dir, llm1, store, {
			storage,
			modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' },
			overridesOfModel: { openAICompatible: { 'kodia-scripted-model': { contextWindow: 128_000, specialToolFormat: 'openai-style' } } },
			modelOptions: [{ name: 'kodia-scripted-model', selection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' } }],
			globalSettings: { verifyBeforeFinishing: false },
		});
		parentId = h1.chat.state.currentThreadId;
		await runTurn(h1.chat, 'Create a plan and audit query.js', 30_000);
		assert.deepStrictEqual(llm1.scriptErrors, []);
		assert.strictEqual(fs.existsSync(p('hacked.js')), false, 'read-only custom agent cannot write files');

		const savedTaskId = h1.taskPlanService.getPlan(parentId)!.tasks[0].id;
		assert.ok(savedTaskId);

		// Simulate application restart: brand new ChatThreadService + brand new TaskPlanService sharing storage
		let step2 = 0;
		const llm2 = new ScriptedLLMService((_i, req: RecordedRequest): ScriptStep => {
			const payload = JSON.stringify(req.messages);
			if (step2++ === 0) {
				return {
					text: '',
					toolCalls: [{ name: 'update_task_plan', params: { task_id: savedTaskId, status: 'completed', result: 'Verified after restart' } }],
				};
			}
			assert.match(payload, /\[completed\]/);
			assert.match(payload, /Verified after restart/);
			return { text: 'Updated task plan after restart.' };
		});

		const h2 = createHarness(dir, llm2, store, {
			storage,
			modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' },
			overridesOfModel: { openAICompatible: { 'kodia-scripted-model': { contextWindow: 128_000, specialToolFormat: 'openai-style' } } },
			globalSettings: { verifyBeforeFinishing: false },
		});
		h2.chat.switchToThread(parentId);
		assert.ok(h2.taskPlanService.getPlan(parentId), 'TaskPlanService hydrated persisted plan on startup');

		await runTurn(h2.chat, 'Mark the audit task completed.', 30_000);
		assert.deepStrictEqual(llm2.scriptErrors, []);
		assert.strictEqual(h2.taskPlanService.getPlan(parentId)!.overallStatus, 'completed');
	});

	test('project_health_scan + architecture_map run through ToolsService on real files and redact secrets; queued steering message auto-dispatches', async () => {
		const fakeAws = 'AKIA' + '9876543210FEDCBA';
		fs.mkdirSync(p('src'), { recursive: true });
		fs.writeFileSync(p('package.json'), JSON.stringify({ name: 'demo', dependencies: { react: '^18.2.0' } }));
		fs.writeFileSync(p('src/a.ts'), `import { b } from './b.js';\nexport const a = () => b();\n`);
		fs.writeFileSync(p('src/b.ts'), `import { a } from './a.js';\nexport const secret = "${fakeAws}";\nexport const b = () => a();\n`);

		let step = 0;
		let enqueuedDuringTurn1 = false;
		let resolveQueueReady!: () => void;
		const turn1Started = new Promise<void>(r => { resolveQueueReady = r; });

		const llm = new ScriptedLLMService((_i, req: RecordedRequest): ScriptStep => {
			const payload = JSON.stringify(req.messages);
			switch (step++) {
				case 0:
					resolveQueueReady();
					return {
						text: '',
						toolCalls: [
							{ name: 'project_health_scan', params: {} },
							{ name: 'architecture_map', params: {} },
						],
					};
				case 1:
					assert.match(payload, /aws-access-key/, 'project_health_scan detected secret');
					assert.match(payload, /\[REDACTED_SECRET\]/, 'project_health_scan redacted secret');
					assert.ok(!payload.includes(fakeAws), 'raw secret NEVER sent to LLM');
					assert.match(payload, /Circular dependencies: 1/, 'architecture_map detected real cycle');
					return { text: 'Initial health and architecture scan complete.' };
				case 2:
					assert.match(payload, /QUEUED-FOLLOWUP-STEERING/, 'queued message auto-dispatched as turn 2');
					return { text: 'Handled queued steering follow-up.' };
				default:
					return { text: 'Done.' };
			}
		});

		const h = createHarness(dir, llm, store, {
			modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' },
			overridesOfModel: { openAICompatible: { 'kodia-scripted-model': { contextWindow: 128_000, specialToolFormat: 'openai-style' } } },
			globalSettings: { verifyBeforeFinishing: false },
		});

		const tid = h.chat.state.currentThreadId;
		const turn1 = h.chat.addUserMessageAndStreamResponse({ userMessage: 'Scan health and architecture', threadId: tid });
		await turn1Started;

		// Queue a follow-up steering message while turn 1 is actively running
		h.chat.enqueueUserMessage(tid, 'QUEUED-FOLLOWUP-STEERING: now summarize findings');
		assert.strictEqual(h.chat.getQueuedMessages(tid).length, 1);
		enqueuedDuringTurn1 = true;

		await turn1;

		// Wait for the auto-dispatched queued turn 2 to complete
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			const msgs = h.chat.state.allThreads[tid]?.messages ?? [];
			const running = h.chat.streamState[tid]?.isRunning;
			if (!running && msgs.some(m => m.role === 'assistant' && m.displayContent.includes('Handled queued steering follow-up.'))) {
				break;
			}
			await new Promise(r => setTimeout(r, 25));
		}

		assert.strictEqual(enqueuedDuringTurn1, true);
		assert.deepStrictEqual(llm.scriptErrors, []);
		assert.strictEqual(h.chat.getQueuedMessages(tid).length, 0, 'queue drained after auto-dispatch');
		const finalMsgs = h.chat.state.allThreads[tid]!.messages;
		assert.ok(finalMsgs.some(m => m.role === 'assistant' && m.displayContent.includes('Initial health and architecture scan complete.')));
		assert.ok(finalMsgs.some(m => m.role === 'assistant' && m.displayContent.includes('Handled queued steering follow-up.')));
	});

	test('workspace_diagnostics, file_metadata, dependency_audit, move_or_rename_file & named checkpoint rollback work end-to-end', async () => {
		fs.writeFileSync(p('package.json'), JSON.stringify({
			name: 'audit-demo',
			license: 'MIT',
			dependencies: { lodash: '*', express: '^4.18.0' },
			scripts: { test: 'node --test' },
		}));
		fs.writeFileSync(p('old.txt'), 'line1\r\nline2\r\n');

		let step = 0;
		const llm = new ScriptedLLMService((_i, req: RecordedRequest): ScriptStep => {
			const payload = JSON.stringify(req.messages);
			switch (step++) {
				case 0:
					return {
						text: '',
						toolCalls: [
							{ name: 'workspace_diagnostics', params: {} },
							{ name: 'file_metadata', params: { uri: p('old.txt') } },
							{ name: 'dependency_audit', params: {} },
						],
					};
				case 1:
					assert.match(payload, /Workspace Diagnostics: 0 error/);
					assert.match(payload, /CRLF/);
					assert.match(payload, /lodash@\*/);
					return {
						text: '',
						toolCalls: [
							{ name: 'move_or_rename_file', params: { source_uri: p('old.txt'), target_uri: p('renamed.txt') } },
						],
					};
				default:
					assert.match(payload, /Moved .*old\.txt.*renamed\.txt/);
					return { text: 'Inspected metadata, audited dependencies, and renamed old.txt.' };
			}
		});

		const h = createHarness(dir, llm, store, {
			modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' },
			overridesOfModel: { openAICompatible: { 'kodia-scripted-model': { contextWindow: 128_000, specialToolFormat: 'openai-style' } } },
			globalSettings: { verifyBeforeFinishing: false },
		});

		const { threadId } = await runTurn(h.chat, 'Check diagnostics, metadata, deps and rename old.txt', 30_000);
		assert.deepStrictEqual(llm.scriptErrors, []);
		assert.strictEqual(fs.existsSync(p('old.txt')), false);
		assert.strictEqual(fs.existsSync(p('renamed.txt')), true);
		assert.ok(h.chat.getThreadChangedFiles(threadId).some(f => f.endsWith('renamed.txt')));

		// Create a named checkpoint, modify renamed.txt, then restore back to the named checkpoint
		const cpIdx = await h.chat.createNamedCheckpoint(threadId, 'Post-rename clean state');
		assert.ok(cpIdx >= 0);
		fs.writeFileSync(p('renamed.txt'), 'mutated-after-checkpoint');
		await h.chat.restoreCheckpointAtIdx(threadId, cpIdx);
		assert.strictEqual(fs.readFileSync(p('renamed.txt'), 'utf8'), 'line1\r\nline2\r\n', 'named checkpoint restored file contents on disk');
	});

	test('automatic fallback model recovers on provider failure, disabledTools blocks tool, and KodiaWorkflowsService runs scheduled job', async () => {
		fs.mkdirSync(p('.kodia/workflows'), { recursive: true });
		fs.writeFileSync(p('.kodia/workflows/nightly.md'), [
			'---',
			'name: nightly',
			'description: Nightly audit workflow',
			'mode: agent',
			'---',
			'1. Verify workspace health.',
		].join('\n'));

		const storage = store.add(new InMemoryStorageService());
		const observability = store.add(new ExecutionObservabilityService());
		let callCount = 0;

		const llm = new ScriptedLLMService((_i, req: RecordedRequest): ScriptStep => {
			callCount++;
			assert.ok(!req.tools?.includes('dependency_audit'), 'disabled tool must not be offered to the model');
			if (req.modelName === 'broken-primary') {
				return { text: '', error: 'HTTP 404 model not found' };
			}
			// Fallback model succeeds (and scheduled job call also succeeds)
			return { text: `Handled by ${req.modelName ?? 'unknown'}` };
		});

		const h = createHarness(dir, llm, store, {
			storage,
			observability,
			modelSelection: { providerName: 'openAICompatible', modelName: 'broken-primary' },
			overridesOfModel: {
				openAICompatible: {
					'broken-primary': { contextWindow: 128_000, specialToolFormat: 'openai-style' },
					'healthy-fallback': { contextWindow: 128_000, specialToolFormat: 'openai-style' },
				},
			},
			globalSettings: {
				verifyBeforeFinishing: false,
				disabledTools: ['dependency_audit'],
				fallbackModels: [{ providerName: 'openAICompatible', modelName: 'healthy-fallback' }],
			},
		});

		const { threadId, messages } = await runTurn(h.chat, 'Run with fallback resilience', 30_000);
		assert.deepStrictEqual(llm.scriptErrors, []);
		assert.ok(callCount >= 2, 'primary failed then fallback ran');
		assert.ok(messages.some(m => m.role === 'assistant' && m.displayContent.includes('Handled by healthy-fallback')));
		assert.ok(observability.getSpansForThread(threadId).some(s => s.name.includes('fallback ->')));

		// Workflows discovery + real scheduled job tick
		const wfService = store.add(new KodiaWorkflowsService(h.fileService, h.workspace, storage, h.chat));
		const workflows = await wfService.listWorkflows();
		assert.strictEqual(workflows.length, 1);
		assert.strictEqual(workflows[0].name, 'nightly');

		const job = wfService.addScheduledJob({ name: 'Nightly Check', prompt: 'Check nightly status', intervalMinutes: 5, enabled: true });
		const triggered = await wfService.tickDueJobs(Date.now() + 10 * 60_000);
		assert.strictEqual(triggered.length, 1);
		const updatedJob = wfService.getScheduledJobs().find(j => j.id === job.id)!;
		assert.strictEqual(updatedJob.runCount, 1);
		assert.strictEqual(updatedJob.lastStatus, 'completed');
		assert.strictEqual(updatedJob.lastThreadId, triggered[0]);
		assert.strictEqual(h.chat.state.currentThreadId, threadId, 'background scheduled job did not steal focus from user active thread');
	});

	test('BYOK deterministic tool-param auto-repair fixes alias args (path/content & old_string/new_string) and revertSingleFile rolls back', async () => {
		fs.mkdirSync(p('src'), { recursive: true });
		fs.writeFileSync(p('src/greet.js'), 'export const msg = "initial";\n');

		const observability = store.add(new ExecutionObservabilityService());
		let step = 0;

		const llm = new ScriptedLLMService((_i, req: RecordedRequest): ScriptStep => {
			const payload = JSON.stringify(req.messages);
			switch (step++) {
				case 0:
					// Simulate a BYOK model using wrong parameter names + relative path
					return {
						text: '',
						toolCalls: [{
							name: 'edit_file',
							params: { file_path: 'src/greet.js', old_string: '"initial"', new_string: '"updated"' },
						}],
					};
				case 1:
					assert.ok(!payload.includes('Invalid LLM output'), 'auto-repair prevented param validation error');
					return {
						text: '',
						toolCalls: [{
							name: 'write_file',
							params: { path: 'src/extra.js', content: 'export const extra = 42;\n' },
						}],
					};
				default:
					return { text: 'Edited greet.js and created extra.js despite non-standard param aliases.' };
			}
		});

		const h = createHarness(dir, llm, store, {
			observability,
			modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' },
			overridesOfModel: { openAICompatible: { 'kodia-scripted-model': { contextWindow: 128_000, specialToolFormat: 'openai-style' } } },
			globalSettings: { verifyBeforeFinishing: false },
		});

		const { threadId } = await runTurn(h.chat, 'Update greet.js and create extra.js', 30_000);
		assert.deepStrictEqual(llm.scriptErrors, []);
		assert.strictEqual(fs.readFileSync(p('src/greet.js'), 'utf8'), 'export const msg = "updated";\n');
		assert.strictEqual(fs.readFileSync(p('src/extra.js'), 'utf8'), 'export const extra = 42;\n');
		assert.ok(observability.getSpansForThread(threadId).some(s => s.name === 'auto-repair:edit_file'));
		assert.ok(observability.getSpansForThread(threadId).some(s => s.name === 'auto-repair:write_file'));

		// Single-file revert restores ONLY src/greet.js while keeping src/extra.js intact!
		const reverted = await h.chat.revertSingleFile(threadId, p('src/greet.js'));
		assert.strictEqual(reverted, true);
		assert.strictEqual(fs.readFileSync(p('src/greet.js'), 'utf8'), 'export const msg = "initial";\n');
		assert.strictEqual(fs.readFileSync(p('src/extra.js'), 'utf8'), 'export const extra = 42;\n');
	});

	test('Digital Twin change_impact_analysis + evaluate_quality_gates run through ToolsService and Ledger/Factory persist across restarts', async () => {
		fs.mkdirSync(p('src'), { recursive: true });
		fs.writeFileSync(p('src/core.ts'), 'export function coreCalc(x: number) { return x * 2; }\n');
		fs.writeFileSync(p('src/api.ts'), 'import { coreCalc } from "./core";\napp.get("/api/calc", () => coreCalc(21));\n');
		fs.writeFileSync(p('src/core.test.ts'), 'import { coreCalc } from "./core";\ncoreCalc(2);\n');

		const storage = store.add(new InMemoryStorageService());
		let step = 0;

		const llm = new ScriptedLLMService((_i, req: RecordedRequest): ScriptStep => {
			const payload = JSON.stringify(req.messages);
			switch (step++) {
				case 0:
					return { text: '', toolCalls: [{ name: 'change_impact_analysis', params: { target_path: 'src/core.ts' } }] };
				case 1:
					assert.ok(payload.includes('src/api.ts'), 'blast radius reached model');
					assert.ok(payload.includes('GET /api/calc'), 'affected API route reached model');
					return { text: '', toolCalls: [{ name: 'evaluate_quality_gates', params: {} }] };
				case 2:
					assert.ok(payload.includes('Kodia Autonomous Quality Gates: PASSED'), 'quality gate evaluation reached model');
					return { text: 'Verified blast radius and passed all quality gates.' };
				default:
					return { text: 'Factory autopilot cycle completed.' };
			}
		});

		const h = createHarness(dir, llm, store, {
			storage,
			modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' },
			overridesOfModel: { openAICompatible: { 'kodia-scripted-model': { contextWindow: 128_000, specialToolFormat: 'openai-style' } } },
			globalSettings: { verifyBeforeFinishing: false },
		});

		await runTurn(h.chat, 'Check blast radius of core.ts and run quality gates', 30_000);
		assert.deepStrictEqual(llm.scriptErrors, []);

		// Verify VerificationLedgerService & SoftwareFactoryService real persistence across simulated restart
		const markerService = store.add(new MarkerService());
		const ledger1 = store.add(new VerificationLedgerService(storage, h.fileService, h.workspace, markerService));
		const { evaluation } = await ledger1.runWorkspaceQualityGates();
		assert.strictEqual(evaluation.passed, true);

		const ledger2 = store.add(new VerificationLedgerService(storage, h.fileService, h.workspace, markerService));
		assert.strictEqual(ledger2.getRecords().length, 1, 'verification record survives simulated restart');

		const factory1 = store.add(new SoftwareFactoryService(storage, h.chat));
		const req1 = factory1.addRequirement({ title: 'Calc API', description: 'Expose /api/calc', priority: 'high' });
		factory1.updateRequirement(req1.id, { status: 'verified' });
		factory1.addDecision({ title: 'Use pure coreCalc', context: 'Shared math', decision: 'Keep core.ts pure' });
		const obj = factory1.addAutopilotObjective({ title: 'Harden tests', instruction: 'Check test coverage' });
		assert.ok(obj.enabled);

		const factory2 = store.add(new SoftwareFactoryService(storage, h.chat));
		assert.strictEqual(factory2.getRequirements().length, 1);
		assert.strictEqual(factory2.getRequirements()[0].status, 'verified');
		assert.strictEqual(factory2.getDecisions().length, 1);
		assert.strictEqual(factory2.getAutopilotObjectives().length, 1);
	});
});
