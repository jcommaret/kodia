/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const KODIA_AI_ENGINE_CHANNEL = 'void-channel-ai-engine';

// ============================================================================
// Two-Engine Unified Orchestration & AI Discipline Taxonomy
// ============================================================================

export type EngineeringEngineMode = 'universal_only' | 'ai_only' | 'dual_engine_unified';

export type AIDisciplineId =
	| 'ai_research'
	| 'machine_learning'
	| 'deep_learning'
	| 'generative_ai'
	| 'llm_foundation'
	| 'agentic_ai'
	| 'rag_knowledge'
	| 'conversational_ai'
	| 'computer_vision'
	| 'speech_audio'
	| 'ai_automation'
	| 'iot_robotics_embodied';

export type AIEngineComputePreference = 'auto' | 'local-first' | 'hybrid' | 'cloud-first';

export interface AIEngineSettings {
	readonly enableUnifiedOrchestrator: boolean;
	readonly autoDetectAIRequirements: boolean;
	readonly computePreference: AIEngineComputePreference;
	readonly defaultRagChunkSize: number;
	readonly defaultRagChunkOverlap: number;
	readonly defaultRagTopK: number;
	readonly enforcePromptInjectionGuards: boolean;
	readonly enforcePiiRedaction: boolean;
	readonly requireHumanApprovalForHighImpact: boolean;
	readonly requireApprovalForPaidCompute: boolean;
	readonly monthlyBudgetLimitUsd: number;
	readonly enableFutureCapabilityDiscovery: boolean;
}

export const DEFAULT_AI_ENGINE_SETTINGS: AIEngineSettings = {
	enableUnifiedOrchestrator: true,
	autoDetectAIRequirements: true,
	computePreference: 'auto',
	defaultRagChunkSize: 800,
	defaultRagChunkOverlap: 120,
	defaultRagTopK: 5,
	enforcePromptInjectionGuards: true,
	enforcePiiRedaction: true,
	requireHumanApprovalForHighImpact: true,
	requireApprovalForPaidCompute: true,
	monthlyBudgetLimitUsd: 100,
	enableFutureCapabilityDiscovery: true,
};

export interface EngineRoutingDecision {
	readonly engineMode: EngineeringEngineMode;
	readonly requiresAI: boolean;
	readonly confidence: number;
	readonly detectedDisciplines: readonly AIDisciplineId[];
	readonly softwareDomains: readonly string[];
	readonly recommendedLanguages: readonly string[];
	readonly recommendedSpecialists: readonly string[];
	readonly rationale: string;
	readonly highImpactDomainFlags: readonly string[];
}

export interface UnifiedArchitectureOption {
	readonly name: string;
	readonly summary: string;
	readonly stack: readonly string[];
	readonly strengths: readonly string[];
	readonly tradeoffs: readonly string[];
	readonly estimatedMonthlyCostUsd: string;
	readonly estimatedLatencyMs: string;
	readonly recommended: boolean;
}

export interface AIArchitectureReport {
	readonly projectTitle: string;
	readonly engineMode: EngineeringEngineMode;
	readonly disciplines: readonly AIDisciplineId[];
	readonly recommendedArchitecture: UnifiedArchitectureOption;
	readonly alternatives: readonly UnifiedArchitectureOption[];
	readonly dataFlows: readonly string[];
	readonly inferenceFlows: readonly string[];
	readonly evaluationStrategy: readonly string[];
	readonly securityControls: readonly string[];
	readonly technicalRisks: readonly { readonly risk: string; readonly mitigation: string }[];
	readonly mermaidDiagram: string;
}

export interface ProductFactoryPhaseSpec {
	readonly phaseNumber: number;
	readonly name: string;
	readonly ownerEngine: 'universal' | 'ai' | 'unified';
	readonly specialists: readonly string[];
	readonly deliverables: readonly string[];
	readonly verificationGate: string;
}

export interface OneCommandFactoryBlueprint {
	readonly id: string;
	readonly createdAt: string;
	readonly objective: string;
	readonly routing: EngineRoutingDecision;
	readonly architecture: AIArchitectureReport;
	readonly sharedContracts: readonly string[];
	readonly phases: readonly ProductFactoryPhaseSpec[];
	readonly productionReadinessChecklist: readonly string[];
	readonly explicitAssumptions: readonly string[];
	readonly missingExternalDependencies: readonly string[];
}

// ============================================================================
// Hardware, Compute & Training Strategy Intelligence
// ============================================================================

export interface DetectedGpuInfo {
	readonly name: string;
	readonly vendor: 'nvidia' | 'apple' | 'amd' | 'intel' | 'unknown';
	readonly vramMb?: number;
	readonly driverVersion?: string;
	readonly cudaVersion?: string;
}

export interface AIRuntimeEntry {
	readonly name: string;
	readonly available: boolean;
	readonly version?: string;
	readonly category: 'language' | 'ml-framework' | 'llm-serving' | 'container' | 'mlops';
}

export interface ComputeHardwareProfile {
	readonly platform: string;
	readonly arch: string;
	readonly cpuModel: string;
	readonly cpuCount: number;
	readonly totalMemoryGb: number;
	readonly freeMemoryGb: number;
	readonly gpus: readonly DetectedGpuInfo[];
	readonly hasCuda: boolean;
	readonly hasAppleSilicon: boolean;
	readonly runtimes: readonly AIRuntimeEntry[];
	readonly recommendedComputeTier: 'cpu-only' | 'apple-silicon-unified' | 'single-gpu' | 'multi-gpu' | 'cloud-offload';
	readonly summary: string;
}

export interface TrainingStrategyRecommendation {
	readonly taskType: string;
	readonly modelSizeHint: string;
	readonly datasetRows: number;
	readonly computeTier: ComputeHardwareProfile['recommendedComputeTier'];
	readonly recommendedApproach: 'prompt-engineering-and-rag' | 'classical-ml-cpu' | 'qlora-peft' | 'lora-peft' | 'full-fine-tune' | 'distillation-and-quantization' | 'cloud-distributed-training';
	readonly precision: 'fp32' | 'fp16' | 'bf16' | 'int8' | 'nf4-qlora';
	readonly frameworkStack: readonly string[];
	readonly estimatedVramGb: number;
	readonly hyperparameters: Readonly<Record<string, string | number>>;
	readonly rationale: string;
	readonly reproducibilityChecklist: readonly string[];
}

// ============================================================================
// Data Engineering & Dataset Profiling
// ============================================================================

export interface DatasetColumnProfile {
	readonly name: string;
	readonly inferredType: 'number' | 'integer' | 'boolean' | 'string' | 'date' | 'object' | 'mixed' | 'empty';
	readonly nonNullCount: number;
	readonly missingCount: number;
	readonly missingRate: number;
	readonly uniqueCount: number;
	readonly sampleValues: readonly string[];
	readonly numericStats?: { readonly min: number; readonly max: number; readonly mean: number };
	readonly topCategories?: readonly { readonly value: string; readonly count: number }[];
}

export interface DatasetProfileReport {
	readonly datasetPath: string;
	readonly format: 'csv' | 'tsv' | 'json' | 'jsonl' | 'image-directory' | 'text-directory' | 'unknown';
	readonly sizeBytes: number;
	readonly sha256Fingerprint: string;
	readonly rowCount: number;
	readonly columnCount: number;
	readonly duplicateRowCount: number;
	readonly columns: readonly DatasetColumnProfile[];
	readonly piiWarnings: readonly string[];
	readonly qualityWarnings: readonly string[];
	readonly qualityScore: number;
	readonly cleaningRecommendations: readonly string[];
	readonly error?: string;
}

// ============================================================================
// RAG & Knowledge Engineering (Real Persisted Hybrid Index)
// ============================================================================

export interface RagDocumentChunk {
	readonly chunkId: string;
	readonly sourcePath: string;
	readonly sectionTitle?: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly text: string;
	readonly tokenEstimate: number;
	readonly metadata: Readonly<Record<string, string>>;
	readonly termFreq: Readonly<Record<string, number>>;
}

export interface RagIndexSummary {
	readonly indexName: string;
	readonly indexPath: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly documentCount: number;
	readonly chunkCount: number;
	readonly totalTokensEstimate: number;
	readonly chunkSize: number;
	readonly chunkOverlap: number;
	readonly strategy: 'hybrid-bm25-vector';
	readonly sources: readonly string[];
}

export interface RagRetrievedChunk {
	readonly rank: number;
	readonly chunkId: string;
	readonly sourcePath: string;
	readonly sectionTitle?: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly text: string;
	readonly hybridScore: number;
	readonly lexicalScore: number;
	readonly semanticScore: number;
	readonly citation: string;
}

export interface RagQueryResult {
	readonly indexName: string;
	readonly query: string;
	readonly expandedTerms: readonly string[];
	readonly totalChunksSearched: number;
	readonly results: readonly RagRetrievedChunk[];
	readonly groundedContextBlock: string;
	readonly latencyMs: number;
	readonly error?: string;
}

export interface RagEvalCaseResult {
	readonly query: string;
	readonly expectedSources: readonly string[];
	readonly retrievedSources: readonly string[];
	readonly hitAtK: boolean;
	readonly reciprocalRank: number;
	readonly precisionAtK: number;
	readonly recallAtK: number;
	readonly groundedTermCoverage: number;
}

export interface RagEvaluationReport {
	readonly indexName: string;
	readonly topK: number;
	readonly totalCases: number;
	readonly hitRateAtK: number;
	readonly meanPrecisionAtK: number;
	readonly meanRecallAtK: number;
	readonly mrr: number;
	readonly meanGroundedness: number;
	readonly passed: boolean;
	readonly cases: readonly RagEvalCaseResult[];
	readonly error?: string;
}

// ============================================================================
// Experiment Tracking, Model Registry & Quantitative Evaluations
// ============================================================================

export type ModelRegistryStage = 'experimental' | 'staging' | 'canary' | 'production' | 'archived';

export interface AIExperimentRecord {
	readonly id: string;
	readonly name: string;
	readonly discipline: AIDisciplineId | string;
	readonly status: 'running' | 'completed' | 'failed';
	readonly modelRef: string;
	readonly datasetRef?: string;
	readonly hyperparameters: Readonly<Record<string, string | number | boolean>>;
	readonly metrics: Readonly<Record<string, number>>;
	readonly artifacts: readonly string[];
	readonly notes?: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface ModelRegistryEntry {
	readonly id: string;
	readonly name: string;
	readonly version: string;
	readonly framework: string;
	readonly taskType: string;
	readonly stage: ModelRegistryStage;
	readonly artifactPath?: string;
	readonly artifactVerifiedOnDisk: boolean;
	readonly datasetRef?: string;
	readonly experimentId?: string;
	readonly quantization?: string;
	readonly metrics: Readonly<Record<string, number>>;
	readonly notes?: string;
	readonly registeredAt: string;
	readonly updatedAt: string;
}

export type AIEvaluationTaskType = 'classification' | 'regression' | 'agent' | 'rag' | 'generation';

export interface AIEvaluationReport {
	readonly id: string;
	readonly createdAt: string;
	readonly name: string;
	readonly taskType: AIEvaluationTaskType;
	readonly sampleCount: number;
	readonly metrics: Readonly<Record<string, number>>;
	readonly passed: boolean;
	readonly thresholdSummary: string;
	readonly details: readonly string[];
	readonly error?: string;
}

// ============================================================================
// AI Security, Cost/Performance, Workflows, Failure Diagnosis & Capabilities
// ============================================================================

export interface AISecurityFinding {
	readonly id: string;
	readonly severity: 'critical' | 'high' | 'medium' | 'low';
	readonly category: 'prompt-injection' | 'secret-leak' | 'unsafe-deserialization' | 'output-validation' | 'tool-permissions' | 'data-privacy' | 'supply-chain' | 'high-impact-governance';
	readonly title: string;
	readonly file?: string;
	readonly line?: number;
	readonly detail: string;
	readonly remediation: string;
}

export interface AISecurityAuditReport {
	readonly score: number;
	readonly filesScanned: number;
	readonly criticalCount: number;
	readonly highCount: number;
	readonly findings: readonly AISecurityFinding[];
	readonly protectionsDetected: readonly string[];
	readonly highImpactNotices: readonly string[];
	readonly summary: string;
}

export interface AIPerformanceCostEstimate {
	readonly workloadName: string;
	readonly monthlyRequests: number;
	readonly avgInputTokens: number;
	readonly avgOutputTokens: number;
	readonly estimatedMonthlyTokens: number;
	readonly tiers: readonly {
		readonly tier: string;
		readonly modelClass: string;
		readonly estimatedLatencyP50Ms: number;
		readonly estimatedLatencyP95Ms: number;
		readonly estimatedMonthlyCostUsd: number;
		readonly notes: string;
	}[];
	readonly optimizations: readonly string[];
}

export interface AIWorkflowStep {
	readonly id: string;
	readonly name: string;
	readonly kind: 'ingest' | 'retrieve' | 'llm_reason' | 'tool_action' | 'human_approval' | 'evaluate' | 'notify';
	readonly description: string;
	readonly toolOrAdapter?: string;
	readonly requiresApproval?: boolean;
	readonly maxRetries: number;
	readonly fallbackStepId?: string;
}

export interface AIWorkflowDefinition {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly trigger: 'manual' | 'schedule' | 'webhook' | 'event';
	readonly version: number;
	readonly steps: readonly AIWorkflowStep[];
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface AIWorkflowRunStepTrace {
	readonly stepId: string;
	readonly name: string;
	readonly status: 'completed' | 'paused_for_approval' | 'failed' | 'skipped';
	readonly durationMs: number;
	readonly output: string;
}

export interface AIWorkflowRunResult {
	readonly runId: string;
	readonly workflowId: string;
	readonly workflowName: string;
	readonly status: 'completed' | 'paused_for_approval' | 'failed';
	readonly startedAt: string;
	readonly completedAt: string;
	readonly stepTraces: readonly AIWorkflowRunStepTrace[];
	readonly summary: string;
}

export interface AIResearchBrief {
	readonly topic: string;
	readonly disciplines: readonly AIDisciplineId[];
	readonly establishedApproaches: readonly { readonly method: string; readonly strengths: string; readonly limitations: string; readonly benchmarkFocus: string }[];
	readonly hypotheses: readonly string[];
	readonly experimentDesign: {
		readonly baseline: string;
		readonly variables: readonly string[];
		readonly primaryMetrics: readonly string[];
		readonly reproducibilityControls: readonly string[];
	};
	readonly epistemicNote: string;
}

export interface AIFailureDiagnosisReport {
	readonly category: 'training_oom' | 'training_divergence' | 'rag_low_recall' | 'rag_hallucination' | 'agent_loop' | 'provider_rate_limit' | 'dataset_corruption' | 'inference_latency' | 'general_ai_failure';
	readonly severity: 'critical' | 'high' | 'medium';
	readonly likelyRootCauses: readonly string[];
	readonly diagnosticCommands: readonly string[];
	readonly concreteRepairs: readonly string[];
	readonly verificationSteps: readonly string[];
}

export interface AICapabilityCatalogueEntry {
	readonly id: string;
	readonly name: string;
	readonly category: 'discipline' | 'framework' | 'model-family' | 'protocol' | 'evaluation' | 'infrastructure' | 'emerging';
	readonly maturity: 'production' | 'emerging' | 'experimental';
	readonly summary: string;
	readonly whyItMatters: string;
	readonly dependencies: readonly string[];
	readonly compatibility: string;
	readonly securityImplications: string;
	readonly integrationStatus: 'built-in' | 'adapter-ready' | 'isolated-evaluation';
	readonly knownLimitations: string;
}

export interface ProviderCapabilitySummary {
	readonly providerName: string;
	readonly configured: boolean;
	readonly isLocal: boolean;
	readonly modelCount: number;
	readonly sampleModels: readonly string[];
	readonly supportsToolCalling: boolean;
	readonly supportsVision: boolean;
	readonly supportsReasoning: boolean;
}

// ============================================================================
// Main-Process AI Engine IPC Service Contract
// ============================================================================

export interface IKodiaAIEngineMainService {
	readonly _serviceBrand: undefined;

	probeComputeHardware(workspaceRoot: string): Promise<ComputeHardwareProfile>;

	profileDataset(workspaceRoot: string, datasetPath: string, opts?: { maxRows?: number }): Promise<DatasetProfileReport>;

	buildRagIndex(workspaceRoot: string, opts: {
		indexName: string;
		sourcePaths?: readonly string[];
		chunkSize?: number;
		chunkOverlap?: number;
		maxFiles?: number;
	}): Promise<RagIndexSummary>;

	listRagIndexes(workspaceRoot: string): Promise<RagIndexSummary[]>;

	queryRagIndex(workspaceRoot: string, opts: {
		indexName: string;
		query: string;
		topK?: number;
		sourceFilter?: string;
	}): Promise<RagQueryResult>;

	evaluateRagIndex(workspaceRoot: string, opts: {
		indexName: string;
		topK?: number;
		cases: readonly { query: string; expectedSources: readonly string[]; expectedTerms?: readonly string[] }[];
	}): Promise<RagEvaluationReport>;

	manageExperiments(workspaceRoot: string, opts: {
		action: 'list' | 'create' | 'log' | 'compare';
		id?: string;
		name?: string;
		discipline?: string;
		modelRef?: string;
		datasetRef?: string;
		status?: 'running' | 'completed' | 'failed';
		hyperparameters?: Record<string, string | number | boolean>;
		metrics?: Record<string, number>;
		artifacts?: readonly string[];
		notes?: string;
		metricKey?: string;
	}): Promise<{
		message: string;
		experiment?: AIExperimentRecord;
		experiments: AIExperimentRecord[];
		bestExperimentId?: string;
	}>;

	manageModelRegistry(workspaceRoot: string, opts: {
		action: 'list' | 'register' | 'promote' | 'inspect';
		id?: string;
		name?: string;
		version?: string;
		framework?: string;
		taskType?: string;
		stage?: ModelRegistryStage;
		artifactPath?: string;
		datasetRef?: string;
		experimentId?: string;
		quantization?: string;
		metrics?: Record<string, number>;
		notes?: string;
	}): Promise<{
		message: string;
		model?: ModelRegistryEntry;
		models: ModelRegistryEntry[];
	}>;

	runAIModelEvaluation(workspaceRoot: string, opts: {
		name: string;
		taskType: AIEvaluationTaskType;
		records: readonly Record<string, unknown>[];
		minPassScore?: number;
	}): Promise<AIEvaluationReport>;

	listEvaluations(workspaceRoot: string): Promise<AIEvaluationReport[]>;

	saveWorkflow(workspaceRoot: string, workflow: AIWorkflowDefinition): Promise<AIWorkflowDefinition>;
	listWorkflows(workspaceRoot: string): Promise<AIWorkflowDefinition[]>;
	executeWorkflow(workspaceRoot: string, opts: { workflowId: string; inputContext?: string; approveHumanGates?: boolean }): Promise<AIWorkflowRunResult>;
}

export const IKodiaAIEngineMainService = createDecorator<IKodiaAIEngineMainService>('kodiaAIEngineMainService');
