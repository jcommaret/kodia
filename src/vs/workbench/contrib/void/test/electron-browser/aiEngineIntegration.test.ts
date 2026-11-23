/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * End-to-End Execution-Chain Integration Tests for Kodia's Universal AI Engineering Engine
 * & Two-Engine Unified Orchestrator:
 *
 * Test 1 (Demonstrations A, B, D, E, G — Unified AI Product Factory Chain):
 *   USER ONE-COMMAND REQUEST -> SYSTEM PROMPT CHECK -> ai_orchestrate_project (dual_engine_unified) ->
 *   ai_probe_compute_hardware -> ai_scaffold_product_factory -> write_file (docs, dataset, model artifact, app) ->
 *   ai_profile_dataset -> ai_rag_build_index -> ai_rag_query (verified citation) -> ai_rag_evaluate (PASSED) ->
 *   ai_experiment_manage -> ai_model_registry (artifact verified on disk & promoted) ->
 *   ai_create_workflow -> ai_run_workflow (HITL pause -> approved completion) ->
 *   ai_evaluate_system (PASSED) -> ai_audit_security -> ai_check_provider_capabilities -> VERIFIED COMPLETION.
 *
 * Test 2 (Demonstration F — Non-AI Software Regression):
 *   Ordinary non-AI software request -> ai_orchestrate_project returns universal_only (Requires AI: NO) ->
 *   pure software module implemented with zero unwanted AI scaffolding -> VERIFIED COMPLETION.
 */

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { KODIA_AI_ENGINE_CHANNEL } from '../../common/aiEngineeringTypes.js';
import { KodiaAIEngineMainService } from '../../electron-main/aiEngineMainService.js';
import { createHarness, RecordedRequest, runTurn, ScriptedLLMService, ScriptStep } from './agentHarness.js';

suite('Kodia - End-to-End Universal AI Engineering Engine & Two-Engine Orchestrator', function () {
	this.timeout(90_000);

	let store: DisposableStore;
	let dir: string;
	const p = (rel: string) => path.join(dir, rel);

	setup(() => {
		store = new DisposableStore();
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-ai-e2e-')));
	});

	teardown(() => {
		store.dispose();
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	});

	test('full unified AI product factory chain: orchestrate -> hardware -> scaffold -> dataset -> RAG -> experiments -> registry -> HITL workflow -> eval -> security', async () => {
		const aiMain = store.add(new KodiaAIEngineMainService());

		let step = 0;
		let createdModelId = '';
		let createdWorkflowId = '';

		const lastToolContent = (req: RecordedRequest): string => {
			const last = req.messages[req.messages.length - 1] as { content?: string } | undefined;
			return typeof last?.content === 'string' ? last.content : JSON.stringify(last ?? '');
		};
		const extract = (text: string, regex: RegExp): string => {
			const m = regex.exec(text);
			return m ? m[1] : '';
		};

		const llm = new ScriptedLLMService((_i, req: RecordedRequest): ScriptStep => {
			const payload = JSON.stringify(req.messages);
			if (step === 0) {
				const sysCombined = `${req.separateSystemMessage ?? ''}\n${payload}`;
				assert.ok(
					sysCombined.includes('TWO-ENGINE UNIFIED ORCHESTRATION'),
					'System prompt must include Two-Engine Unified Orchestration instructions by default',
				);
			}

			switch (step++) {
				case 0:
					return {
						text: 'Routing request via the Unified Two-Engine Orchestrator.',
						toolCalls: [
							{
								name: 'ai_orchestrate_project',
								params: {
									request: 'Build a full-stack enterprise AI support platform with React web dashboard, FastAPI backend, hybrid RAG knowledge search with citations, autonomous escalation workflow with human approval, and evaluation suite.',
								},
							},
						],
					};
				case 1:
					assert.match(lastToolContent(req), /dual_engine_unified/, 'Mixed software + AI product must route to dual_engine_unified');
					assert.match(lastToolContent(req), /rag_knowledge/, 'Must detect rag_knowledge discipline');
					return {
						text: '',
						toolCalls: [{ name: 'ai_probe_compute_hardware', params: {} }],
					};
				case 2:
					assert.match(lastToolContent(req), /Tier:/, 'Hardware probe must report real compute tier');
					return {
						text: '',
						toolCalls: [
							{
								name: 'ai_scaffold_product_factory',
								params: {
									project_title: 'Aegis Support AI',
									objective: 'Enterprise AI support copilot with hybrid RAG, escalation workflow, and evaluation suite.',
									compute_preference: 'hybrid',
								},
							},
						],
					};
				case 3:
					assert.match(lastToolContent(req), /One-Command AI Product Factory Blueprint/, 'Factory blueprint must be generated');
					return {
						text: '',
						toolCalls: [
							{
								name: 'write_file',
								params: {
									uri: p('docs/sla-policy.md'),
									new_content: '# Enterprise SLA & Refund Policy\nCritical P1 incidents receive a 15-minute response SLA and 99.95% uptime guarantee.\nAnnual subscriptions qualify for a 30-day refund with finance approval.\n',
								},
							},
							{
								name: 'write_file',
								params: {
									uri: p('data/tickets.csv'),
									new_content: 'ticket_id,category,priority,resolved\n1,billing,high,true\n2,security,critical,true\n3,billing,medium,true\n4,platform,low,false\n',
								},
							},
							{
								name: 'write_file',
								params: {
									uri: p('models/router_v1.onnx'),
									new_content: 'ONNX-VERIFIED-ARTIFACT-HEADER',
								},
							},
							{
								name: 'write_file',
								params: {
									uri: p('src/aiGateway.ts'),
									new_content: 'export interface SafeGatewayInput { tenant_id: string; query: string; }\nexport function validateInput(input: SafeGatewayInput): string {\n\treturn input.query.trim().slice(0, 4000);\n}\n',
								},
							},
						],
					};
				case 4:
					return {
						text: '',
						toolCalls: [
							{ name: 'ai_profile_dataset', params: { dataset_path: 'data/tickets.csv' } },
						],
					};
				case 5:
					assert.match(lastToolContent(req), /Rows: 4/, 'Dataset profiler must inspect real CSV rows');
					return {
						text: '',
						toolCalls: [
							{
								name: 'ai_rag_build_index',
								params: {
									index_name: 'aegis-kb',
									source_paths: JSON.stringify(['docs']),
									chunk_size: '500',
									chunk_overlap: '60',
								},
							},
						],
					};
				case 6:
					assert.match(lastToolContent(req), /aegis-kb/, 'RAG index build must confirm persisted index');
					return {
						text: '',
						toolCalls: [
							{
								name: 'ai_rag_query',
								params: {
									index_name: 'aegis-kb',
									query: 'What is the P1 incident response SLA?',
									top_k: '3',
								},
							},
						],
					};
				case 7:
					assert.match(lastToolContent(req), /sla-policy\.md/, 'RAG query must cite docs/sla-policy.md');
					assert.match(lastToolContent(req), /15-minute/, 'RAG query must return grounded SLA text');
					return {
						text: '',
						toolCalls: [
							{
								name: 'ai_rag_evaluate',
								params: {
									index_name: 'aegis-kb',
									top_k: '3',
									cases: JSON.stringify([
										{ query: 'P1 incident 15-minute response SLA', expected_sources: ['sla-policy.md'], expected_terms: ['15-minute', '99.95%'] },
										{ query: '30-day annual subscription refund', expected_sources: ['sla-policy.md'], expected_terms: ['30-day', 'refund'] },
									]),
								},
							},
						],
					};
				case 8:
					assert.match(lastToolContent(req), /PASSED/, 'RAG evaluation must pass on grounded knowledge base');
					return {
						text: '',
						toolCalls: [
							{
								name: 'ai_experiment_manage',
								params: {
									action: 'create',
									name: 'ticket-router-v1',
									discipline: 'machine_learning',
									model_ref: 'router_v1.onnx',
									dataset_ref: 'data/tickets.csv',
									metrics: JSON.stringify({ macro_f1: 0.93 }),
								},
							},
						],
					};
				case 9:
					assert.match(lastToolContent(req), /ticket-router-v1/, 'Experiment must be created and persisted');
					return {
						text: '',
						toolCalls: [
							{
								name: 'ai_model_registry',
								params: {
									action: 'register',
									name: 'ticket-router',
									version: '1.0.0',
									framework: 'onnxruntime',
									task_type: 'classification',
									artifact_path: 'models/router_v1.onnx',
									metrics: JSON.stringify({ macro_f1: 0.93 }),
								},
							},
						],
					};
				case 10:
					assert.match(lastToolContent(req), /VERIFIED/, 'Model registry must verify artifact exists on disk');
					createdModelId = extract(lastToolContent(req), /Registered (MDL-[a-z0-9-]+)/i);
					assert.ok(createdModelId, `Must capture registered model ID from: ${lastToolContent(req)}`);
					return {
						text: '',
						toolCalls: [
							{
								name: 'ai_model_registry',
								params: { action: 'promote', id: createdModelId, stage: 'staging' },
							},
						],
					};
				case 11:
					assert.match(lastToolContent(req), /staging/, 'Model promotion to staging must succeed');
					return {
						text: '',
						toolCalls: [
							{
								name: 'ai_create_workflow',
								params: {
									name: 'Refund Escalation Flow',
									instruction: 'Retrieve SLA knowledge base, analyze ticket, require human approval before issuing refund payment, and evaluate quality.',
								},
							},
						],
					};
				case 12:
					createdWorkflowId = extract(lastToolContent(req), /\((wf-[a-z0-9-]+)/i);
					assert.ok(createdWorkflowId, `Must capture workflow ID from: ${lastToolContent(req)}`);
					return {
						text: '',
						toolCalls: [
							{
								name: 'ai_run_workflow',
								params: { workflow_id: createdWorkflowId, input_context: 'Ticket #404 refund', approve_human_gates: 'false' },
							},
						],
					};
				case 13:
					assert.match(lastToolContent(req), /paused_for_approval/, 'Workflow must pause at HITL gate before approval');
					return {
						text: '',
						toolCalls: [
							{
								name: 'ai_run_workflow',
								params: { workflow_id: createdWorkflowId, input_context: 'Ticket #404 refund', approve_human_gates: 'true' },
							},
						],
					};
				case 14:
					assert.match(lastToolContent(req), /status "completed"/, 'Approved workflow must complete all steps');
					return {
						text: '',
						toolCalls: [
							{
								name: 'ai_evaluate_system',
								params: {
									name: 'router-release-gate',
									task_type: 'classification',
									min_pass_score: '0.8',
									records: JSON.stringify([
										{ expected: 'billing', predicted: 'billing' },
										{ expected: 'security', predicted: 'security' },
										{ expected: 'platform', predicted: 'platform' },
										{ expected: 'billing', predicted: 'billing' },
									]),
								},
							},
						],
					};
				case 15:
					assert.match(lastToolContent(req), /PASSED/, 'Release gate evaluation must pass');
					return {
						text: '',
						toolCalls: [{ name: 'ai_audit_security', params: {} }],
					};
				case 16:
					assert.match(lastToolContent(req), /AI Security & Governance Score: 100\/100/, 'Clean gateway code must score 100/100');
					return {
						text: '',
						toolCalls: [{ name: 'ai_check_provider_capabilities', params: {} }],
					};
				default:
					assert.match(lastToolContent(req), /Model-Agnostic Provider Matrix/, 'Provider capability matrix must be reported');
					return { text: 'Aegis Support AI platform planned, indexed, evaluated, registered, security-audited, and verified end to end.' };
			}
		});

		const base = createHarness(dir, llm, store, {
			modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-ai-engine-test' },
			overridesOfModel: { openAICompatible: { 'kodia-ai-engine-test': { contextWindow: 128_000, specialToolFormat: 'openai-style' } } },
			globalSettings: { verifyBeforeFinishing: false },
			mainProcessServices: {
				[KODIA_AI_ENGINE_CHANNEL]: aiMain,
			},
		});

		await runTurn(base.chat, 'Build a full-stack enterprise AI support platform with hybrid RAG, escalation workflow, and evaluations.', 60_000);
		assert.deepStrictEqual(llm.scriptErrors, [], `Script errors: ${llm.scriptErrors.join('\n')}`);
		assert.ok(fs.existsSync(p('.kodia/ai/rag/aegis-kb.json')), 'RAG index must exist on disk');
		assert.ok(fs.existsSync(p('.kodia/ai/experiments.json')), 'Experiments store must exist on disk');
		assert.ok(fs.existsSync(p('.kodia/ai/model-registry.json')), 'Model registry must exist on disk');
		assert.ok(fs.existsSync(p('.kodia/ai/workflows.json')), 'Workflows store must exist on disk');
		assert.ok(fs.existsSync(p('.kodia/ai/evaluations.json')), 'Evaluations store must exist on disk');
	});

	test('Demonstration F (Non-AI Software Regression): ordinary software project routes strictly to universal_only with zero forced AI', async () => {
		const aiMain = store.add(new KodiaAIEngineMainService());
		let step = 0;

		const lastToolContent = (req: RecordedRequest): string => {
			const last = req.messages[req.messages.length - 1] as { content?: string } | undefined;
			return typeof last?.content === 'string' ? last.content : JSON.stringify(last ?? '');
		};

		const llm = new ScriptedLLMService((_i, req: RecordedRequest): ScriptStep => {
			switch (step++) {
				case 0:
					return {
						text: 'Checking engine routing for ordinary software request.',
						toolCalls: [
							{
								name: 'ai_orchestrate_project',
								params: {
									request: 'Build a TypeScript CLI unit converter and invoice calculator with SQLite storage and unit tests.',
								},
							},
						],
					};
				case 1:
					assert.match(lastToolContent(req), /universal_only/, 'Ordinary software MUST route to universal_only');
					assert.match(lastToolContent(req), /Requires AI: NO/, 'Ordinary software MUST NOT force AI');
					return {
						text: '',
						toolCalls: [
							{
								name: 'write_file',
								params: {
									uri: p('src/converter.ts'),
									new_content: 'export function celsiusToFahrenheit(c: number): number {\n\treturn (c * 9) / 5 + 32;\n}\n',
								},
							},
						],
					};
				default:
					return { text: 'Built pure TypeScript converter with Kodia Universal Software Engineering Engine (no unnecessary AI added).' };
			}
		});

		const base = createHarness(dir, llm, store, {
			modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-universal-test' },
			overridesOfModel: { openAICompatible: { 'kodia-universal-test': { contextWindow: 128_000, specialToolFormat: 'openai-style' } } },
			globalSettings: { verifyBeforeFinishing: false },
			mainProcessServices: {
				[KODIA_AI_ENGINE_CHANNEL]: aiMain,
			},
		});

		await runTurn(base.chat, 'Build a TypeScript CLI unit converter and invoice calculator with SQLite storage.', 60_000);
		assert.deepStrictEqual(llm.scriptErrors, [], `Script errors: ${llm.scriptErrors.join('\n')}`);
		assert.ok(fs.existsSync(p('src/converter.ts')));
		assert.ok(!fs.existsSync(p('.kodia/ai/rag')), 'Non-AI project must not create unwanted AI RAG directories');
	});
});
