/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import {
	AIArchitectureReport,
	AIEvaluationReport,
	AIExperimentRecord,
	AISecurityAuditReport,
	AIWorkflowDefinition,
	AIWorkflowRunResult,
	ComputeHardwareProfile,
	DatasetProfileReport,
	EngineRoutingDecision,
	ModelRegistryEntry,
	OneCommandFactoryBlueprint,
	RagEvaluationReport,
	RagIndexSummary,
} from '../common/aiEngineeringTypes.js';
import { formatFactoryBlueprintForLLM, generateOneCommandFactoryBlueprint } from '../common/aiEngineeringKnowledge.js';

const AI_ENGINE_STORAGE_KEY = 'kodia.aiEngineeringEngine.state.v1';

export interface ProjectAIEngineState {
	readonly latestRouting: EngineRoutingDecision | null;
	readonly latestArchitecture: AIArchitectureReport | null;
	readonly latestFactoryBlueprint: OneCommandFactoryBlueprint | null;
	readonly latestHardware: ComputeHardwareProfile | null;
	readonly latestDatasetProfile: DatasetProfileReport | null;
	readonly latestSecurityAudit: AISecurityAuditReport | null;
	readonly latestRagEval: RagEvaluationReport | null;
	readonly ragIndexes: readonly RagIndexSummary[];
	readonly experiments: readonly AIExperimentRecord[];
	readonly models: readonly ModelRegistryEntry[];
	readonly evaluations: readonly AIEvaluationReport[];
	readonly workflows: readonly AIWorkflowDefinition[];
	readonly workflowRuns: readonly AIWorkflowRunResult[];
}

export interface IAIEngineeringService {
	readonly _serviceBrand: undefined;
	readonly state: ProjectAIEngineState;
	readonly onDidChange: Event<void>;

	recordRouting(routing: EngineRoutingDecision): void;
	recordArchitecture(arch: AIArchitectureReport): void;
	recordFactoryBlueprint(bp: OneCommandFactoryBlueprint): void;
	recordHardware(hw: ComputeHardwareProfile): void;
	recordDatasetProfile(profile: DatasetProfileReport): void;
	recordSecurityAudit(audit: AISecurityAuditReport): void;
	recordRagIndexes(indexes: readonly RagIndexSummary[]): void;
	recordRagEval(report: RagEvaluationReport): void;
	recordExperiments(experiments: readonly AIExperimentRecord[]): void;
	recordModels(models: readonly ModelRegistryEntry[]): void;
	recordEvaluations(evals: readonly AIEvaluationReport[]): void;
	recordWorkflows(workflows: readonly AIWorkflowDefinition[]): void;
	recordWorkflowRun(run: AIWorkflowRunResult): void;

	launchOneCommandFactory(
		objective: string,
		dispatchPrompt?: (prompt: string) => void | Promise<void>,
	): Promise<{ blueprint: OneCommandFactoryBlueprint; prompt: string }>;
}

export const IAIEngineeringService = createDecorator<IAIEngineeringService>('kodiaAIEngineeringService');

const EMPTY_AI_STATE: ProjectAIEngineState = {
	latestRouting: null,
	latestArchitecture: null,
	latestFactoryBlueprint: null,
	latestHardware: null,
	latestDatasetProfile: null,
	latestSecurityAudit: null,
	latestRagEval: null,
	ragIndexes: [],
	experiments: [],
	models: [],
	evaluations: [],
	workflows: [],
	workflowRuns: [],
};

export class AIEngineeringService extends Disposable implements IAIEngineeringService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _state: ProjectAIEngineState = { ...EMPTY_AI_STATE };

	get state(): ProjectAIEngineState {
		return this._state;
	}

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		this._load();
	}

	private _load(): void {
		try {
			const raw = this._storageService.get(AI_ENGINE_STORAGE_KEY, StorageScope.WORKSPACE);
			if (!raw) { return; }
			const parsed = JSON.parse(raw) as Partial<ProjectAIEngineState>;
			if (parsed && typeof parsed === 'object') {
				this._state = {
					...EMPTY_AI_STATE,
					...parsed,
					ragIndexes: Array.isArray(parsed.ragIndexes) ? parsed.ragIndexes : [],
					experiments: Array.isArray(parsed.experiments) ? parsed.experiments : [],
					models: Array.isArray(parsed.models) ? parsed.models : [],
					evaluations: Array.isArray(parsed.evaluations) ? parsed.evaluations : [],
					workflows: Array.isArray(parsed.workflows) ? parsed.workflows : [],
					workflowRuns: Array.isArray(parsed.workflowRuns) ? parsed.workflowRuns : [],
				};
			}
		} catch { /* ignore */ }
	}

	private _update(patch: Partial<ProjectAIEngineState>): void {
		this._state = { ...this._state, ...patch };
		try {
			this._storageService.store(AI_ENGINE_STORAGE_KEY, JSON.stringify(this._state), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} catch { /* ignore */ }
		this._onDidChange.fire();
	}

	recordRouting(latestRouting: EngineRoutingDecision): void { this._update({ latestRouting }); }
	recordArchitecture(latestArchitecture: AIArchitectureReport): void { this._update({ latestArchitecture }); }
	recordFactoryBlueprint(bp: OneCommandFactoryBlueprint): void {
		this._update({
			latestFactoryBlueprint: bp,
			latestRouting: bp.routing,
			latestArchitecture: bp.architecture,
		});
	}
	recordHardware(latestHardware: ComputeHardwareProfile): void { this._update({ latestHardware }); }
	recordDatasetProfile(latestDatasetProfile: DatasetProfileReport): void { this._update({ latestDatasetProfile }); }
	recordSecurityAudit(latestSecurityAudit: AISecurityAuditReport): void { this._update({ latestSecurityAudit }); }
	recordRagIndexes(ragIndexes: readonly RagIndexSummary[]): void { this._update({ ragIndexes: [...ragIndexes] }); }
	recordRagEval(latestRagEval: RagEvaluationReport): void { this._update({ latestRagEval }); }
	recordExperiments(experiments: readonly AIExperimentRecord[]): void { this._update({ experiments: [...experiments].slice(0, 40) }); }
	recordModels(models: readonly ModelRegistryEntry[]): void { this._update({ models: [...models].slice(0, 40) }); }
	recordEvaluations(evaluations: readonly AIEvaluationReport[]): void { this._update({ evaluations: [...evaluations].slice(0, 40) }); }
	recordWorkflows(workflows: readonly AIWorkflowDefinition[]): void { this._update({ workflows: [...workflows].slice(0, 40) }); }
	recordWorkflowRun(run: AIWorkflowRunResult): void {
		this._update({ workflowRuns: [run, ...this._state.workflowRuns].slice(0, 20) });
	}

	async launchOneCommandFactory(
		objective: string,
		dispatchPrompt?: (prompt: string) => void | Promise<void>,
	): Promise<{ blueprint: OneCommandFactoryBlueprint; prompt: string }> {
		const bp = generateOneCommandFactoryBlueprint({
			objective,
			hardware: this._state.latestHardware,
		});
		this.recordFactoryBlueprint(bp);

		const prompt = [
			`[Kodia One-Command Unified Engineering Factory — ${bp.routing.engineMode}]`,
			formatFactoryBlueprintForLLM(bp),
			``,
			`Execute this plan autonomously in dependency order:`,
			`1. Inspect the workspace and probe compute hardware (ai_probe_compute_hardware / env_inspect).`,
			`2. Create a structured task plan (create_task_plan) and register key requirements (factory_manage_requirements).`,
			`3. Implement the real software & AI modules directly on disk — use parallel specialist subagents where independent.`,
			`4. Run real tests, AI/RAG evaluations (ai_evaluate_system / ai_rag_evaluate), AI security audit (ai_audit_security), and record verification proof before delivering the final report.`,
		].join('\n');

		if (dispatchPrompt) {
			await dispatchPrompt(prompt);
		}
		return { blueprint: bp, prompt };
	}
}

registerSingleton(IAIEngineeringService, AIEngineeringService, InstantiationType.Eager);
