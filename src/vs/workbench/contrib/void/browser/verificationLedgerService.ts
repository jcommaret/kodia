/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { analyzeProjectHealth, buildArchitectureMap, computeEngineeringQualityScore } from '../common/projectHealth.js';
import {
	createVerificationRecord,
	DEFAULT_QUALITY_GATE_POLICY,
	evaluateQualityGates,
	QualityGateEvaluation,
	QualityGatePolicy,
	VerificationCheckResult,
	VerificationRecord,
} from '../common/verificationLedger.js';
import { collectWorkspaceProjectFiles } from './projectHealthScanner.js';

const RECORDS_STORAGE_KEY = 'kodia.verificationLedger.records.v1';
const POLICY_STORAGE_KEY = 'kodia.verificationLedger.policy.v1';
const MAX_RECORDS = 50;

export interface IVerificationLedgerService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;

	getRecords(): readonly VerificationRecord[];
	getPolicy(): QualityGatePolicy;
	setPolicy(patch: Partial<QualityGatePolicy>): QualityGatePolicy;
	getLastGateEvaluation(): QualityGateEvaluation | null;
	addRecord(input: {
		taskTitle: string;
		summary: string;
		filesChanged?: readonly string[];
		checks: readonly VerificationCheckResult[];
		limitations?: readonly string[];
		qualityScore?: number;
	}): VerificationRecord;
	clearRecords(): void;
	runWorkspaceQualityGates(subPath?: string): Promise<{ evaluation: QualityGateEvaluation; record: VerificationRecord }>;
}

export const IVerificationLedgerService = createDecorator<IVerificationLedgerService>('kodiaVerificationLedgerService');

export class VerificationLedgerService extends Disposable implements IVerificationLedgerService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _records: VerificationRecord[] = [];
	private _policy: QualityGatePolicy = { ...DEFAULT_QUALITY_GATE_POLICY };
	private _lastEvaluation: QualityGateEvaluation | null = null;

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IMarkerService private readonly _markerService: IMarkerService,
	) {
		super();
		this._load();
	}

	private _load(): void {
		try {
			const rawRecs = this._storageService.get(RECORDS_STORAGE_KEY, StorageScope.WORKSPACE);
			if (rawRecs) {
				const parsed = JSON.parse(rawRecs);
				if (Array.isArray(parsed)) {
					this._records = parsed.slice(0, MAX_RECORDS);
				}
			}
		} catch { /* ignore corrupt storage */ }

		try {
			const rawPol = this._storageService.get(POLICY_STORAGE_KEY, StorageScope.WORKSPACE);
			if (rawPol) {
				this._policy = { ...DEFAULT_QUALITY_GATE_POLICY, ...JSON.parse(rawPol) };
			}
		} catch { /* ignore */ }
	}

	private _save(): void {
		try {
			this._storageService.store(RECORDS_STORAGE_KEY, JSON.stringify(this._records), StorageScope.WORKSPACE, StorageTarget.MACHINE);
			this._storageService.store(POLICY_STORAGE_KEY, JSON.stringify(this._policy), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} catch { /* ignore */ }
		this._onDidChange.fire();
	}

	getRecords(): readonly VerificationRecord[] {
		return this._records;
	}

	getPolicy(): QualityGatePolicy {
		return this._policy;
	}

	setPolicy(patch: Partial<QualityGatePolicy>): QualityGatePolicy {
		this._policy = { ...this._policy, ...patch };
		this._save();
		return this._policy;
	}

	getLastGateEvaluation(): QualityGateEvaluation | null {
		return this._lastEvaluation;
	}

	addRecord(input: {
		taskTitle: string;
		summary: string;
		filesChanged?: readonly string[];
		checks: readonly VerificationCheckResult[];
		limitations?: readonly string[];
		qualityScore?: number;
	}): VerificationRecord {
		const record = createVerificationRecord(input);
		this._records = [record, ...this._records].slice(0, MAX_RECORDS);
		this._save();
		return record;
	}

	clearRecords(): void {
		this._records = [];
		this._save();
	}

	async runWorkspaceQualityGates(subPath?: string): Promise<{ evaluation: QualityGateEvaluation; record: VerificationRecord }> {
		const files = await collectWorkspaceProjectFiles(this._fileService, this._workspaceService, { subPath });
		const health = analyzeProjectHealth(files);
		const arch = buildArchitectureMap(files);
		const score = computeEngineeringQualityScore(health, arch);
		const errorMarkers = this._markerService.read({ severities: MarkerSeverity.Error });

		const evaluation = evaluateQualityGates({
			criticalFindings: health.counts.critical,
			highFindings: health.counts.high,
			qualityScore: score.score,
			circularDependencies: arch.cycles.length,
			workspaceErrors: errorMarkers.length,
		}, this._policy);

		this._lastEvaluation = evaluation;

		const now = new Date().toISOString();
		const checks: VerificationCheckResult[] = [
			{
				name: 'Static Security & Secret Scan',
				level: 'security_checked',
				passed: health.counts.critical <= this._policy.maxCriticalFindings && health.counts.high <= this._policy.maxHighFindings,
				detail: `${health.counts.critical} critical, ${health.counts.high} high findings across ${health.scannedFiles} files`,
				timestamp: now,
			},
			{
				name: 'Workspace Compiler Diagnostics',
				level: 'static_checks',
				passed: errorMarkers.length <= this._policy.maxWorkspaceErrors,
				detail: `${errorMarkers.length} active error diagnostic(s) in workspace Problems panel`,
				timestamp: now,
			},
			{
				name: 'Architecture & Quality Score',
				level: 'static_checks',
				passed: score.score >= this._policy.minQualityScore && arch.cycles.length <= this._policy.maxCircularDependencies,
				detail: `Score ${score.score}/100 (Grade ${score.grade}), ${arch.cycles.length} circular dependencies`,
				timestamp: now,
			},
		];

		const record = this.addRecord({
			taskTitle: subPath ? `Quality Gates (${subPath})` : 'Workspace Autonomous Quality Gates',
			summary: evaluation.passed
				? `All ${evaluation.gates.length} quality gates passed (Score ${score.score}/100, Grade ${score.grade}).`
				: `${evaluation.gates.filter(g => !g.passed).length} of ${evaluation.gates.length} quality gates failed.`,
			checks,
			qualityScore: score.score,
			limitations: ['Automated static, security, architecture, and IDE diagnostics check; unit/E2E tests must be recorded separately.'],
		});

		return { evaluation, record };
	}
}

registerSingleton(IVerificationLedgerService, VerificationLedgerService, InstantiationType.Delayed);
