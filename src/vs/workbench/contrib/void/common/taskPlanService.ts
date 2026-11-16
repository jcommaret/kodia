/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { TaskPlan, TaskPlanTask, TaskStatus, newTaskPlan, newTask, addTask, updateTaskStatus, computeOverallStatus, getNextPendingTask, getTaskById, getPlanProgress, formatTaskPlanForLLM, hasCircularDependencies, isValidStateTransition } from './autonomousTask.js';

export const ITaskPlanService = createDecorator<ITaskPlanService>('TaskPlanService');

export interface ITaskPlanService {
	readonly _serviceBrand: undefined;

	getOrCreatePlan(threadId: string): TaskPlan;
	getPlan(threadId: string): TaskPlan | null;
	createPlan(threadId: string, title: string, description: string, tasks: { title: string, description: string, dependencies: string[] }[]): TaskPlan;
	updateTask(threadId: string, taskId: string, status: TaskStatus, result?: string, error?: string): TaskPlan | null;
	addTask(threadId: string, task: { title: string, description: string, dependencies: string[] }): TaskPlan | null;
	getNextPendingTask(threadId: string): TaskPlanTask | null;
	getTaskById(threadId: string, taskId: string): TaskPlanTask | null;
	formatPlanForLLM(threadId: string): string | null;
	getPlanProgress(threadId: string): { completed: number, total: number, percent: number } | null;
	hasCircularDependencies(threadId: string): boolean;
	savePlans(fileService: any): Promise<void>;
	loadPlans(fileService: any, storageUri: string): Promise<void>;
	readonly onDidChangePlan: Event<{ threadId: string, plan: TaskPlan }>;
}

export class TaskPlanService extends Disposable implements ITaskPlanService {
	_serviceBrand: undefined;

	private readonly _onDidChangePlan = new Emitter<{ threadId: string, plan: TaskPlan }>();
	readonly onDidChangePlan: Event<{ threadId: string, plan: TaskPlan }> = this._onDidChangePlan.event;

	private plans: Map<string, TaskPlan> = new Map();

	constructor() {
		super();
	}

	/**
	 * Persist all plans to disk. Used for recovery after application restart.
	 * @param fileService - The file service to use for writing.
	 * @param storageUri - The URI to save plans to (defaults to 'task-plans.json').
	 */
	async savePlans(fileService: any, storageUri: string = 'task-plans.json'): Promise<void> {
		const data = JSON.stringify({ plans: Array.from(this.plans.entries()) });
		const content = Buffer.from(data, 'utf8');
		await fileService.writeFile({ fsPath: storageUri, toString: () => storageUri } as any, content as any);
	}

	/**
	 * Load plans from disk. Used for recovery after application restart.
	 * Plans already in memory are not overwritten by loaded data.
	 * @param fileService - The file service to use for reading.
	 * @param storageUri - The URI to load plans from.
	 */
	async loadPlans(fileService: any, storageUri: string = 'task-plans.json'): Promise<void> {
		try {
			const contents = await fileService.readFile({ fsPath: storageUri, toString: () => storageUri } as any);
			const parsed = JSON.parse(contents.value.toString('utf8'));
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

	createPlan(threadId: string, title: string, description: string, tasks: { title: string, description: string, dependencies: string[] }[]): TaskPlan {
		let plan = newTaskPlan(title, description);
		for (const t of tasks) {
			plan = addTask(plan, newTask(t.title, t.description, t.dependencies));
		}
		plan = { ...plan, overallStatus: computeOverallStatus(plan.tasks), updatedAt: new Date().toISOString() };
		this.plans.set(threadId, plan);
		this._onDidChangePlan.fire({ threadId, plan });
		return plan;
	}

	updateTask(threadId: string, taskId: string, status: TaskStatus, result?: string, error?: string): TaskPlan | null {
		const plan = this.plans.get(threadId);
		if (!plan) return null;

		const task = plan.tasks.find(t => t.id === taskId);
		if (!task) return null;

		if (!isValidStateTransition(task.status, status)) {
			return null;
		}

		let updated = updateTaskStatus(plan, taskId, status, result, error);
		this.plans.set(threadId, updated);
		this._onDidChangePlan.fire({ threadId, plan: updated });
		return updated;
	}

	addTask(threadId: string, task: { title: string, description: string, dependencies: string[] }): TaskPlan | null {
		const plan = this.plans.get(threadId);
		if (!plan) return null;
		let updated = addTask(plan, newTask(task.title, task.description, task.dependencies));
		this.plans.set(threadId, updated);
		this._onDidChangePlan.fire({ threadId, plan: updated });
		return updated;
	}

	getNextPendingTask(threadId: string): TaskPlanTask | null {
		const plan = this.plans.get(threadId);
		if (!plan) return null;
		return getNextPendingTask(plan) ?? null;
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
