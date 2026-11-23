/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	AI_CAPABILITY_CATALOGUE,
	AI_DISCIPLINES,
	analyzeAIResearchTopic,
	auditAISecurityWorkspace,
	chunkDocumentForRag,
	compileNaturalLanguageWorkflow,
	designAIArchitecture,
	diagnoseAIFailure,
	discoverAICapabilities,
	estimateAIPerformanceAndCost,
	generateOneCommandFactoryBlueprint,
	recommendTrainingStrategy,
	routeEngineeringRequest,
	searchRagChunksHybrid,
} from '../../common/aiEngineeringKnowledge.js';
import { ComputeHardwareProfile } from '../../common/aiEngineeringTypes.js';
import { assessRisk } from '../../common/autonomyPolicy.js';
import { routingRoleForContext } from '../../common/modelRouting.js';
import { builtinTools } from '../../common/prompt/prompts.js';
import { SUBAGENT_TYPES } from '../../common/subagents.js';
import { getToolCategory, getToolDisplayTitles } from '../../common/toolDisplayMeta.js';

const ALL_20_AI_TOOLS = [
	'ai_orchestrate_project',
	'ai_design_architecture',
	'ai_probe_compute_hardware',
	'ai_recommend_training_strategy',
	'ai_profile_dataset',
	'ai_rag_build_index',
	'ai_rag_query',
	'ai_rag_evaluate',
	'ai_experiment_manage',
	'ai_model_registry',
	'ai_evaluate_system',
	'ai_audit_security',
	'ai_estimate_performance_cost',
	'ai_create_workflow',
	'ai_run_workflow',
	'ai_research_analyze',
	'ai_discover_capabilities',
	'ai_scaffold_product_factory',
	'ai_diagnose_failure',
	'ai_check_provider_capabilities',
] as const;

const MEDIUM_RISK_AI_TOOLS = new Set<string>([
	'ai_rag_build_index',
	'ai_experiment_manage',
	'ai_model_registry',
	'ai_create_workflow',
	'ai_run_workflow',
]);

const ALL_13_AI_SPECIALISTS = [
	'ai_architect',
	'ml_engineer',
	'llm_engineer',
	'rag_engineer',
	'agentic_engineer',
	'data_engineer',
	'cv_engineer',
	'speech_audio',
	'mlops',
	'ai_security',
	'ai_eval',
	'ai_research',
	'robotics_iot',
] as const;

suite('Kodia - Universal AI Engineering Engine & Two-Engine Unified Orchestrator', () => {
	test('registers all 20 AI engineering tools with schemas, display titles, ai category, and risk policy', () => {
		for (const toolName of ALL_20_AI_TOOLS) {
			assert.ok(toolName in builtinTools, `Missing schema in builtinTools: ${toolName}`);
			const titles = getToolDisplayTitles(toolName);
			assert.ok(titles.done && titles.proposed && titles.running, `Missing display titles for ${toolName}`);
			assert.strictEqual(getToolCategory(toolName), 'ai', `Expected 'ai' category for ${toolName}`);
			const expectedRisk = MEDIUM_RISK_AI_TOOLS.has(toolName) ? 'medium' : 'low';
			assert.strictEqual(assessRisk(toolName, {}), expectedRisk, `Unexpected risk level for ${toolName}`);
		}
	});

	test('registers all 13 AI specialist subagents and routes them to model buckets', () => {
		for (const role of ALL_13_AI_SPECIALISTS) {
			const profile = SUBAGENT_TYPES[role];
			assert.ok(profile, `Missing specialist subagent profile: ${role}`);
			assert.ok(profile.guidance.length > 40, `Specialist ${role} must have substantive guidance`);
			const bucket = routingRoleForContext({ subagentRole: role });
			assert.ok(bucket, `Specialist ${role} must map to a model routing bucket`);
		}
		assert.strictEqual(AI_DISCIPLINES.length, 12, 'Must cover all 12 core AI disciplines');
	});

	test('Two-Engine Unified Orchestrator routes Demonstrations A-E to AI/Dual-Engine and Demonstration F strictly to universal_only', () => {
		// Demonstration A: AI Chatbot Application
		const demoA = routeEngineeringRequest('Build a React and Node customer support AI chatbot with streaming responses and escalation');
		assert.strictEqual(demoA.engineMode, 'dual_engine_unified');
		assert.strictEqual(demoA.requiresAI, true);
		assert.ok(demoA.detectedDisciplines.includes('conversational_ai'));

		// Demonstration B: RAG Knowledge Application
		const demoB = routeEngineeringRequest('Build a document QA RAG knowledge base with hybrid vector search, embeddings, and line-level citations');
		assert.strictEqual(demoB.requiresAI, true);
		assert.ok(demoB.detectedDisciplines.includes('rag_knowledge'));

		// Demonstration C: Computer Vision System
		const demoC = routeEngineeringRequest('Build a Python PyTorch YOLO computer vision object detection and defect inspection pipeline with web dashboard');
		assert.strictEqual(demoC.engineMode, 'dual_engine_unified');
		assert.ok(demoC.detectedDisciplines.includes('computer_vision'));

		// Demonstration D: Agentic Automation Workflow
		const demoD = routeEngineeringRequest('Create an autonomous multi-agent workflow with tool calling, scheduled triggers, and human approval gates');
		assert.strictEqual(demoD.requiresAI, true);
		assert.ok(demoD.detectedDisciplines.includes('agentic_ai') || demoD.detectedDisciplines.includes('ai_automation'));

		// Demonstration E: Mixed-Stack AI Product (Healthcare high-impact notice)
		const demoE = routeEngineeringRequest('Build a full-stack clinical patient triage SaaS web application with mobile app, FastAPI backend, RAG medical citations, and speech transcription');
		assert.strictEqual(demoE.engineMode, 'dual_engine_unified');
		assert.ok(demoE.detectedDisciplines.includes('rag_knowledge'));
		assert.ok(demoE.detectedDisciplines.includes('speech_audio'));
		assert.ok(demoE.highImpactDomainFlags.length >= 1, 'Healthcare/clinical product must surface high-impact governance notice');

		// Demonstration F: Non-AI Software Regression — MUST NOT force AI (including substring traps like "storage", "microservice", "URL", "cross-platform")!
		const nonAiPrompts = [
			'Build a TypeScript CLI calculator and unit converter with SQLite storage and unit tests',
			'Create a REST API microservice in Go with PostgreSQL CRUD endpoints and URL shortener',
			'Build a responsive cross-platform React portfolio website with dark mode and contact form',
		];
		for (const prompt of nonAiPrompts) {
			const res = routeEngineeringRequest(prompt);
			assert.strictEqual(res.engineMode, 'universal_only', `Non-AI prompt MUST route to universal_only: "${prompt}"`);
			assert.strictEqual(res.requiresAI, false, `Non-AI prompt MUST NOT require AI: "${prompt}"`);
			assert.strictEqual(res.detectedDisciplines.length, 0, `Non-AI prompt MUST have 0 AI disciplines: "${prompt}"`);
		}
	});

	test('designs AI architecture and generates One-Command AI Product Factory Blueprint', () => {
		const arch = designAIArchitecture({
			projectTitle: 'PulseOps AI',
			requirements: 'Enterprise SaaS platform with TypeScript frontend, Python FastAPI backend, hybrid RAG, and agentic incident triage.',
			computePreference: 'hybrid',
		});
		assert.strictEqual(arch.engineMode, 'dual_engine_unified');
		assert.ok(arch.recommendedArchitecture.recommended);
		assert.ok(arch.alternatives.length >= 2);
		assert.ok(arch.mermaidDiagram.includes('flowchart'));
		assert.ok(arch.securityControls.length >= 3);

		const blueprint = generateOneCommandFactoryBlueprint({
			projectTitle: 'PulseOps AI',
			objective: 'Enterprise SaaS platform with hybrid RAG and autonomous incident triage workflow',
			computePreference: 'hybrid',
		});
		assert.ok(blueprint.phases.length >= 5, 'Factory blueprint must cover multi-phase lifecycle');
		assert.ok(blueprint.sharedContracts.length >= 3);
		assert.ok(blueprint.productionReadinessChecklist.length >= 4);
		assert.ok(blueprint.explicitAssumptions.length >= 1);
	});

	test('recommends hardware-aware training strategies across tabular, small-data RAG, single-GPU QLoRA, edge, and cloud offload', () => {
		const cpuHw: ComputeHardwareProfile = {
			platform: 'win32',
			arch: 'x64',
			cpuModel: 'Test CPU',
			cpuCount: 8,
			totalMemoryGb: 16,
			freeMemoryGb: 8,
			gpus: [],
			hasCuda: false,
			hasAppleSilicon: false,
			runtimes: [],
			recommendedComputeTier: 'cpu-only',
			summary: 'cpu-only',
		};
		const gpu24Hw: ComputeHardwareProfile = {
			...cpuHw,
			gpus: [{ name: 'NVIDIA RTX 4090', vendor: 'nvidia', vramMb: 24576 }],
			hasCuda: true,
			recommendedComputeTier: 'single-gpu',
		};

		const tabular = recommendTrainingStrategy({ taskType: 'tabular churn classification', datasetRows: 50_000, hardware: cpuHw });
		assert.strictEqual(tabular.recommendedApproach, 'classical-ml-cpu');

		const smallRag = recommendTrainingStrategy({ taskType: 'customer support qa rag', datasetRows: 80, hardware: cpuHw });
		assert.strictEqual(smallRag.recommendedApproach, 'prompt-engineering-and-rag');

		const edge = recommendTrainingStrategy({ taskType: 'vision object detection', datasetRows: 5000, modelSizeBillions: 7, deploymentTarget: 'jetson edge', hardware: gpu24Hw });
		assert.strictEqual(edge.recommendedApproach, 'distillation-and-quantization');

		const qlora = recommendTrainingStrategy({ taskType: 'llm instruction fine-tuning', datasetRows: 10_000, modelSizeBillions: 14, hardware: gpu24Hw });
		assert.strictEqual(qlora.recommendedApproach, 'qlora-peft');

		const cloud = recommendTrainingStrategy({ taskType: 'llm domain adaptation', datasetRows: 20_000, modelSizeBillions: 70, hardware: cpuHw });
		assert.strictEqual(cloud.recommendedApproach, 'cloud-distributed-training');
		assert.strictEqual(cloud.computeTier, 'cloud-offload');
	});

	test('estimates AI performance and cost across local, fast, and flagship tiers', () => {
		const est = estimateAIPerformanceAndCost({
			workloadName: 'Enterprise RAG Assistant',
			monthlyRequests: 100_000,
			avgInputTokens: 1500,
			avgOutputTokens: 350,
		});
		assert.strictEqual(est.estimatedMonthlyTokens, 100_000 * 1850);
		assert.ok(est.tiers.length >= 3);
		assert.strictEqual(est.tiers[0].estimatedMonthlyCostUsd, 0, 'Local tier must have $0 API token cost');
		assert.ok(est.optimizations.length >= 3);
	});

	test('chunks documents with heading/line tracking and retrieves grounded citations via hybrid BM25 + semantic scoring', () => {
		const doc1 = [
			'# Authentication & Token Rotation',
			'Access tokens expire after 15 minutes and refresh tokens rotate on every use.',
			'Hardware FIDO2 keys are required for production deployments.',
		].join('\n');
		const doc2 = [
			'# Billing & Refund Terms',
			'Monthly invoices are generated on the first business day.',
			'Annual plans include a 30-day money-back guarantee.',
		].join('\n');

		const chunks = [
			...chunkDocumentForRag({ sourcePath: 'docs/auth.md', content: doc1, chunkSize: 300, chunkOverlap: 40 }),
			...chunkDocumentForRag({ sourcePath: 'docs/billing.md', content: doc2, chunkSize: 300, chunkOverlap: 40 }),
		];
		assert.ok(chunks.length >= 2);

		const search = searchRagChunksHybrid(chunks, 'How long before access tokens expire with FIDO2?', { topK: 2 });
		assert.ok(search.results.length >= 1);
		assert.strictEqual(search.results[0].sourcePath, 'docs/auth.md');
		assert.ok(search.results[0].citation.includes('docs/auth.md:'));
		assert.ok(search.groundedContextBlock.includes('15 minutes'));
	});

	test('audits AI security across unsafe deserialization, eval on LLM output, prompt injection, hardcoded keys, and high-impact domains', () => {
		const fakeKey = ['sk-proj-', 'abcdefghijklmnopqrstuvwxyz123456'].join('');
		const audit = auditAISecurityWorkspace([
			{
				path: 'src/unsafe_agent.py',
				content: [
					'import pickle, torch',
					'model = pickle.loads(raw_bytes)',
					'ckpt = torch.load("weights.pt")',
					'result = eval(llm_response)',
					`system_prompt = f"You are helpful. User said: {user_input}"`,
					`API_KEY = "${fakeKey}"`,
					'patient_diagnosis = "clinical triage"',
				].join('\n'),
			},
		]);

		assert.ok(audit.criticalCount >= 3, `Expected >=3 critical findings, got ${audit.criticalCount}`);
		assert.ok(audit.highCount >= 2, `Expected >=2 high findings, got ${audit.highCount}`);
		assert.ok(audit.findings.some(f => f.category === 'unsafe-deserialization'));
		assert.ok(audit.findings.some(f => f.category === 'output-validation'));
		assert.ok(audit.findings.some(f => f.category === 'prompt-injection'));
		assert.ok(audit.findings.some(f => f.category === 'secret-leak'));
		assert.ok(audit.highImpactNotices.length >= 1);
		assert.ok(audit.score < 30);
	});

	test('compiles NL workflows with HITL gates, analyzes AI research topics, diagnoses failures, and queries Future Capability Catalogue', () => {
		const wf = compileNaturalLanguageWorkflow({
			name: 'Daily Contract Review',
			instruction: 'Every day search legal RAG documents, summarize risks, require human approval before publishing report.',
		});
		assert.strictEqual(wf.trigger, 'schedule');
		assert.ok(wf.steps.some(s => s.kind === 'retrieve'));
		assert.ok(wf.steps.some(s => s.kind === 'human_approval' && s.requiresApproval));

		const brief = analyzeAIResearchTopic('Hybrid RAG with reranking and quantized small language models');
		assert.ok(brief.establishedApproaches.length >= 2);
		assert.ok(brief.hypotheses.length >= 2);
		assert.ok(brief.epistemicNote.length > 20);

		const oom = diagnoseAIFailure({ errorSummary: 'RuntimeError: CUDA out of memory. Tried to allocate 4.00 GiB' });
		assert.strictEqual(oom.category, 'training_oom');
		assert.ok(oom.concreteRepairs.length >= 2);

		const allCaps = discoverAICapabilities();
		assert.strictEqual(allCaps.length, AI_CAPABILITY_CATALOGUE.length);
		assert.ok(allCaps.length >= 6);
		const mcpCaps = discoverAICapabilities('mcp', 'protocol');
		assert.ok(mcpCaps.length >= 1);
	});
});
