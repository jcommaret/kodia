/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export type FactoryProjectProfileId =
	| 'web-app'
	| 'saas-platform'
	| 'api-backend'
	| 'ecommerce'
	| 'desktop-electron'
	| 'cli-tool'
	| 'ai-agent-system'
	| 'data-pipeline';

export interface FactoryProjectProfile {
	readonly id: FactoryProjectProfileId;
	readonly label: string;
	readonly summary: string;
	readonly defaultStack: string;
	readonly deliverables: readonly string[];
}

export const FACTORY_PROJECT_PROFILES: readonly FactoryProjectProfile[] = [
	{
		id: 'web-app',
		label: 'Full-Stack Web App',
		summary: 'Responsive frontend, REST/JSON API, relational DB, auth, and automated tests.',
		defaultStack: 'TypeScript + React/Vite + Node/Express + SQLite/Postgres',
		deliverables: ['Architecture spec', 'Database schema & migrations', 'API endpoints', 'Responsive UI', 'Unit & E2E tests'],
	},
	{
		id: 'saas-platform',
		label: 'Multi-Tenant SaaS Platform',
		summary: 'Organizations, RBAC, billing hooks, admin console, audit logs, and CI config.',
		defaultStack: 'TypeScript + Next.js/React + API + Relational DB + RBAC',
		deliverables: ['Tenant data model', 'Auth & RBAC', 'Dashboard & settings', 'Audit trail', 'Verification suite'],
	},
	{
		id: 'api-backend',
		label: 'Backend API & Microservice',
		summary: 'Typed REST/OpenAPI service, validation, persistence, health checks, and contract tests.',
		defaultStack: 'Node/TypeScript or Python/FastAPI + OpenAPI + SQLite/Postgres',
		deliverables: ['OpenAPI schema', 'Validated routes', 'Repository layer', 'Integration tests', 'Dockerfile'],
	},
	{
		id: 'ecommerce',
		label: 'Enterprise E-Commerce',
		summary: 'Catalog, cart, checkout flow, order management, admin dashboard, and test fixtures.',
		defaultStack: 'TypeScript + React + Node API + SQLite/Postgres',
		deliverables: ['Product & order schema', 'Storefront UI', 'Checkout & payment adapter', 'Admin dashboard', 'Journey tests'],
	},
	{
		id: 'desktop-electron',
		label: 'Desktop Application',
		summary: 'Cross-platform Electron desktop app with secure preload IPC and offline storage.',
		defaultStack: 'Electron + TypeScript + React + SQLite',
		deliverables: ['Main/Preload IPC', 'Workbench UI', 'Local persistence', 'Packaging config', 'Smoke tests'],
	},
	{
		id: 'cli-tool',
		label: 'Developer CLI & SDK',
		summary: 'Zero-bloat CLI with subcommands, JSON output mode, config loading, and unit tests.',
		defaultStack: 'Node/TypeScript or Go',
		deliverables: ['Command parser', 'Core library SDK', 'Help & docs', 'Automated CLI tests'],
	},
	{
		id: 'ai-agent-system',
		label: 'AI Agent & Workflow Platform',
		summary: 'Tool-calling orchestration, provider abstraction, memory, evals, and observability.',
		defaultStack: 'TypeScript/Python + OpenAI-compatible SDK + Eval harness',
		deliverables: ['Tool registry', 'Execution loop', 'Memory & guardrails', 'Deterministic eval suite'],
	},
	{
		id: 'data-pipeline',
		label: 'Data / ETL Pipeline',
		summary: 'Schema validation, incremental extract/transform/load stages, lineage, and data quality tests.',
		defaultStack: 'Python or TypeScript + SQLite/DuckDB',
		deliverables: ['Schema contracts', 'Idempotent ETL stages', 'Data quality assertions', 'Runbook'],
	},
];

export type RequirementStatus = 'unstarted' | 'in_progress' | 'implemented' | 'verified';

export interface ProjectRequirement {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly priority: 'high' | 'medium' | 'low';
	readonly status: RequirementStatus;
	readonly acceptanceCriteria: readonly string[];
	readonly linkedFiles: readonly string[];
	readonly linkedTests: readonly string[];
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface AutopilotObjective {
	readonly id: string;
	readonly title: string;
	readonly instruction: string;
	readonly enabled: boolean;
	readonly runCount: number;
	readonly lastRunAt?: string;
	readonly lastThreadId?: string;
	readonly createdAt: string;
}

export interface ArchitectureDecisionRecord {
	readonly id: string;
	readonly title: string;
	readonly status: 'proposed' | 'accepted' | 'superseded';
	readonly context: string;
	readonly decision: string;
	readonly consequences: string;
	readonly relatedFiles: readonly string[];
	readonly createdAt: string;
}

export function buildSoftwareFactoryPrompt(idea: string, profileId: FactoryProjectProfileId, requirements: readonly ProjectRequirement[]): string {
	const profile = FACTORY_PROJECT_PROFILES.find(p => p.id === profileId) ?? FACTORY_PROJECT_PROFILES[0];
	const reqLines = requirements.length > 0
		? `\nTracked Requirements to satisfy:\n${requirements.map(r => `- [${r.id}] (${r.priority}) ${r.title}: ${r.description}`).join('\n')}\n`
		: '';

	return [
		`[Kodia Autonomous Software Factory — ${profile.label}]`,
		`Objective: ${idea.trim()}`,
		`Recommended Stack (adapt if workspace already uses another stack): ${profile.defaultStack}`,
		`Target Deliverables: ${profile.deliverables.join(', ')}`,
		reqLines,
		`Execution Protocol:`,
		`1. Inspect the existing workspace first (ls_dir, env_inspect, project_health_scan).`,
		`2. Create a structured Task Plan (create_task_plan) decomposing architecture, backend, frontend, database, tests, and verification.`,
		`3. Record key architectural decisions (record_architecture_decision) and keep requirements updated (factory_manage_requirements).`,
		`4. Implement all files directly using filesystem tools — never merely describe code.`,
		`5. Run real build, lint, tests, and evaluate_quality_gates; record verification proof via record_verification_evidence before finishing.`,
	].join('\n');
}

export function buildModelCouncilPrompt(question: string): string {
	return [
		`[Kodia Multi-Agent Architecture Council & Solution Competition]`,
		`Engineering Challenge: ${question.trim()}`,
		``,
		`Run an independent 3-perspective technical debate before implementing:`,
		`1. Spawn specialist subagents in parallel (architect, security, performance) or analyze from all three distinct lenses.`,
		`2. Produce at least 2 competing solution architectures with explicit trade-offs (complexity, security, performance, testability, migration risk).`,
		`3. Challenge assumptions and identify edge-case failure modes in each proposal.`,
		`4. Synthesize a concrete recommendation, record it via record_architecture_decision, and state the exact verification plan.`,
	].join('\n');
}

export function computeRequirementCoverage(reqs: readonly ProjectRequirement[]): {
	total: number;
	verified: number;
	implemented: number;
	unstarted: number;
	percentVerified: number;
} {
	const total = reqs.length;
	const verified = reqs.filter(r => r.status === 'verified').length;
	const implemented = reqs.filter(r => r.status === 'implemented' || r.status === 'verified').length;
	const unstarted = reqs.filter(r => r.status === 'unstarted').length;
	const percentVerified = total === 0 ? 0 : Math.round((verified / total) * 100);
	return { total, verified, implemented, unstarted, percentVerified };
}

export interface ISoftwareFactoryService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;

	getRequirements(): readonly ProjectRequirement[];
	addRequirement(input: { title: string; description: string; priority?: 'high' | 'medium' | 'low'; acceptanceCriteria?: readonly string[] }): ProjectRequirement;
	updateRequirement(id: string, patch: Partial<Pick<ProjectRequirement, 'title' | 'description' | 'priority' | 'status' | 'linkedFiles' | 'linkedTests'>>): ProjectRequirement | null;
	removeRequirement(id: string): void;

	getAutopilotObjectives(): readonly AutopilotObjective[];
	addAutopilotObjective(input: { title: string; instruction: string }): AutopilotObjective;
	toggleAutopilotObjective(id: string, enabled: boolean): void;
	removeAutopilotObjective(id: string): void;
	runAutopilotObjectiveNow(id: string): Promise<string | null>;

	getDecisions(): readonly ArchitectureDecisionRecord[];
	addDecision(input: { title: string; context: string; decision: string; consequences?: string; status?: 'proposed' | 'accepted' | 'superseded'; relatedFiles?: readonly string[] }): ArchitectureDecisionRecord;
	removeDecision(id: string): void;

	launchFactoryBuild(idea: string, profileId: FactoryProjectProfileId): Promise<string>;
	launchModelCouncil(question: string): Promise<string>;
}

export const ISoftwareFactoryService = createDecorator<ISoftwareFactoryService>('kodiaSoftwareFactoryService');
