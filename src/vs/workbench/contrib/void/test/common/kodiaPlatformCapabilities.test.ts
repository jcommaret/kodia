/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { availableTools, builtinToolNames } from '../../common/prompt/prompts.js';
import { approvalTypeOfBuiltinToolName } from '../../common/toolsServiceTypes.js';
import { getToolCategory, getToolDisplayTitles, summarizeToolParams } from '../../common/toolDisplayMeta.js';
import { matchesHookMatcher, parseHookOutput, parseHooksConfig } from '../../common/kodiaHooks.js';
import { commandNameFromRelativePath, expandCustomCommandPrompt, parseCustomCommandMarkdown, parseSlashCommandInvocation, splitCommandArguments } from '../../common/customCommands.js';
import { classifyExecutionError, ExecutionObservabilityService } from '../../common/executionObservability.js';
import { parseCustomAgentMarkdown, resolveSubagentType, SUBAGENT_TYPES, subagentToolNames } from '../../common/subagents.js';
import { TaskPlanService } from '../../common/taskPlanService.js';
import { TaskDecompositionService } from '../../common/taskDecompositionService.js';
import { analyzeProjectHealth, analyzeTechnicalDebt, buildArchitectureMap, computeEngineeringQualityScore, formatArchitectureMapForLLM, formatProjectHealthForLLM } from '../../common/projectHealth.js';
import { shouldRequestCompletionCheck } from '../../common/completionCheck.js';
import { exportThreadToMarkdown, filterThreadsByQuery } from '../../common/threadExport.js';
import { isFallbackEligibleError, modelSelectionKey, resolveRoutedModelSelection, selectNextFallbackModel } from '../../common/modelRouting.js';
import { computeNextRunAt, isScheduledJobDue, parseWorkflowMarkdown } from '../../common/kodiaWorkflows.js';
import { buildRemodifyPromptRequest, extractRewrittenPrompt } from '../../common/promptRewriter.js';
import { repairToolParams } from '../../common/toolParamRepair.js';
import { isReadOnlySqlQuery, isValidDockerContainerName } from '../../common/kodiaOpsTypes.js';
import { computeUnifiedDiff } from '../../common/unifiedDiffView.js';
import { findDeterministicNextEditTargets, parseNextEditPredictionResponse } from '../../common/nextEditPrediction.js';
import { FailurePatternMemory } from '../../common/failureMemory.js';
import {
	applyKodiaAccentToColorCustomizations,
	detectActiveKodiaAccent,
	KODIA_ACCENT_PRESETS,
	KODIA_RECOMMENDED_PRESETS,
	KODIA_SIGNATURE_THEMES,
} from '../../common/kodiaAppearance.js';
import { analyzeChangeImpact, buildProjectDigitalTwin, queryKnowledgeGraph } from '../../common/digitalTwin.js';
import { createVerificationRecord, evaluateQualityGates } from '../../common/verificationLedger.js';
import { buildModelCouncilPrompt, buildSoftwareFactoryPrompt, computeRequirementCoverage } from '../../common/softwareFactory.js';

suite('Kodia - Platform Capabilities (Hooks, Commands, Observability, Specialists, Plan, Tool UI Meta)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	suite('Tool display metadata covers every built-in tool', () => {
		test('every builtinToolName has non-empty titles, valid category, and safe param summary', () => {
			assert.ok(builtinToolNames.length > 100, `expected >100 builtin tools, got ${builtinToolNames.length}`);
			for (const name of builtinToolNames) {
				const titles = getToolDisplayTitles(name);
				assert.ok(titles.done.length > 0, `${name} missing done title`);
				assert.ok(titles.proposed.length > 0, `${name} missing proposed title`);
				assert.ok(titles.running.length > 0, `${name} missing running title`);
				const cat = getToolCategory(name);
				assert.ok(cat.length > 0, `${name} missing category`);
				const summary = summarizeToolParams(name, {});
				assert.strictEqual(typeof summary.desc1, 'string');
			}
			assert.strictEqual(getToolCategory('git_commit'), 'git');
			assert.strictEqual(getToolCategory('debug_set_breakpoint'), 'debug');
			assert.strictEqual(getToolCategory('browser_click_element'), 'browser');
			assert.strictEqual(getToolCategory('test_run'), 'test');
			assert.strictEqual(getToolCategory('subagent'), 'agent');
			assert.strictEqual(getToolCategory('write_file'), 'edit');
			assert.strictEqual(summarizeToolParams('subagent', { agent: 'security', description: 'audit auth' }).desc1, '[security] audit auth');
		});
	});

	suite('Lifecycle hooks config & semantics', () => {
		test('parses both Kodia flat hooks.json and Claude Code nested settings.json formats', () => {
			const kodiaJson = JSON.stringify({
				hooks: {
					PreToolUse: [{ matcher: 'write_file|edit_file', command: 'node check.js', timeoutMs: 4000 }],
					PostToolUse: [{ command: 'echo ok', enabled: false }],
					UnknownEvent: [{ command: 'ignored' }],
				},
			});
			const parsedKodia = parseHooksConfig(kodiaJson, '.kodia/hooks.json');
			assert.strictEqual(parsedKodia.length, 2);
			assert.strictEqual(parsedKodia[0].event, 'PreToolUse');
			assert.strictEqual(parsedKodia[0].matcher, 'write_file|edit_file');
			assert.strictEqual(parsedKodia[0].timeoutMs, 4000);
			assert.strictEqual(parsedKodia[1].enabled, false);

			const claudeJson = JSON.stringify({
				hooks: {
					PreToolUse: [{
						matcher: 'run_command',
						hooks: [{ type: 'command', command: 'node guard.js', timeout: 15 }],
					}],
				},
			});
			const parsedClaude = parseHooksConfig(claudeJson, '.claude/settings.json');
			assert.strictEqual(parsedClaude.length, 1);
			assert.strictEqual(parsedClaude[0].command, 'node guard.js');
			assert.strictEqual(parsedClaude[0].timeoutMs, 15_000);
		});

		test('matchesHookMatcher supports wildcard, pipe-list, exact, and regex', () => {
			assert.strictEqual(matchesHookMatcher(undefined, 'write_file'), true);
			assert.strictEqual(matchesHookMatcher('*', 'write_file'), true);
			assert.strictEqual(matchesHookMatcher('edit_file|write_file', 'write_file'), true);
			assert.strictEqual(matchesHookMatcher('edit_file|write_file', 'read_file'), false);
			assert.strictEqual(matchesHookMatcher('^git_.*', 'git_push'), true);
			assert.strictEqual(matchesHookMatcher('^git_.*', 'test_run'), false);
		});

		test('parseHookOutput handles exit 0 allow, JSON block/ask/updatedInput, exit 2 block, non-zero error, and timeout', () => {
			assert.strictEqual(parseHookOutput(0, '', '', false).decision, 'allow');
			const blockedExit2 = parseHookOutput(2, '', 'Protected file', false);
			assert.strictEqual(blockedExit2.decision, 'block');
			assert.strictEqual(blockedExit2.reason, 'Protected file');

			const jsonBlock = parseHookOutput(0, JSON.stringify({ decision: 'block', reason: 'No secrets' }), '', false);
			assert.strictEqual(jsonBlock.decision, 'block');
			assert.strictEqual(jsonBlock.reason, 'No secrets');

			const jsonUpdate = parseHookOutput(0, JSON.stringify({ decision: 'allow', updatedInput: { path: 'safe.txt' }, systemMessage: 'lint passed' }), '', false);
			assert.strictEqual(jsonUpdate.decision, 'allow');
			assert.deepStrictEqual(jsonUpdate.updatedInput, { path: 'safe.txt' });
			assert.strictEqual(jsonUpdate.systemMessage, 'lint passed');

			const nonZero = parseHookOutput(1, '', 'script crashed', false);
			assert.strictEqual(nonZero.decision, 'allow');
			assert.strictEqual(nonZero.error, 'script crashed');

			const timedOut = parseHookOutput(null, '', '', true);
			assert.strictEqual(timedOut.decision, 'allow');
			assert.match(timedOut.error!, /timed out/i);
		});
	});

	suite('Custom slash commands', () => {
		test('parses markdown frontmatter, expands $ARGUMENTS and positional args', () => {
			assert.strictEqual(commandNameFromRelativePath('git/release.md'), 'git:release');
			const cmd = parseCustomCommandMarkdown('deploy', '/repo/.kodia/commands/deploy.md', 'project', [
				'---',
				'description: Deploy a service',
				'argument-hint: <env> <service>',
				'allowed-tools: read_file, run_command',
				'---',
				'Deploy $2 to $1 with options: $ARGUMENTS',
			].join('\n'))!;
			assert.ok(cmd);
			assert.strictEqual(cmd.description, 'Deploy a service');
			assert.strictEqual(cmd.argumentHint, '<env> <service>');
			assert.deepStrictEqual(cmd.allowedTools, ['read_file', 'run_command']);
			assert.deepStrictEqual(splitCommandArguments('prod "billing api"'), ['prod', 'billing api']);
			assert.strictEqual(expandCustomCommandPrompt(cmd, 'staging auth-svc'), 'Deploy auth-svc to staging with options: staging auth-svc');
			assert.deepStrictEqual(parseSlashCommandInvocation('/deploy staging auth-svc'), { commandName: 'deploy', rawArgs: 'staging auth-svc' });
			assert.strictEqual(parseSlashCommandInvocation('not a command'), undefined);
		});
	});

	suite('Execution observability', () => {
		test('tracks live spans, durations, metrics, and error classification', () => {
			const obs = store.add(new ExecutionObservabilityService());
			const llmId = obs.startSpan({ kind: 'llm_request', threadId: 't1', name: 'nvidia/model' });
			const toolId = obs.startSpan({ kind: 'tool_call', threadId: 't1', name: 'edit_file' });
			assert.strictEqual(obs.getActiveSpans('t1').length, 2);

			obs.endSpan(llmId, { status: 'completed', tokens: { input: 100, output: 50 } });
			obs.endSpan(toolId, { status: 'blocked', errorMessage: 'Blocked by PreToolUse hook: no secrets' });

			assert.strictEqual(obs.getActiveSpans('t1').length, 0);
			const metrics = obs.getMetrics('t1');
			assert.strictEqual(metrics.llmRequests, 1);
			assert.strictEqual(metrics.toolCalls, 1);
			assert.strictEqual(metrics.toolFailures, 1);
			assert.strictEqual(metrics.errorsByCategory.hook_blocked, 1);
			assert.strictEqual(classifyExecutionError('HTTP 429 rate limit exceeded'), 'rate_limit');
			assert.strictEqual(classifyExecutionError('maximum context length exceeded'), 'context_overflow');
		});
	});

	suite('Multi-agent specialist roster & custom agents', () => {
		test('resolves specialist roles and enforces read-only vs read/write', () => {
			assert.ok(Object.keys(SUBAGENT_TYPES).length >= 19);
			for (const role of ['planner', 'architect', 'security', 'explore', 'review'] as const) {
				const r = resolveSubagentType(role);
				assert.ok(!('error' in r));
				assert.strictEqual(r.profile.canChangeFiles, false, `${role} must be read-only`);
			}
			for (const role of ['frontend', 'backend', 'database', 'api', 'testing', 'debugging', 'git', 'browser', 'docs', 'devops', 'performance', 'ui_ux', 'refactor'] as const) {
				const r = resolveSubagentType(role);
				assert.ok(!('error' in r));
				assert.strictEqual(r.profile.canChangeFiles, true, `${role} can change files`);
			}
		});

		test('parses custom .kodia/agents/*.md and enforces tool allowlist', () => {
			const custom = parseCustomAgentMarkdown('/repo/.kodia/agents/auditor.md', [
				'---',
				'name: auditor',
				'description: Audits SQL queries',
				'readOnly: true',
				'tools: read_file, search_for_files',
				'model: nvidia/nemotron',
				'---',
				'Focus strictly on SQL injection risks.',
			].join('\n'))!;
			assert.ok(custom);
			assert.strictEqual(custom.name, 'auditor');
			assert.strictEqual(custom.canChangeFiles, false);
			assert.strictEqual(custom.defaultModel, 'nvidia/nemotron');
			const customMap = new Map([[custom.name, custom]]);
			const resolved = resolveSubagentType('auditor', customMap);
			assert.ok(!('error' in resolved));
			const offered = availableTools('agent', undefined)!.map(t => t.name);
			const allowed = subagentToolNames(resolved.type, offered, n => n in approvalTypeOfBuiltinToolName, resolved.profile);
			assert.deepStrictEqual(allowed.sort(), ['read_file', 'search_for_files']);
		});
	});

	suite('Task planning, persistence hydration, retry, and decomposition fix', () => {
		test('TaskDecompositionService.decomposeRequest actually populates tasks (regression fix)', () => {
			const svc = store.add(new TaskDecompositionService());
			const plan = svc.decomposeRequest('Build a React and Node REST API app with PostgreSQL database and tests');
			assert.ok(plan.tasks.length >= 3, `expected decomposed tasks, got ${plan.tasks.length}`);
			assert.strictEqual(svc.validatePlan(plan).valid, true);
		});

		test('TaskPlanService supports priority ordering, retryTask, editTask, removeTask, and hydratePlan', () => {
			const svc = store.add(new TaskPlanService());
			const plan = svc.createPlan('t1', 'Release', 'Ship v1', [
				{ title: 'Low task', description: 'Docs', dependencies: [], priority: 'low', assignedAgent: 'docs' },
				{ title: 'High task', description: 'Fix bug', dependencies: [], priority: 'high', assignedAgent: 'backend', acceptanceCriteria: ['tests pass'] },
			]);
			const ready = svc.getParallelReadyTasks('t1');
			assert.strictEqual(ready[0].title, 'High task');
			assert.strictEqual(ready[1].title, 'Low task');

			const highId = plan.tasks[1].id;
			svc.updateTask('t1', highId, 'failed', undefined, 'build broke');
			assert.strictEqual(svc.getPlan('t1')!.overallStatus, 'failed');

			const retried = svc.retryTask('t1', highId)!;
			assert.strictEqual(retried.tasks[1].status, 'pending');
			assert.strictEqual(retried.tasks[1].retryCount, 1);
			assert.strictEqual(retried.tasks[1].error, undefined);

			svc.editTask('t1', highId, { title: 'Fix critical bug' });
			assert.strictEqual(svc.getTaskById('t1', highId)!.title, 'Fix critical bug');

			// Hydration into a fresh service (simulates restart)
			const restored = store.add(new TaskPlanService());
			restored.hydratePlan('t1', svc.getPlan('t1')!);
			assert.strictEqual(restored.getPlan('t1')!.tasks.length, 2);

			restored.removeTask('t1', highId);
			assert.strictEqual(restored.getPlan('t1')!.tasks.length, 1);
		});
	});

	suite('Project health, secret redaction, architecture map & plan/debug modes', () => {
		test('analyzeProjectHealth detects & redacts secrets (never leaks raw value), catches security risks, and profiles stack', () => {
			const fakeAws = 'AKIA' + '1234567890ABCDEF';
			const fakeNvidia = 'nvapi-' + 'abcdefghijklmnopqrstuvwxyz123456';
			const report = analyzeProjectHealth([
				{ relativePath: 'package.json', content: JSON.stringify({ dependencies: { react: '^18.0.0', express: '^4.18.0' }, devDependencies: { vitest: '^1.0.0' } }) },
				{ relativePath: 'pnpm-lock.yaml', content: 'lockfileVersion: 9.0' },
				{
					relativePath: 'src/auth.ts',
					content: [
						`const key = "${fakeAws}";`,
						`const nv = "${fakeNvidia}";`,
						'const sql = `SELECT * FROM users WHERE id = ${userId}`;',
						'const out = eval(input);',
						'// TODO: replace eval',
					].join('\n'),
				},
			]);

			assert.strictEqual(report.scannedFiles, 3);
			assert.ok(report.stack.languages.includes('TypeScript'));
			assert.ok(report.stack.frameworks.includes('React'));
			assert.ok(report.stack.frameworks.includes('Express'));
			assert.ok(report.stack.packageManagers.includes('pnpm'));
			assert.ok(report.stack.testFrameworks.includes('Vitest'));
			assert.strictEqual(report.counts.todoCount, 1);
			assert.ok(report.counts.critical >= 2, 'AWS + NVIDIA keys flagged critical');
			assert.ok(report.counts.high >= 2, 'SQL concat + eval flagged high');

			const formatted = formatProjectHealthForLLM(report);
			assert.ok(!formatted.includes(fakeAws), 'raw AWS key must NEVER appear in formatted output');
			assert.ok(!formatted.includes(fakeNvidia), 'raw NVIDIA key must NEVER appear in formatted output');
			assert.ok(formatted.includes('[REDACTED_SECRET]'));
		});

		test('buildArchitectureMap resolves local imports, detects cycles, identifies hubs & orphans, and renders Mermaid', () => {
			const map = buildArchitectureMap([
				{ relativePath: 'src/a.ts', content: `import { b } from './b.js';\nimport { util } from './util.js';` },
				{ relativePath: 'src/b.ts', content: `import { a } from './a.js';\nimport { util } from './util.js';` },
				{ relativePath: 'src/util.ts', content: `export const util = 1;` },
				{ relativePath: 'src/orphan.ts', content: `export const unused = 2;` },
			]);

			assert.strictEqual(map.moduleCount, 4);
			assert.strictEqual(map.edgeCount, 4);
			assert.strictEqual(map.cycles.length, 1);
			assert.ok(map.cycles[0].includes('src/a.ts') && map.cycles[0].includes('src/b.ts'));
			assert.strictEqual(map.topHubs[0].file, 'src/util.ts');
			assert.strictEqual(map.topHubs[0].importedBy, 2);
			assert.deepStrictEqual(map.orphans, ['src/orphan.ts']);
			assert.match(map.mermaid, /^flowchart LR/);
			const formatted = formatArchitectureMapForLLM(map);
			assert.match(formatted, /Circular dependencies: 1/);
			assert.match(formatted, /src\/util\.ts/);
		});

		test('plan mode is strictly read-only + planning, while debug mode exposes full tools and triggers completion check', () => {
			const planTools = availableTools('plan', undefined)!.map(t => t.name);
			assert.ok(planTools.includes('read_file'));
			assert.ok(planTools.includes('create_task_plan'));
			assert.ok(planTools.includes('project_health_scan'));
			assert.ok(planTools.includes('architecture_map'));
			assert.ok(planTools.includes('subagent'));
			assert.ok(!planTools.includes('write_file'), 'plan mode must not offer write_file');
			assert.ok(!planTools.includes('edit_file'), 'plan mode must not offer edit_file');
			assert.ok(!planTools.includes('run_command'), 'plan mode must not offer run_command');

			const debugTools = availableTools('debug', undefined)!.map(t => t.name);
			assert.ok(debugTools.includes('debug_set_breakpoint'));
			assert.ok(debugTools.includes('edit_file'));
			assert.ok(debugTools.includes('project_health_scan'));

			const wrote = { role: 'tool', type: 'success', name: 'edit_file' };
			assert.strictEqual(shouldRequestCompletionCheck({ chatMode: 'debug', alreadyRequested: false, messagesThisTurn: [wrote] }), true);
			assert.strictEqual(shouldRequestCompletionCheck({ chatMode: 'plan', alreadyRequested: false, messagesThisTurn: [wrote] }), false);
		});

		test('threadExport filters sessions by multi-word query and exports Markdown transcript with task plan', () => {
			const t1 = {
				id: 'thread-auth-1',
				createdAt: '2026-11-22T08:00:00Z',
				lastModified: '2026-11-22T08:05:00Z',
				messages: [
					{ role: 'user' as const, content: 'Fix JWT auth bug', displayContent: 'Fix JWT auth bug', selections: null, state: { stagingSelections: [], isBeingEdited: false } },
					{ role: 'tool' as const, type: 'success' as const, name: 'edit_file' as const, id: 'c1', rawParams: {}, params: {} as any, result: {} as any, content: 'ok', mcpServerName: undefined },
					{ role: 'assistant' as const, displayContent: 'Patched token expiry validation.', reasoning: '', anthropicReasoning: null },
				],
				taskPlan: {
					id: 'p1',
					title: 'Auth Fix',
					description: 'Repair JWT validation',
					tasks: [{ id: 'tk1', title: 'Patch validator', description: 'Check exp', status: 'completed' as const, dependencies: [], assignedAgent: 'security' }],
					createdAt: '2026-11-22T08:00:00Z',
					updatedAt: '2026-11-22T08:05:00Z',
					overallStatus: 'completed' as const,
				},
			};
			const t2 = {
				id: 'thread-css-2',
				createdAt: '2026-11-22T09:00:00Z',
				lastModified: '2026-11-22T09:01:00Z',
				messages: [
					{ role: 'user' as const, content: 'Center navbar', displayContent: 'Center navbar', selections: null, state: { stagingSelections: [], isBeingEdited: false } },
				],
			};

			assert.deepStrictEqual(filterThreadsByQuery([t1, t2], 'jwt expiry').map(t => t.id), ['thread-auth-1']);
			assert.deepStrictEqual(filterThreadsByQuery([t1, t2], 'edit_file').map(t => t.id), ['thread-auth-1']);
			assert.deepStrictEqual(filterThreadsByQuery([t1, t2], 'navbar').map(t => t.id), ['thread-css-2']);

			const md = exportThreadToMarkdown(t1);
			assert.match(md, /^# Fix JWT auth bug/);
			assert.match(md, /## Task Plan: Auth Fix \(1\/1, 100%\)/);
			assert.match(md, /- \[x\] \*\*Patch validator\*\* _\(security\)_/);
			assert.match(md, /> \*\*Tool\*\* `edit_file` \(ok\)/);
			assert.match(md, /Patched token expiry validation\./);
		});
	});

	suite('Model routing, automatic fallbacks, disabledTools policy & workflows/scheduler', () => {
		test('modelRouting resolves role overrides, detects fallback-eligible provider errors, and iterates untried fallbacks', () => {
			const primary = { providerName: 'openAICompatible' as const, modelName: 'primary-model' };
			const fastExplore = { providerName: 'openAICompatible' as const, modelName: 'fast-explore' };
			const strongPlan = { providerName: 'anthropic' as const, modelName: 'claude-plan' };
			const backup = { providerName: 'openAI' as const, modelName: 'gpt-backup' };

			const r1 = resolveRoutedModelSelection({ primary, routingMap: { explore: fastExplore, planning: strongPlan }, subagentRole: 'explore' });
			assert.deepStrictEqual(r1.selection, fastExplore);
			assert.strictEqual(r1.routedRole, 'explore');

			const r2 = resolveRoutedModelSelection({ primary, routingMap: { planning: strongPlan }, chatMode: 'plan' });
			assert.deepStrictEqual(r2.selection, strongPlan);

			const r3 = resolveRoutedModelSelection({ primary, routingMap: { planning: strongPlan }, chatMode: 'plan', explicitOverride: backup });
			assert.deepStrictEqual(r3.selection, backup);

			assert.strictEqual(isFallbackEligibleError('HTTP 429 rate limit exceeded', 429), true);
			assert.strictEqual(isFallbackEligibleError('503 Service Unavailable', 503), true);
			assert.strictEqual(isFallbackEligibleError('The model sent no output for 60 seconds'), true);
			assert.strictEqual(isFallbackEligibleError('Invalid tool parameter JSON'), false);

			const tried = new Set([modelSelectionKey(primary)]);
			assert.deepStrictEqual(selectNextFallbackModel(tried, [primary, backup]), backup);
			tried.add(modelSelectionKey(backup));
			assert.strictEqual(selectNextFallbackModel(tried, [primary, backup]), undefined);
		});

		test('availableTools respects disabledTools filter across built-in tools', () => {
			const tools = availableTools('agent', undefined, undefined, ['run_command', 'dependency_audit'])!.map(t => t.name);
			assert.ok(!tools.includes('run_command'));
			assert.ok(!tools.includes('dependency_audit'));
			assert.ok(tools.includes('workspace_diagnostics'));
			assert.ok(tools.includes('move_or_rename_file'));
			assert.ok(tools.includes('file_metadata'));
		});

		test('kodiaWorkflows parses workflow markdown frontmatter/steps and evaluates scheduled job due state', () => {
			const wf = parseWorkflowMarkdown('audit.md', '/repo/.kodia/workflows/audit.md', [
				'---',
				'name: nightly-audit',
				'description: Nightly health & tests',
				'mode: plan',
				'interval-minutes: 120',
				'---',
				'1. Run project_health_scan',
				'2. Run workspace_diagnostics',
				'3. Summarize issues',
			].join('\n'))!;
			assert.ok(wf);
			assert.strictEqual(wf.name, 'nightly-audit');
			assert.strictEqual(wf.mode, 'plan');
			assert.strictEqual(wf.defaultIntervalMinutes, 120);
			assert.deepStrictEqual(wf.steps, ['Run project_health_scan', 'Run workspace_diagnostics', 'Summarize issues']);

			const now = Date.parse('2026-11-22T10:00:00Z');
			const nextRunAt = computeNextRunAt(now, 30);
			const job = {
				id: 'j1',
				name: 'Audit',
				prompt: 'Check health',
				chatMode: 'agent' as const,
				intervalMinutes: 30,
				enabled: true,
				createdAt: new Date(now).toISOString(),
				nextRunAt,
				lastStatus: 'idle' as const,
				runCount: 0,
			};
			assert.strictEqual(isScheduledJobDue(job, now + 10 * 60_000), false);
			assert.strictEqual(isScheduledJobDue(job, now + 31 * 60_000), true);
			assert.strictEqual(isScheduledJobDue({ ...job, enabled: false }, now + 60 * 60_000), false);
			assert.strictEqual(isScheduledJobDue({ ...job, lastStatus: 'running' }, now + 60 * 60_000), false);
		});

		test('promptRewriter wraps draft safely, extracts <rewritten_prompt>, strips <think>, and rejects assistant refusals', () => {
			const req = buildRemodifyPromptRequest('what is this project anout', 'my-app');
			assert.match(req.systemMessage, /my-app/);
			assert.match(req.systemMessage, /NEVER answer the draft prompt/);
			assert.match(req.userMessage, /<draft_prompt>\nwhat is this project anout\n<\/draft_prompt>/);

			const ok = extractRewrittenPrompt('<think>fix typo</think>\n<rewritten_prompt>\nInspect this workspace and explain what this project is about.\n</rewritten_prompt>');
			assert.deepStrictEqual(ok, { rewritten: 'Inspect this workspace and explain what this project is about.' });

			const fallbackOk = extractRewrittenPrompt('Here is the rewritten prompt:\n\n"Explain this codebase architecture and entry points."');
			assert.deepStrictEqual(fallbackOk, { rewritten: 'Explain this codebase architecture and entry points.' });

			const rejected = extractRewrittenPrompt(`I'm not sure which project you're referring to—there's no context or attachment in your message.`);
			assert.ok('error' in rejected, 'conversational assistant refusal must not overwrite the user draft');
		});
	});

	suite('Wave 5: BYOK Tool Repair, SQL/Docker Safety, Unified Diff, Next-Edit Prediction, Failure Memory & Quality Score', () => {
		test('repairToolParams remaps common BYOK aliases, synthesizes search_replace_blocks, and resolves relative paths', () => {
			const w = repairToolParams('write_file', { path: 'src/app.ts', content: 'export const x = 1;' }, 'C:\\repo');
			assert.strictEqual(w.repairedParams.uri, 'C:\\repo\\src\\app.ts');
			assert.strictEqual(w.repairedParams.new_content, 'export const x = 1;');
			assert.ok(w.repairs.includes('path→uri'));
			assert.ok(w.repairs.includes('content→new_content'));

			const e = repairToolParams('edit_file', { file_path: 'src/app.ts', old_string: 'x = 1', new_string: 'x = 2' }, '/repo');
			assert.strictEqual(e.repairedParams.uri, '/repo/src/app.ts');
			assert.match(String(e.repairedParams.search_replace_blocks), /<<<<<<< ORIGINAL\nx = 1\n=======\nx = 2\n>>>>>>> UPDATED/);

			const c = repairToolParams('run_command', { cmd: 'npm test' });
			assert.strictEqual(c.repairedParams.command, 'npm test');
		});

		test('SQL read-only guard and Docker container validator reject injection and mutating queries', () => {
			assert.strictEqual(isReadOnlySqlQuery('SELECT * FROM users LIMIT 10;'), true);
			assert.strictEqual(isReadOnlySqlQuery('WITH t AS (SELECT 1) SELECT * FROM t'), true);
			assert.strictEqual(isReadOnlySqlQuery('PRAGMA table_info(users)'), true);
			assert.strictEqual(isReadOnlySqlQuery('DELETE FROM users'), false);
			assert.strictEqual(isReadOnlySqlQuery('SELECT 1; DROP TABLE users'), false);
			assert.strictEqual(isReadOnlySqlQuery('PRAGMA writable_schema = ON'), false);

			assert.strictEqual(isValidDockerContainerName('my-app_web.1'), true);
			assert.strictEqual(isValidDockerContainerName('--privileged'), false);
			assert.strictEqual(isValidDockerContainerName('web; rm -rf /'), false);
		});

		test('computeUnifiedDiff computes exact additions, removals, and context lines', () => {
			const diff = computeUnifiedDiff('a\nb\nc\nd', 'a\nb2\nc\nd\ne', 1);
			assert.strictEqual(diff.added, 2);
			assert.strictEqual(diff.removed, 1);
			assert.ok(diff.lines.some(l => l.kind === 'del' && l.text === 'b'));
			assert.ok(diff.lines.some(l => l.kind === 'add' && l.text === 'b2'));
			assert.ok(diff.lines.some(l => l.kind === 'add' && l.text === 'e'));
		});

		test('nextEditPrediction finds deterministic rename jump targets and parses JSON LLM predictions', () => {
			const lines = [
				'const userId = getId();',
				'const name = fetchName(oldId);',
				'log(oldId);',
			];
			const targets = findDeterministicNextEditTargets(lines, {
				uri: 'file:///a.ts',
				lineNumber: 1,
				beforeLine: 'const oldId = getId();',
				afterLine: 'const userId = getId();',
				timestamp: Date.now(),
			});
			assert.strictEqual(targets.length, 2);
			assert.strictEqual(targets[0].lineNumber, 2);
			assert.strictEqual(targets[0].suggestedLine, 'const name = fetchName(userId);');

			const parsed = parseNextEditPredictionResponse('<think>check</think>{"line": 3, "reason": "match rename", "original": "log(oldId);", "replacement": "log(userId);"}')!;
			assert.strictEqual(parsed.lineNumber, 3);
			assert.strictEqual(parsed.suggestedLine, 'log(userId);');
		});

		test('FailurePatternMemory learns recovery lessons and surfaces them on recurring normalized failures', () => {
			const mem = new FailurePatternMemory();
			assert.strictEqual(mem.recordFailure('edit_file', 'Match not found in C:\\repo\\a.ts line 12'), undefined);
			mem.recordRecovery('edit_file', 'Read surrounding 20 lines with read_file before editing');
			const hint = mem.recordFailure('edit_file', 'Match not found in C:\\other\\b.ts line 99');
			assert.strictEqual(hint, 'Read surrounding 20 lines with read_file before editing');
		});

		test('computeEngineeringQualityScore grades clean vs risky codebases deterministically', () => {
			const cleanHealth = analyzeProjectHealth([{ relativePath: 'src/ok.ts', content: 'export const ok = 1;\n' }]);
			const cleanArch = buildArchitectureMap([{ relativePath: 'src/ok.ts', content: 'export const ok = 1;\n' }]);
			const cleanScore = computeEngineeringQualityScore(cleanHealth, cleanArch);
			assert.ok(cleanScore.score >= 88 && (cleanScore.grade === 'A' || cleanScore.grade === 'A+'));

			const badHealth = analyzeProjectHealth([{ relativePath: 'src/bad.ts', content: `const k = "AKIA1234567890ABCDEF";\neval(x);\n` }]);
			const badScore = computeEngineeringQualityScore(badHealth);
			assert.ok(badScore.securityScore < 70);
			assert.ok(badScore.score < cleanScore.score);
		});
	});

	suite('Wave 6: Kodia Visual Identity, Themes, Accents & Recommended Profiles', () => {
		test('signature themes include dark & light variants and accent customization preserves unrelated user keys', () => {
			assert.ok(KODIA_SIGNATURE_THEMES.some(t => t.kind === 'dark'));
			assert.ok(KODIA_SIGNATURE_THEMES.some(t => t.kind === 'light'));
			assert.ok(KODIA_ACCENT_PRESETS.length >= 6);
			assert.strictEqual(KODIA_RECOMMENDED_PRESETS.length, 3);

			const existing = { 'editor.background': '#101010', 'focusBorder': '#ff0000' };
			const applied = applyKodiaAccentToColorCustomizations(existing, 'emerald');
			assert.strictEqual(applied['editor.background'], '#101010', 'preserves unrelated user color customizations');
			assert.strictEqual(applied['button.background'], '#10B981');
			assert.strictEqual(detectActiveKodiaAccent(applied), 'emerald');

			const cleared = applyKodiaAccentToColorCustomizations(applied, null);
			assert.strictEqual(cleared['editor.background'], '#101010');
			assert.strictEqual(cleared['button.background'], undefined);
			assert.strictEqual(detectActiveKodiaAccent(cleared), null);
		});
	});

	suite('Wave 7: Digital Twin, Proof-Carrying Verification Ledger, Quality Gates, Software Factory & Tech Debt', () => {
		test('Project Digital Twin maps exports/APIs/DB entities and computes transitive change-impact blast radius', () => {
			const twin = buildProjectDigitalTwin([
				{ relativePath: 'src/db.ts', content: 'export const db = "CREATE TABLE users (id INT)";\n' },
				{ relativePath: 'src/auth.ts', content: 'import { db } from "./db";\nexport function verifyToken() { return db; }\n' },
				{ relativePath: 'src/routes.ts', content: 'import { verifyToken } from "./auth";\napp.post("/api/login", () => verifyToken());\n' },
				{ relativePath: 'src/auth.test.ts', content: 'import { verifyToken } from "./auth";\nverifyToken();\n' },
			]);

			assert.strictEqual(twin.nodes.length, 4);
			assert.ok(twin.totalSymbols >= 2);
			assert.ok(twin.totalApis >= 1);
			assert.ok(twin.totalDbEntities >= 1);

			const impact = analyzeChangeImpact(twin, 'src/db.ts');
			assert.strictEqual(impact.found, true);
			assert.deepStrictEqual(impact.directDependents, ['src/auth.ts']);
			assert.ok(impact.transitiveDependents.includes('src/routes.ts'));
			assert.ok(impact.affectedTests.includes('src/auth.test.ts'));
			assert.ok(impact.affectedApiEndpoints.includes('POST /api/login'));
			assert.strictEqual(impact.riskLevel, 'high');

			const matches = queryKnowledgeGraph(twin, '/api/login');
			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0].id, 'src/routes.ts');
		});

		test('Verification Ledger tracks highest passed level and Quality Gates enforce thresholds', () => {
			const rec = createVerificationRecord({
				taskTitle: 'Auth refactor',
				summary: 'All unit and integration tests passed',
				filesChanged: ['src/auth.ts'],
				checks: [
					{ name: 'tsc', level: 'compiled', passed: true, detail: '0 errors', timestamp: new Date().toISOString() },
					{ name: 'mocha', level: 'integration_tests', passed: true, detail: '12 passing', timestamp: new Date().toISOString() },
				],
			});
			assert.strictEqual(rec.passed, true);
			assert.strictEqual(rec.highestLevel, 'integration_tests');

			const okGates = evaluateQualityGates({ criticalFindings: 0, highFindings: 1, qualityScore: 88, circularDependencies: 0, workspaceErrors: 0 });
			assert.strictEqual(okGates.passed, true);

			const failGates = evaluateQualityGates({ criticalFindings: 1, highFindings: 0, qualityScore: 40, circularDependencies: 0, workspaceErrors: 2 });
			assert.strictEqual(failGates.passed, false);
			assert.ok(failGates.gates.filter(g => !g.passed).length >= 3);
		});

		test('Software Factory prompts, coverage math, and technical debt analyzer work deterministically', () => {
			const now = new Date().toISOString();
			const reqs = [
				{ id: 'REQ-001', title: 'Auth', description: 'JWT login', priority: 'high' as const, status: 'verified' as const, acceptanceCriteria: [], linkedFiles: [], linkedTests: [], createdAt: now, updatedAt: now },
				{ id: 'REQ-002', title: 'Billing', description: 'Stripe checkout', priority: 'medium' as const, status: 'unstarted' as const, acceptanceCriteria: [], linkedFiles: [], linkedTests: [], createdAt: now, updatedAt: now },
			];
			const cov = computeRequirementCoverage(reqs);
			assert.strictEqual(cov.percentVerified, 50);

			const factoryPrompt = buildSoftwareFactoryPrompt('Build appointment booking SaaS', 'saas-platform', reqs);
			assert.match(factoryPrompt, /Multi-Tenant SaaS Platform/);
			assert.match(factoryPrompt, /REQ-001/);

			const councilPrompt = buildModelCouncilPrompt('Cookies vs JWT?');
			assert.match(councilPrompt, /Multi-Agent Architecture Council/);

			const health = analyzeProjectHealth([
				{ relativePath: 'src/big.ts', content: 'const a = 1;\n'.repeat(800) + 'const k = "AKIA1234567890ABCDEF";\n' },
			]);
			const debt = analyzeTechnicalDebt(health);
			assert.ok(debt.some(d => d.category === 'security-hotspot'));
			assert.ok(debt.some(d => d.category === 'oversized-module'));
		});
	});
});
