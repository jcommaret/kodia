/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ChatMode } from '../common/voidSettingsTypes.js';
import {
	computeNextRunAt,
	isScheduledJobDue,
	KodiaScheduledJob,
	KodiaWorkflowDefinition,
	parseWorkflowMarkdown,
} from '../common/kodiaWorkflows.js';
import { IChatThreadService } from './chatThreadService.js';

const SCHEDULED_JOBS_STORAGE_KEY = 'kodia.scheduledJobs.v1';
const SCHEDULER_TICK_MS = 30_000;

export const IKodiaWorkflowsService = createDecorator<IKodiaWorkflowsService>('kodiaWorkflowsService');

export interface IKodiaWorkflowsService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeJobs: Event<readonly KodiaScheduledJob[]>;

	listWorkflows(): Promise<KodiaWorkflowDefinition[]>;
	getScheduledJobs(): readonly KodiaScheduledJob[];
	addScheduledJob(input: { name: string; prompt: string; workflowName?: string; chatMode?: ChatMode; intervalMinutes: number; enabled?: boolean }): KodiaScheduledJob;
	toggleScheduledJob(jobId: string, enabled: boolean): void;
	deleteScheduledJob(jobId: string): void;
	runWorkflowNow(workflow: KodiaWorkflowDefinition): Promise<string>;
	runJobNow(jobId: string): Promise<string | undefined>;
	tickDueJobs(nowMs?: number): Promise<string[]>;
}

export class KodiaWorkflowsService extends Disposable implements IKodiaWorkflowsService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeJobs = this._register(new Emitter<readonly KodiaScheduledJob[]>());
	readonly onDidChangeJobs = this._onDidChangeJobs.event;

	private _jobs: KodiaScheduledJob[] = [];
	private _tickHandle: number | undefined;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IStorageService private readonly _storageService: IStorageService,
		@IChatThreadService private readonly _chatThreadService: IChatThreadService,
	) {
		super();
		this._jobs = this._loadJobs();
		this._tickHandle = mainWindow.setInterval(() => {
			void this.tickDueJobs();
		}, SCHEDULER_TICK_MS);
	}

	override dispose(): void {
		if (this._tickHandle !== undefined) {
			mainWindow.clearInterval(this._tickHandle);
			this._tickHandle = undefined;
		}
		super.dispose();
	}

	private _loadJobs(): KodiaScheduledJob[] {
		try {
			const raw = this._storageService.get(SCHEDULED_JOBS_STORAGE_KEY, StorageScope.WORKSPACE);
			if (!raw) { return []; }
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) { return []; }
			return parsed.filter((j): j is KodiaScheduledJob =>
				!!j && typeof j.id === 'string' && typeof j.name === 'string' && typeof j.prompt === 'string'
			).map(j => (j.lastStatus === 'running' ? { ...j, lastStatus: 'idle' as const } : j));
		} catch {
			return [];
		}
	}

	private _saveJobs(): void {
		try {
			this._storageService.store(
				SCHEDULED_JOBS_STORAGE_KEY,
				JSON.stringify(this._jobs),
				StorageScope.WORKSPACE,
				StorageTarget.USER,
			);
		} catch { /* ignore storage errors */ }
		this._onDidChangeJobs.fire(this._jobs);
	}

	async listWorkflows(): Promise<KodiaWorkflowDefinition[]> {
		const results: KodiaWorkflowDefinition[] = [];
		const seen = new Set<string>();
		const folders = this._workspaceContextService.getWorkspace().folders;

		for (const folder of folders) {
			for (const relDir of ['.kodia/workflows', '.windsurf/workflows', '.agents/workflows']) {
				const dirUri = URI.joinPath(folder.uri, relDir);
				let resolved;
				try {
					resolved = await this._fileService.resolve(dirUri);
				} catch {
					continue;
				}
				for (const child of resolved.children ?? []) {
					if (child.isDirectory || !child.name.toLowerCase().endsWith('.md')) { continue; }
					try {
						const content = (await this._fileService.readFile(child.resource)).value.toString();
						const wf = parseWorkflowMarkdown(child.name, child.resource.fsPath, content);
						if (wf && !seen.has(wf.name.toLowerCase())) {
							seen.add(wf.name.toLowerCase());
							results.push(wf);
						}
					} catch { /* skip unreadable file */ }
				}
			}
		}

		return results.sort((a, b) => a.name.localeCompare(b.name));
	}

	getScheduledJobs(): readonly KodiaScheduledJob[] {
		return this._jobs;
	}

	addScheduledJob(input: { name: string; prompt: string; workflowName?: string; chatMode?: ChatMode; intervalMinutes: number; enabled?: boolean }): KodiaScheduledJob {
		const now = Date.now();
		const interval = Math.max(1, Math.min(Math.round(input.intervalMinutes || 60), 43_200));
		const job: KodiaScheduledJob = {
			id: generateUuid(),
			name: input.name.trim() || 'Scheduled Kodia Task',
			prompt: input.prompt.trim(),
			workflowName: input.workflowName,
			chatMode: input.chatMode ?? 'agent',
			intervalMinutes: interval,
			enabled: input.enabled ?? true,
			createdAt: new Date(now).toISOString(),
			nextRunAt: computeNextRunAt(now, interval),
			lastStatus: 'idle',
			runCount: 0,
		};
		this._jobs = [job, ...this._jobs];
		this._saveJobs();
		return job;
	}

	toggleScheduledJob(jobId: string, enabled: boolean): void {
		const now = Date.now();
		this._jobs = this._jobs.map(j => {
			if (j.id !== jobId) { return j; }
			return {
				...j,
				enabled,
				nextRunAt: enabled ? computeNextRunAt(now, j.intervalMinutes) : j.nextRunAt,
			};
		});
		this._saveJobs();
	}

	deleteScheduledJob(jobId: string): void {
		this._jobs = this._jobs.filter(j => j.id !== jobId);
		this._saveJobs();
	}

	async runWorkflowNow(workflow: KodiaWorkflowDefinition): Promise<string> {
		this._chatThreadService.openNewThread();
		const threadId = this._chatThreadService.state.currentThreadId;
		const prompt = `Execute workflow "${workflow.name}" (${workflow.sourcePath}):\n\n${workflow.body}`;
		await this._chatThreadService.addUserMessageAndStreamResponse({
			userMessage: prompt,
			threadId,
		});
		return threadId;
	}

	async runJobNow(jobId: string): Promise<string | undefined> {
		const job = this._jobs.find(j => j.id === jobId);
		if (!job || job.lastStatus === 'running') {
			return undefined;
		}
		const startedAt = Date.now();
		this._jobs = this._jobs.map(j => j.id === jobId ? { ...j, lastStatus: 'running', lastError: undefined } : j);
		this._saveJobs();

		const previousThreadId = this._chatThreadService.state.currentThreadId;
		let runThreadId: string | undefined;
		try {
			this._chatThreadService.openNewThread();
			runThreadId = this._chatThreadService.state.currentThreadId;
			// Keep user focused on their current thread when a scheduled job runs in the background
			if (previousThreadId && previousThreadId !== runThreadId) {
				this._chatThreadService.switchToThread(previousThreadId);
			}
			await this._chatThreadService.addUserMessageAndStreamResponse({
				userMessage: job.prompt,
				threadId: runThreadId,
			});
			const finishedAt = Date.now();
			this._jobs = this._jobs.map(j => j.id === jobId ? {
				...j,
				lastStatus: 'completed',
				lastRunAt: new Date(startedAt).toISOString(),
				nextRunAt: computeNextRunAt(finishedAt, j.intervalMinutes),
				lastThreadId: runThreadId,
				runCount: j.runCount + 1,
			} : j);
			this._saveJobs();
			return runThreadId;
		} catch (err) {
			const finishedAt = Date.now();
			this._jobs = this._jobs.map(j => j.id === jobId ? {
				...j,
				lastStatus: 'failed',
				lastRunAt: new Date(startedAt).toISOString(),
				nextRunAt: computeNextRunAt(finishedAt, j.intervalMinutes),
				lastThreadId: runThreadId,
				lastError: err instanceof Error ? err.message : String(err),
				runCount: j.runCount + 1,
			} : j);
			this._saveJobs();
			return runThreadId;
		}
	}

	async tickDueJobs(nowMs = Date.now()): Promise<string[]> {
		const triggered: string[] = [];
		const due = this._jobs.filter(j => isScheduledJobDue(j, nowMs));
		for (const job of due) {
			const tid = await this.runJobNow(job.id);
			if (tid) { triggered.push(tid); }
		}
		return triggered;
	}
}

registerSingleton(IKodiaWorkflowsService, KodiaWorkflowsService, InstantiationType.Delayed);
