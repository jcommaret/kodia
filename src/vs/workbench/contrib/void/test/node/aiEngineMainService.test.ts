/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Node-side real filesystem & process verification for KodiaAIEngineMainService:
 * - Real compute hardware & AI runtime probing (os.cpus / memory / CLI / Python libraries)
 * - Real dataset profiling (CSV with missing values, duplicates, PII, imbalance + JSONL)
 * - Real persisted hybrid BM25 + semantic RAG index build, query, citation & quantitative evaluation
 * - Real experiment tracking (create, log, compare) & model registry (disk artifact verification, stage promotion)
 * - Real quantitative evaluation harness (classification, regression, agent trajectories, generation)
 * - Real persisted workflow execution with Human-in-the-Loop (HITL) approval gate pause & resume
 */

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KodiaAIEngineMainService } from '../../electron-main/aiEngineMainService.js';
import { compileNaturalLanguageWorkflow } from '../../common/aiEngineeringKnowledge.js';

suite('Kodia - AI Engineering Main Service (Real Compute, Data, RAG, Registry, Evals & Workflows)', function () {
	this.timeout(30_000);

	let dir: string;
	let service: KodiaAIEngineMainService;

	setup(() => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-ai-main-')));
		service = new KodiaAIEngineMainService();
	});

	teardown(() => {
		service.dispose();
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	});

	test('probeComputeHardware inspects real host CPU, RAM, platform, and installed runtimes', async () => {
		const hw = await service.probeComputeHardware(dir);
		assert.strictEqual(hw.platform, os.platform());
		assert.strictEqual(hw.arch, os.arch());
		assert.ok(hw.cpuCount >= 1, 'Must detect at least 1 CPU core');
		assert.ok(hw.totalMemoryGb > 0, 'Must detect positive system RAM');
		assert.ok(Array.isArray(hw.runtimes) && hw.runtimes.length >= 4, 'Must probe core runtimes');
		const nodeRuntime = hw.runtimes.find(r => r.name === 'node');
		assert.ok(nodeRuntime?.available, 'Node runtime must be detected as available');
		assert.ok(hw.summary.includes('CPUs') && hw.summary.includes('Tier:'));
	});

	test('profileDataset profiles real CSV (schema, duplicates, missing rate, PII, SHA-256) and JSONL', async () => {
		const dataDir = path.join(dir, 'data');
		fs.mkdirSync(dataDir, { recursive: true });
		const csvPath = path.join(dataDir, 'customers.csv');
		fs.writeFileSync(csvPath, [
			'customer_id,email,monthly_spend,churned',
			'1,alice@example.com,120.5,no',
			'2,bob@example.com,89.0,no',
			'3,carol@example.com,,no',
			'4,dave@example.com,210.0,no',
			'5,eve@example.com,95.5,no',
			'6,frank@example.com,140.0,no',
			'7,grace@example.com,132.0,no',
			'8,heidi@example.com,110.0,no',
			'9,ivan@example.com,105.0,no',
			'10,judy@example.com,99.0,yes',
			'1,alice@example.com,120.5,no',
		].join('\n'), 'utf8');

		const report = await service.profileDataset(dir, 'data/customers.csv');
		assert.strictEqual(report.error, undefined);
		assert.strictEqual(report.format, 'csv');
		assert.strictEqual(report.rowCount, 11);
		assert.strictEqual(report.columnCount, 4);
		assert.strictEqual(report.duplicateRowCount, 1, 'Must detect exact duplicate row');
		assert.match(report.sha256Fingerprint, /^[0-9a-f]{24,64}$/, 'Must compute real SHA-256 hex fingerprint');
		assert.ok(report.piiWarnings.some(w => /email/i.test(w)), 'Must detect email PII column/values');
		const spendCol = report.columns.find(c => c.name === 'monthly_spend');
		assert.ok(spendCol, 'Must profile monthly_spend column');
		assert.strictEqual(spendCol!.missingCount, 1);
		assert.ok(spendCol!.numericStats && spendCol!.numericStats.max === 210);
		assert.ok(report.qualityScore >= 0 && report.qualityScore <= 100);

		const jsonlPath = path.join(dataDir, 'samples.jsonl');
		fs.writeFileSync(jsonlPath, [
			JSON.stringify({ prompt: 'reset password', label: 'auth', latency_ms: 42 }),
			JSON.stringify({ prompt: 'refund invoice', label: 'billing', latency_ms: 58 }),
			JSON.stringify({ prompt: 'api rate limit', label: 'platform', latency_ms: 37 }),
		].join('\n'), 'utf8');

		const jsonlReport = await service.profileDataset(dir, 'data/samples.jsonl');
		assert.strictEqual(jsonlReport.error, undefined);
		assert.strictEqual(jsonlReport.format, 'jsonl');
		assert.strictEqual(jsonlReport.rowCount, 3);
		assert.strictEqual(jsonlReport.columnCount, 3);
	});

	test('buildRagIndex, queryRagIndex, and evaluateRagIndex persist and evaluate real hybrid retrieval', async () => {
		const docsDir = path.join(dir, 'docs');
		fs.mkdirSync(docsDir, { recursive: true });
		fs.writeFileSync(path.join(docsDir, 'refund-policy.md'), [
			'# Refund & Billing Policy',
			'Enterprise customers may request a full refund within 30 days of annual invoice settlement.',
			'Escalations above $5,000 require finance manager approval before payout.',
		].join('\n'), 'utf8');
		fs.writeFileSync(path.join(docsDir, 'sso-security.md'), [
			'# Enterprise SSO & SAML Configuration',
			'Configure SAML 2.0 identity providers with SHA-256 signed assertions and enforced MFA.',
			'Rotate signing certificates every 180 days via the security control plane.',
		].join('\n'), 'utf8');
		fs.writeFileSync(path.join(docsDir, 'rate-limits.md'), [
			'# API Rate Limits & Quotas',
			'Standard workspace keys allow 600 requests per minute with exponential backoff on HTTP 429.',
		].join('\n'), 'utf8');

		const summary = await service.buildRagIndex(dir, {
			indexName: 'support-kb',
			sourcePaths: ['docs'],
			chunkSize: 500,
			chunkOverlap: 60,
		});
		assert.strictEqual(summary.indexName, 'support-kb');
		assert.strictEqual(summary.documentCount, 3);
		assert.ok(summary.chunkCount >= 3);
		assert.ok(fs.existsSync(path.join(dir, '.kodia', 'ai', 'rag', 'support-kb.json')), 'Index must persist on disk');

		const listed = await service.listRagIndexes(dir);
		assert.strictEqual(listed.length, 1);

		const queryRes = await service.queryRagIndex(dir, {
			indexName: 'support-kb',
			query: 'How many days do enterprise customers have for a refund?',
			topK: 3,
		});
		assert.strictEqual(queryRes.error, undefined);
		assert.ok(queryRes.results.length >= 1);
		assert.ok(queryRes.results[0].sourcePath.includes('refund-policy.md'), `Expected refund-policy.md top-1, got ${queryRes.results[0].sourcePath}`);
		assert.ok(queryRes.results[0].citation.includes('[1]'));

		const evalReport = await service.evaluateRagIndex(dir, {
			indexName: 'support-kb',
			topK: 2,
			cases: [
				{ query: 'annual invoice refund 30 days', expectedSources: ['refund-policy.md'], expectedTerms: ['30 days', 'refund'] },
				{ query: 'SAML 2.0 certificate rotation MFA', expectedSources: ['sso-security.md'], expectedTerms: ['SAML', '180 days'] },
				{ query: 'HTTP 429 exponential backoff requests per minute', expectedSources: ['rate-limits.md'], expectedTerms: ['600', '429'] },
			],
		});
		assert.strictEqual(evalReport.passed, true, `RAG eval must pass, got hitRate=${evalReport.hitRateAtK}, mrr=${evalReport.mrr}`);
		assert.ok(evalReport.hitRateAtK >= 0.99);
		assert.ok(evalReport.mrr >= 0.99);
	});

	test('manageExperiments and manageModelRegistry track runs, verify real disk artifacts, and promote stages', async () => {
		const exp1 = await service.manageExperiments(dir, {
			action: 'create',
			name: 'churn-gbdt-baseline',
			discipline: 'machine_learning',
			modelRef: 'lightgbm-v1',
			datasetRef: 'data/customers.csv',
			hyperparameters: { max_depth: 5, learning_rate: 0.05 },
			metrics: { f1: 0.84, roc_auc: 0.89 },
		});
		assert.ok(exp1.experiment?.id);

		const exp2 = await service.manageExperiments(dir, {
			action: 'create',
			name: 'churn-gbdt-tuned',
			discipline: 'machine_learning',
			modelRef: 'lightgbm-v2',
			metrics: { f1: 0.91, roc_auc: 0.95 },
		});
		assert.ok(exp2.experiment?.id);

		await service.manageExperiments(dir, {
			action: 'log',
			id: exp2.experiment!.id,
			status: 'completed',
			metrics: { f1: 0.92 },
			notes: 'Cross-validated with stratified 5-fold CV',
		});

		const compared = await service.manageExperiments(dir, { action: 'compare', metricKey: 'f1' });
		assert.strictEqual(compared.bestExperimentId, exp2.experiment!.id);

		const artifactsDir = path.join(dir, 'models');
		fs.mkdirSync(artifactsDir, { recursive: true });
		fs.writeFileSync(path.join(artifactsDir, 'churn_v2.onnx'), Buffer.from('ONNX-MODEL-PLACEHOLDER-BYTES'));

		const reg = await service.manageModelRegistry(dir, {
			action: 'register',
			name: 'churn-predictor',
			version: '2.0.0',
			framework: 'onnxruntime',
			taskType: 'classification',
			artifactPath: 'models/churn_v2.onnx',
			experimentId: exp2.experiment!.id,
			metrics: { f1: 0.92 },
		});
		assert.ok(reg.model?.id);
		assert.strictEqual(reg.model!.artifactVerifiedOnDisk, true, 'Must verify real model artifact exists on disk');
		assert.strictEqual(reg.model!.stage, 'experimental');

		const promoted = await service.manageModelRegistry(dir, {
			action: 'promote',
			id: reg.model!.id,
			stage: 'staging',
		});
		assert.strictEqual(promoted.model?.stage, 'staging');
	});

	test('runAIModelEvaluation computes real classification, regression, and agent trajectory metrics', async () => {
		const cls = await service.runAIModelEvaluation(dir, {
			name: 'intent-classifier-eval',
			taskType: 'classification',
			records: [
				{ expected: 'billing', predicted: 'billing' },
				{ expected: 'billing', predicted: 'billing' },
				{ expected: 'security', predicted: 'security' },
				{ expected: 'security', predicted: 'security' },
				{ expected: 'platform', predicted: 'billing' },
				{ expected: 'platform', predicted: 'platform' },
			],
			minPassScore: 0.75,
		});
		assert.strictEqual(cls.passed, true);
		assert.ok(cls.metrics.accuracy > 0.8);
		assert.ok(cls.metrics.macro_f1 >= 0.75);

		const reg = await service.runAIModelEvaluation(dir, {
			name: 'latency-forecast-eval',
			taskType: 'regression',
			records: [
				{ expected: 100, predicted: 102 },
				{ expected: 200, predicted: 196 },
				{ expected: 300, predicted: 305 },
				{ expected: 400, predicted: 398 },
			],
			minPassScore: 0.95,
		});
		assert.strictEqual(reg.passed, true);
		assert.ok(reg.metrics.r2 > 0.99);
		assert.ok(reg.metrics.mae < 5);

		const agent = await service.runAIModelEvaluation(dir, {
			name: 'support-agent-eval',
			taskType: 'agent',
			records: [
				{ completed: true, tool_accuracy: 1.0, steps: 3 },
				{ completed: true, tool_accuracy: 0.9, steps: 4 },
				{ completed: true, tool_accuracy: 1.0, steps: 2 },
				{ completed: false, tool_accuracy: 0.5, steps: 6 },
			],
			minPassScore: 0.75,
		});
		assert.strictEqual(agent.passed, true);
		assert.strictEqual(agent.metrics.task_completion_rate, 0.75);

		const history = await service.listEvaluations(dir);
		assert.strictEqual(history.length, 3);
	});

	test('saveWorkflow & executeWorkflow enforce Human-in-the-Loop approval gate before high-impact action', async () => {
		const wf = compileNaturalLanguageWorkflow({
			name: 'Billing Escalation Pipeline',
			instruction: 'Search refund knowledge base, draft resolution, require human approval before payment refund, and evaluate output.',
		});
		assert.ok(wf.steps.some(s => s.requiresApproval), 'Workflow mentioning approval/payment must include HITL gate');

		await service.saveWorkflow(dir, wf);
		const listed = await service.listWorkflows(dir);
		assert.strictEqual(listed.length, 1);

		const paused = await service.executeWorkflow(dir, {
			workflowId: wf.id,
			inputContext: 'Ticket #8812 refund request',
			approveHumanGates: false,
		});
		assert.strictEqual(paused.status, 'paused_for_approval', 'Must pause at HITL gate when unapproved');
		assert.ok(paused.stepTraces.some(t => t.status === 'paused_for_approval'));

		const completed = await service.executeWorkflow(dir, {
			workflowId: wf.id,
			inputContext: 'Ticket #8812 refund request',
			approveHumanGates: true,
		});
		assert.strictEqual(completed.status, 'completed', 'Must complete all steps once HITL gate is approved');
		assert.strictEqual(completed.stepTraces.length, wf.steps.length);
	});
});
