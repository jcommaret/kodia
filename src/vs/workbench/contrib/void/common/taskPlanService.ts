/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { TaskPlan, TaskPlanTask, TaskPriority, TaskEditPatch, TaskStatus, newTaskPlan, newTask, addTask, updateTaskStatus, retryTask, editTask, removeTask, computeOverallStatus, getNextPendingTask, getParallelReadyTasks, getTaskById, getPlanProgress, formatTaskPlanForLLM, hasCircularDependencies, isValidStateTransition } from './autonomousTask.js';

export const ITaskPlanService = createDecorator<ITaskPlanService>('TaskPlanService');

export type NewTaskInput = {
	title: string;
	description: string;
	dependencies: string[];
	priority?: TaskPriority;
	assignedAgent?: string;
	acceptanceCriteria?: string[];
};

export interface ITaskPlanService {
	readonly _serviceBrand: undefined;

	getOrCreatePlan(threadId: string): TaskPlan;
	getPlan(threadId: string): TaskPlan | null;
	/** Hydrate a persisted plan (e.g. restored from thread storage after restart) without overwriting an active in-memory plan. */
	hydratePlan(threadId: string, plan: TaskPlan): void;
	setPlan(threadId: string, plan: TaskPlan): void;
	deletePlan(threadId: string): void;
	createPlan(threadId: string, title: string, description: string, tasks: NewTaskInput[]): TaskPlan;
	updateTask(threadId: string, taskId: string, status: TaskStatus, result?: string, error?: string, evidence?: string): TaskPlan | null;
	retryTask(threadId: string, taskId: string): TaskPlan | null;
	editTask(threadId: string, taskId: string, patch: TaskEditPatch): TaskPlan | null;
	removeTask(threadId: string, taskId: string): TaskPlan | null;
	addTask(threadId: string, task: NewTaskInput): TaskPlan | null;
	getNextPendingTask(threadId: string): TaskPlanTask | null;
	getParallelReadyTasks(threadId: string): TaskPlanTask[];
	getTaskById(threadId: string, taskId: string): TaskPlanTask | null;
	formatPlanForLLM(threadId: string): string | null;
	getPlanProgress(threadId: string): { completed: number, total: number, percent: number } | null;
	hasCircularDependencies(threadId: string): boolean;
	savePlans(fileService: any, storageUri?: string): Promise<void>;
	loadPlans(fileService: any, storageUri?: string): Promise<void>;
	readonly onDidChangePlan: Event<{ threadId: string, plan: TaskPlan }>;
}

export class TaskPlanService extends Disposable implements ITaskPlanService {
	_serviceBrand: undefined;

	private readonly _onDidChangePlan = this._register(new Emitter<{ threadId: string, plan: TaskPlan }>());
	readonly onDidChangePlan: Event<{ threadId: string, plan: TaskPlan }> = this._onDidChangePlan.event;

	private plans: Map<string, TaskPlan> = new Map();

	constructor() {
		super();
	}

	/**
	 * Persist all plans to disk. Used for recovery after application restart.
	 * Uses VSBuffer + URI (browser-safe, never Node Buffer).
	 */
	async savePlans(fileService: any, storageUri: string = 'task-plans.json'): Promise<void> {
		const data = JSON.stringify({ plans: Array.from(this.plans.entries()) });
		const content = VSBuffer.fromString(data);
		const uri = URI.file(storageUri);
		await fileService.writeFile(uri, content);
	}

	/**
	 * Load plans from disk. Used for recovery after application restart.
	 * Plans already in memory are not overwritten by loaded data.
	 */
	async loadPlans(fileService: any, storageUri: string = 'task-plans.json'): Promise<void> {
		try {
			const uri = URI.file(storageUri);
			const contents = await fileService.readFile(uri);
			const text = typeof contents.value?.toString === 'function' ? contents.value.toString() : String(contents.value ?? '');
			const parsed = JSON.parse(text);
			if (parsed.plans && Array.isArray(parsed.plans)) {
				for (const [threadId, plan] of parsed.plans) {
					if (!this.plans.has(threadId)) {
						this.plans.set(threadId, plan as TaskPlan);
					}
				}
			}
		} catch {
			// No saved plans yet — start fresh
		}
	}

	hydratePlan(threadId: string, plan: TaskPlan): void {
		if (!this.plans.has(threadId) && plan) {
			this.plans.set(threadId, plan);
		}
	}

	setPlan(threadId: string, plan: TaskPlan): void {
		this.plans.set(threadId, plan);
		this._onDidChangePlan.fire({ threadId, plan });
	}

	deletePlan(threadId: string): void {
		this.plans.delete(threadId);
	}

	getOrCreatePlan(threadId: string): TaskPlan {
		let plan = this.plans.get(threadId);
		if (!plan) {
			plan = newTaskPlan('Development Task', 'Autonomous development task plan');
			this.plans.set(threadId, plan);
		}
		return plan;
	}

	getPlan(threadId: string): TaskPlan | null {
		return this.plans.get(threadId) ?? null;
	}

	createPlan(threadId: string, title: string, description: string, tasks: NewTaskInput[]): TaskPlan {
		let plan = newTaskPlan(title, description);
		for (const t of tasks) {
			plan = addTask(plan, newTask(t.title, t.description, t.dependencies, {
				priority: t.priority,
				assignedAgent: t.assignedAgent,
				acceptanceCriteria: t.acceptanceCriteria,
			}));
		}
		plan = { ...plan, overallStatus: computeOverallStatus(plan.tasks), updatedAt: new Date().toISOString() };
		this.plans.set(threadId, plan);
		this._onDidChangePlan.fire({ threadId, plan });
		return plan;
	}

	updateTask(threadId: string, taskId: string, status: TaskStatus, result?: string, error?: string, evidence?: string): TaskPlan | null {
		const plan = this.plans.get(threadId);
		if (!plan) return null;

		const task = plan.tasks.find(t => t.id === taskId);
		if (!task) return null;

		if (!isValidStateTransition(task.status, status)) {
			return null;
		}

		const updated = updateTaskStatus(plan, taskId, status, result, error, evidence);
		this.plans.set(threadId, updated);
		this._onDidChangePlan.fire({ threadId, plan: updated });
		return updated;
	}

	retryTask(threadId: string, taskId: string): TaskPlan | null {
		const plan = this.plans.get(threadId);
		if (!plan) return null;
		const task = plan.tasks.find(t => t.id === taskId);
		if (!task || (task.status !== 'failed' && task.status !== 'blocked')) return null;

		const updated = retryTask(plan, taskId);
		this.plans.set(threadId, updated);
		this._onDidChangePlan.fire({ threadId, plan: updated });
		return updated;
	}

	editTask(threadId: string, taskId: string, patch: TaskEditPatch): TaskPlan | null {
		const plan = this.plans.get(threadId);
		if (!plan || !plan.tasks.some(t => t.id === taskId)) return null;

		const updated = editTask(plan, taskId, patch);
		this.plans.set(threadId, updated);
		this._onDidChangePlan.fire({ threadId, plan: updated });
		return updated;
	}

	removeTask(threadId: string, taskId: string): TaskPlan | null {
		const plan = this.plans.get(threadId);
		if (!plan || !plan.tasks.some(t => t.id === taskId)) return null;

		const updated = removeTask(plan, taskId);
		this.plans.set(threadId, updated);
		this._onDidChangePlan.fire({ threadId, plan: updated });
		return updated;
	}

	addTask(threadId: string, task: NewTaskInput): TaskPlan | null {
		const plan = this.plans.get(threadId);
		if (!plan) return null;
		const updated = addTask(plan, newTask(task.title, task.description, task.dependencies, {
			priority: task.priority,
			assignedAgent: task.assignedAgent,
			acceptanceCriteria: task.acceptanceCriteria,
		}));
		this.plans.set(threadId, updated);
		this._onDidChangePlan.fire({ threadId, plan: updated });
		return updated;
	}

	getNextPendingTask(threadId: string): TaskPlanTask | null {
		const plan = this.plans.get(threadId);
		if (!plan) return null;
		return getNextPendingTask(plan) ?? null;
	}

	getParallelReadyTasks(threadId: string): TaskPlanTask[] {
		const plan = this.plans.get(threadId);
		if (!plan) return [];
		return getParallelReadyTasks(plan);
	}

	getTaskById(threadId: string, taskId: string): TaskPlanTask | null {
		const plan = this.plans.get(threadId);
		if (!plan) return null;
		return getTaskById(plan, taskId) ?? null;
	}

	formatPlanForLLM(threadId: string): string | null {
		const plan = this.plans.get(threadId);
		if (!plan) return null;
		return formatTaskPlanForLLM(plan);
	}

	getPlanProgress(threadId: string): { completed: number, total: number, percent: number } | null {
		const plan = this.plans.get(threadId);
		if (!plan) return null;
		return getPlanProgress(plan);
	}

	hasCircularDependencies(threadId: string): boolean {
		const plan = this.plans.get(threadId);
		if (!plan) return false;
		return hasCircularDependencies(plan);
	}
}

registerSingleton(ITaskPlanService, TaskPlanService, InstantiationType.Eager);
