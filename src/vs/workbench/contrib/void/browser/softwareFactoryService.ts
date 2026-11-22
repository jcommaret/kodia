/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import {
	ArchitectureDecisionRecord,
	AutopilotObjective,
	buildModelCouncilPrompt,
	buildSoftwareFactoryPrompt,
	FactoryProjectProfileId,
	ISoftwareFactoryService,
	ProjectRequirement,
	RequirementStatus,
} from '../common/softwareFactory.js';
import { IChatThreadService } from './chatThreadService.js';

export { ISoftwareFactoryService };

const REQUIREMENTS_KEY = 'kodia.softwareFactory.requirements.v1';
const AUTOPILOT_KEY = 'kodia.softwareFactory.autopilot.v1';
const ADRS_KEY = 'kodia.softwareFactory.adrs.v1';

export class SoftwareFactoryService extends Disposable implements ISoftwareFactoryService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _requirements: ProjectRequirement[] = [];
	private _objectives: AutopilotObjective[] = [];
	private _decisions: ArchitectureDecisionRecord[] = [];

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IChatThreadService private readonly _chatThreadService: IChatThreadService,
	) {
		super();
		this._load();
	}

	private _load(): void {
		const readArr = <T,>(key: string): T[] => {
			try {
				const raw = this._storageService.get(key, StorageScope.WORKSPACE);
				if (!raw) { return []; }
				const parsed = JSON.parse(raw);
				return Array.isArray(parsed) ? parsed : [];
			} catch {
				return [];
			}
		};
		this._requirements = readArr<ProjectRequirement>(REQUIREMENTS_KEY);
		this._objectives = readArr<AutopilotObjective>(AUTOPILOT_KEY);
		this._decisions = readArr<ArchitectureDecisionRecord>(ADRS_KEY);
	}

	private _save(): void {
		try {
			this._storageService.store(REQUIREMENTS_KEY, JSON.stringify(this._requirements), StorageScope.WORKSPACE, StorageTarget.MACHINE);
			this._storageService.store(AUTOPILOT_KEY, JSON.stringify(this._objectives), StorageScope.WORKSPACE, StorageTarget.MACHINE);
			this._storageService.store(ADRS_KEY, JSON.stringify(this._decisions), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} catch { /* ignore */ }
		this._onDidChange.fire();
	}

	getRequirements(): readonly ProjectRequirement[] {
		return this._requirements;
	}

	addRequirement(input: { title: string; description: string; priority?: 'high' | 'medium' | 'low'; acceptanceCriteria?: readonly string[] }): ProjectRequirement {
		const now = new Date().toISOString();
		const nextNum = this._requirements.length + 1;
		const req: ProjectRequirement = {
			id: `REQ-${String(nextNum).padStart(3, '0')}`,
			title: input.title.trim(),
			description: input.description.trim(),
			priority: input.priority ?? 'medium',
			status: 'unstarted',
			acceptanceCriteria: [...(input.acceptanceCriteria ?? [])],
			linkedFiles: [],
			linkedTests: [],
			createdAt: now,
			updatedAt: now,
		};
		this._requirements = [...this._requirements, req];
		this._save();
		return req;
	}

	updateRequirement(
		id: string,
		patch: Partial<Pick<ProjectRequirement, 'title' | 'description' | 'priority' | 'status' | 'linkedFiles' | 'linkedTests'>>,
	): ProjectRequirement | null {
		let updated: ProjectRequirement | null = null;
		this._requirements = this._requirements.map(r => {
			if (r.id !== id) { return r; }
			updated = { ...r, ...patch, updatedAt: new Date().toISOString() };
			return updated;
		});
		if (updated) { this._save(); }
		return updated;
	}

	removeRequirement(id: string): void {
		this._requirements = this._requirements.filter(r => r.id !== id);
		this._save();
	}

	getAutopilotObjectives(): readonly AutopilotObjective[] {
		return this._objectives;
	}

	addAutopilotObjective(input: { title: string; instruction: string }): AutopilotObjective {
		const obj: AutopilotObjective = {
			id: `auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
			title: input.title.trim(),
			instruction: input.instruction.trim(),
			enabled: true,
			runCount: 0,
			createdAt: new Date().toISOString(),
		};
		this._objectives = [obj, ...this._objectives];
		this._save();
		return obj;
	}

	toggleAutopilotObjective(id: string, enabled: boolean): void {
		this._objectives = this._objectives.map(o => o.id === id ? { ...o, enabled } : o);
		this._save();
	}

	removeAutopilotObjective(id: string): void {
		this._objectives = this._objectives.filter(o => o.id !== id);
		this._save();
	}

	async runAutopilotObjectiveNow(id: string): Promise<string | null> {
		const obj = this._objectives.find(o => o.id === id);
		if (!obj) { return null; }

		const threadId = this._chatThreadService.state.currentThreadId;
		const prompt = [
			`[Kodia Project Autopilot — ${obj.title}]`,
			obj.instruction,
			``,
			`Inspect the current workspace, identify the single highest-impact safe improvement toward this objective, implement it cleanly, verify with tests/diagnostics, and record verification evidence.`,
		].join('\n');

		this._objectives = this._objectives.map(o => o.id === id ? {
			...o,
			runCount: o.runCount + 1,
			lastRunAt: new Date().toISOString(),
			lastThreadId: threadId,
		} : o);
		this._save();

		if (this._chatThreadService.streamState[threadId]?.isRunning) {
			this._chatThreadService.enqueueUserMessage(threadId, prompt);
		} else {
			void this._chatThreadService.addUserMessageAndStreamResponse({ userMessage: prompt, threadId });
		}
		return threadId;
	}

	getDecisions(): readonly ArchitectureDecisionRecord[] {
		return this._decisions;
	}

	addDecision(input: {
		title: string;
		context: string;
		decision: string;
		consequences?: string;
		status?: 'proposed' | 'accepted' | 'superseded';
		relatedFiles?: readonly string[];
	}): ArchitectureDecisionRecord {
		const nextNum = this._decisions.length + 1;
		const adr: ArchitectureDecisionRecord = {
			id: `ADR-${String(nextNum).padStart(3, '0')}`,
			title: input.title.trim(),
			status: input.status ?? 'accepted',
			context: input.context.trim(),
			decision: input.decision.trim(),
			consequences: (input.consequences ?? '').trim(),
			relatedFiles: [...(input.relatedFiles ?? [])],
			createdAt: new Date().toISOString(),
		};
		this._decisions = [adr, ...this._decisions];
		this._save();
		return adr;
	}

	removeDecision(id: string): void {
		this._decisions = this._decisions.filter(d => d.id !== id);
		this._save();
	}

	async launchFactoryBuild(idea: string, profileId: FactoryProjectProfileId): Promise<string> {
		const trimmed = idea.trim();
		const req = this.addRequirement({
			title: trimmed.slice(0, 72),
			description: trimmed,
			priority: 'high',
		});
		const prompt = buildSoftwareFactoryPrompt(trimmed, profileId, [req, ...this._requirements.filter(r => r.id !== req.id && r.status !== 'verified')]);
		const threadId = this._chatThreadService.state.currentThreadId;
		this.updateRequirement(req.id, { status: 'in_progress' as RequirementStatus });
		if (this._chatThreadService.streamState[threadId]?.isRunning) {
			this._chatThreadService.enqueueUserMessage(threadId, prompt);
		} else {
			void this._chatThreadService.addUserMessageAndStreamResponse({ userMessage: prompt, threadId });
		}
		return threadId;
	}

	async launchModelCouncil(question: string): Promise<string> {
		const prompt = buildModelCouncilPrompt(question);
		const threadId = this._chatThreadService.state.currentThreadId;
		if (this._chatThreadService.streamState[threadId]?.isRunning) {
			this._chatThreadService.enqueueUserMessage(threadId, prompt);
		} else {
			void this._chatThreadService.addUserMessageAndStreamResponse({ userMessage: prompt, threadId });
		}
		return threadId;
	}
}

registerSingleton(ISoftwareFactoryService, SoftwareFactoryService, InstantiationType.Delayed);
