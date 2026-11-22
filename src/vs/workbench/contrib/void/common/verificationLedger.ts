/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export type VerificationLevel =
	| 'planned'
	| 'implemented'
	| 'static_checks'
	| 'compiled'
	| 'unit_tests'
	| 'integration_tests'
	| 'e2e_tests'
	| 'runtime_verified'
	| 'security_checked'
	| 'production_verified';

export const VERIFICATION_LEVEL_ORDER: readonly VerificationLevel[] = [
	'planned',
	'implemented',
	'static_checks',
	'compiled',
	'unit_tests',
	'integration_tests',
	'e2e_tests',
	'runtime_verified',
	'security_checked',
	'production_verified',
];

export const VERIFICATION_LEVEL_LABELS: Readonly<Record<VerificationLevel, string>> = {
	planned: '1. Planned',
	implemented: '2. Implemented',
	static_checks: '3. Static Checks',
	compiled: '4. Compiled / Built',
	unit_tests: '5. Unit Tests',
	integration_tests: '6. Integration Tests',
	e2e_tests: '7. E2E Tests',
	runtime_verified: '8. Runtime Verified',
	security_checked: '9. Security Checked',
	production_verified: '10. Production Verified',
};

export interface VerificationCheckResult {
	readonly name: string;
	readonly level: VerificationLevel;
	readonly passed: boolean;
	readonly detail: string;
	readonly command?: string;
	readonly timestamp: string;
}

export interface VerificationRecord {
	readonly id: string;
	readonly taskTitle: string;
	readonly summary: string;
	readonly highestLevel: VerificationLevel;
	readonly filesChanged: readonly string[];
	readonly checks: readonly VerificationCheckResult[];
	readonly failedChecks: readonly string[];
	readonly limitations: readonly string[];
	readonly qualityScore?: number;
	readonly passed: boolean;
	readonly createdAt: string;
}

export interface QualityGatePolicy {
	readonly maxCriticalFindings: number;
	readonly maxHighFindings: number;
	readonly minQualityScore: number;
	readonly maxCircularDependencies: number;
	readonly maxWorkspaceErrors: number;
}

export const DEFAULT_QUALITY_GATE_POLICY: QualityGatePolicy = {
	maxCriticalFindings: 0,
	maxHighFindings: 5,
	minQualityScore: 60,
	maxCircularDependencies: 20,
	maxWorkspaceErrors: 0,
};

export interface QualityGateEvaluation {
	readonly passed: boolean;
	readonly evaluatedAt: string;
	readonly gates: readonly {
		readonly id: string;
		readonly label: string;
		readonly passed: boolean;
		readonly actual: number;
		readonly threshold: string;
	}[];
}

export function computeHighestVerificationLevel(checks: readonly VerificationCheckResult[]): VerificationLevel {
	let highestIdx = 0;
	for (const check of checks) {
		if (!check.passed) { continue; }
		const idx = VERIFICATION_LEVEL_ORDER.indexOf(check.level);
		if (idx > highestIdx) {
			highestIdx = idx;
		}
	}
	return VERIFICATION_LEVEL_ORDER[highestIdx];
}

export function createVerificationRecord(input: {
	taskTitle: string;
	summary: string;
	filesChanged?: readonly string[];
	checks: readonly VerificationCheckResult[];
	limitations?: readonly string[];
	qualityScore?: number;
}): VerificationRecord {
	const checks = input.checks;
	const failedChecks = checks.filter(c => !c.passed).map(c => `${c.name}: ${c.detail}`);
	const highestLevel = computeHighestVerificationLevel(checks);
	const passed = checks.length > 0 && failedChecks.length === 0;
	return {
		id: `ver-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
		taskTitle: input.taskTitle.trim() || 'Engineering Verification',
		summary: input.summary.trim(),
		highestLevel,
		filesChanged: [...(input.filesChanged ?? [])],
		checks: [...checks],
		failedChecks,
		limitations: [...(input.limitations ?? [])],
		qualityScore: input.qualityScore,
		passed,
		createdAt: new Date().toISOString(),
	};
}

export function evaluateQualityGates(
	metrics: {
		criticalFindings: number;
		highFindings: number;
		qualityScore: number;
		circularDependencies: number;
		workspaceErrors: number;
	},
	policy: QualityGatePolicy = DEFAULT_QUALITY_GATE_POLICY,
): QualityGateEvaluation {
	const gates = [
		{
			id: 'critical-security',
			label: 'Critical Security / Secrets',
			passed: metrics.criticalFindings <= policy.maxCriticalFindings,
			actual: metrics.criticalFindings,
			threshold: `<= ${policy.maxCriticalFindings}`,
		},
		{
			id: 'high-security',
			label: 'High Security Findings',
			passed: metrics.highFindings <= policy.maxHighFindings,
			actual: metrics.highFindings,
			threshold: `<= ${policy.maxHighFindings}`,
		},
		{
			id: 'workspace-errors',
			label: 'Compiler / Diagnostic Errors',
			passed: metrics.workspaceErrors <= policy.maxWorkspaceErrors,
			actual: metrics.workspaceErrors,
			threshold: `<= ${policy.maxWorkspaceErrors}`,
		},
		{
			id: 'quality-score',
			label: 'Engineering Quality Score',
			passed: metrics.qualityScore >= policy.minQualityScore,
			actual: metrics.qualityScore,
			threshold: `>= ${policy.minQualityScore}/100`,
		},
		{
			id: 'circular-deps',
			label: 'Circular Dependencies',
			passed: metrics.circularDependencies <= policy.maxCircularDependencies,
			actual: metrics.circularDependencies,
			threshold: `<= ${policy.maxCircularDependencies}`,
		},
	];
	return {
		passed: gates.every(g => g.passed),
		evaluatedAt: new Date().toISOString(),
		gates,
	};
}

export function formatQualityGateEvaluationForLLM(evalResult: QualityGateEvaluation): string {
	const lines = [
		`Kodia Autonomous Quality Gates: ${evalResult.passed ? 'PASSED' : 'FAILED'} (${evalResult.evaluatedAt})`,
		...evalResult.gates.map(g => `- [${g.passed ? 'PASS' : 'FAIL'}] ${g.label}: actual=${g.actual} (policy ${g.threshold})`),
	];
	return lines.join('\n');
}
