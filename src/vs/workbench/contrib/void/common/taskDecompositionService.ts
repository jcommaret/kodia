/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Task Decomposition Service
// Breaks large "build an app" requests into ordered sub-tasks with dependencies.
// This is the core of "one-command orchestration" — the LLM analyzes a request
// and produces a concrete, executable task plan.

import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { newTaskPlan, newTask, addTask, TaskPlan, TaskPlanTask, TaskStatus } from './autonomousTask.js';

export interface ITaskDecompositionService {
	readonly _serviceBrand: undefined;

	/**
	 * Break a large request into an ordered task plan with dependencies.
	 * The LLM is responsible for filling in the actual tasks — this service
	 * provides the framework and validation.
	 */
	decomposeRequest(request: string, projectType?: string): TaskPlan;

	/**
	 * Validate that a task plan has valid dependencies (no circular refs).
	 */
	validatePlan(plan: TaskPlan): { valid: boolean; errors: string[] };

	/**
	 * Get tasks ready to execute (all dependencies completed).
	 */
	getReadyTasks(plan: TaskPlan): TaskPlanTask[];

	/**
	 * Mark a task as completed with its result.
	 */
	markTaskCompleted(plan: TaskPlan, taskId: string, result: string): TaskPlan;

	/**
	 * Mark a task as failed with an error message.
	 */
	markTaskFailed(plan: TaskPlan, taskId: string, error: string): TaskPlan;

	/**
	 * Format the plan for the LLM (with progress info).
	 */
	formatPlanForLLM(plan: TaskPlan): string;

	/**
	 * Check if the plan is fully completed.
	 */
	isPlanComplete(plan: TaskPlan): boolean;
}

export const ITaskDecompositionService = createDecorator<ITaskDecompositionService>('taskDecompositionService');

export class TaskDecompositionService extends Disposable implements ITaskDecompositionService {
	_serviceBrand: undefined;

	constructor() {
		super();
	}

	decomposeRequest(request: string, projectType?: string): TaskPlan {
		let plan = newTaskPlan(
			projectType || 'Application',
			request
		);

		// Parse the request to identify project type and suggest initial tasks
		const lowerRequest = request.toLowerCase();

		// Detect project type from keywords
		const detectedType = this.detectProjectType(lowerRequest);
		if (projectType === undefined) {
			plan = { ...plan, title: detectedType.charAt(0).toUpperCase() + detectedType.slice(1) };
		}

		// Add standard task categories based on project type
		const suggestedTasks = this.suggestTasks(lowerRequest, detectedType);

		for (const task of suggestedTasks) {
			plan = addTask(plan, task);
		}

		return plan;
	}

	validatePlan(plan: TaskPlan): { valid: boolean; errors: string[] } {
		const errors: string[] = [];

		// Check for circular dependencies
		const taskIds = new Set(plan.tasks.map(t => t.id));
		for (const task of plan.tasks) {
			for (const depId of task.dependencies) {
				if (!taskIds.has(depId)) {
					errors.push(`Task "${task.id}" depends on unknown task "${depId}"`);
				}
			}
		}

		// Simple cycle detection
		const visited = new Set<string>();
		const recStack = new Set<string>();
		const taskMap = new Map(plan.tasks.map(t => [t.id, t]));

		const hasCycle = (id: string): boolean => {
			if (recStack.has(id)) return true;
			if (visited.has(id)) return false;
			visited.add(id);
			recStack.add(id);
			const task = taskMap.get(id);
			if (task) {
				for (const depId of task.dependencies) {
					if (hasCycle(depId)) return true;
				}
			}
			recStack.delete(id);
			return false;
		};

		for (const task of plan.tasks) {
			if (hasCycle(task.id)) {
				errors.push(`Circular dependency detected involving task "${task.id}"`);
			}
		}

		return { valid: errors.length === 0, errors };
	}

	getReadyTasks(plan: TaskPlan): TaskPlanTask[] {
		const completedIds = new Set(plan.tasks.filter(t => t.status === 'completed').map(t => t.id));
		const ready: TaskPlanTask[] = [];

		for (const task of plan.tasks) {
			if (task.status !== 'pending') continue;
			const depsSatisfied = task.dependencies.every(depId => completedIds.has(depId));
			if (depsSatisfied) ready.push(task);
		}

		return ready;
	}

	markTaskCompleted(plan: TaskPlan, taskId: string, result: string): TaskPlan {
		return {
			...plan,
			tasks: plan.tasks.map(t =>
				t.id === taskId
					? { ...t, status: 'completed' as TaskStatus, result }
					: t
			),
			updatedAt: new Date().toISOString(),
		};
	}

	markTaskFailed(plan: TaskPlan, taskId: string, error: string): TaskPlan {
		return {
			...plan,
			tasks: plan.tasks.map(t =>
				t.id === taskId
					? { ...t, status: 'failed' as TaskStatus, error }
					: t
			),
			updatedAt: new Date().toISOString(),
		};
	}

	formatPlanForLLM(plan: TaskPlan): string {
		const lines: string[] = [];
		lines.push(`TASK PLAN: ${plan.title}`);
		lines.push(`Goal: ${plan.description}`);
		lines.push(`Status: ${plan.overallStatus}`);
		lines.push('');

		const readyTasks = this.getReadyTasks(plan);
		const completedCount = plan.tasks.filter(t => t.status === 'completed').length;
		const totalCount = plan.tasks.length;

		lines.push(`Progress: ${completedCount}/${totalCount} tasks completed`);
		lines.push(`Ready to execute: ${readyTasks.length} task(s)`);
		lines.push('');

		lines.push('TASKS:');
		for (const task of plan.tasks) {
			const deps = task.dependencies.length > 0 ? ` [depends on: ${task.dependencies.join(', ')}]` : '';
			const statusEmoji = task.status === 'completed' ? '✅' : task.status === 'failed' ? '❌' : task.status === 'running' ? '🔄' : '⬜';
			lines.push(`${statusEmoji} ${task.id}: ${task.title}${deps}`);
			lines.push(`   ${task.description}`);
			if (task.result) lines.push(`   Result: ${task.result}`);
			if (task.error) lines.push(`   Error: ${task.error}`);
			lines.push('');
		}

		lines.push('INSTRUCTIONS:');
		lines.push('- Pick one "ready" task and complete it using the available tools.');
		lines.push('- When done, mark the task as completed with a summary of what was done.');
		lines.push('- If a task fails, mark it as failed with the error message.');
		lines.push('- Move to the next ready task. Repeat until all tasks are completed.');
		lines.push('- Do not skip tasks — dependencies must be completed first.');

		return lines.join('\n');
	}

	isPlanComplete(plan: TaskPlan): boolean {
		return plan.tasks.length > 0 && plan.tasks.every(t => t.status === 'completed');
	}

	// -----------------------------------------------------------------------
	// Private helpers
	// -----------------------------------------------------------------------

	private detectProjectType(lowerRequest: string): string {
		if (lowerRequest.includes('react') || lowerRequest.includes('next.js') || lowerRequest.includes('nextjs')) return 'react app';
		if (lowerRequest.includes('vue')) return 'vue app';
		if (lowerRequest.includes('angular')) return 'angular app';
		if (lowerRequest.includes('express') || lowerRequest.includes('node')) return 'node.js app';
		if (lowerRequest.includes('python') || lowerRequest.includes('django') || lowerRequest.includes('flask')) return 'python app';
		if (lowerRequest.includes('php') || lowerRequest.includes('laravel')) return 'php app';
		if (lowerRequest.includes('go') || lowerRequest.includes('golang')) return 'go app';
		if (lowerRequest.includes('rust')) return 'rust app';
		if (lowerRequest.includes('java') || lowerRequest.includes('spring')) return 'java app';
		if (lowerRequest.includes('ecommerce') || lowerRequest.includes('e-commerce') || lowerRequest.includes('store')) return 'ecommerce app';
		if (lowerRequest.includes('blog')) return 'blog app';
		if (lowerRequest.includes('api')) return 'api service';
		if (lowerRequest.includes('cli') || lowerRequest.includes('command line')) return 'cli tool';
		return 'application';
	}

	private suggestTasks(lowerRequest: string, projectType: string): TaskPlanTask[] {
		const tasks: TaskPlanTask[] = [];
		const pushTask = (title: string, description: string, dependencies: string[], assignedAgent?: string, priority?: 'high' | 'medium' | 'low'): TaskPlanTask => {
			const t = newTask(title, description, dependencies, { assignedAgent, priority });
			tasks.push(t);
			return t;
		};

		// Phase 1: Project setup (always first)
		const init = pushTask('Initialize project structure', 'Create project directory, initialize git, set up configuration files', [], 'architect', 'high');
		const install = pushTask('Install dependencies', 'Install required packages and dependencies', [init.id], 'general', 'high');

		// Phase 2: Core implementation based on project type
		let lastCore: TaskPlanTask;
		if (projectType.includes('react') || projectType.includes('next') || projectType.includes('vue') || projectType.includes('angular')) {
			const core = pushTask('Create core components', 'Build main UI components and layout', [install.id], 'frontend', 'high');
			const routing = pushTask('Implement routing', 'Set up client-side routing between pages', [core.id], 'frontend', 'medium');
			lastCore = pushTask('Connect to backend/API', 'Integrate with backend services or API', [routing.id], 'api', 'medium');
		} else if (projectType.includes('node') || projectType.includes('express') || projectType.includes('api')) {
			const entry = pushTask('Create server entry point', 'Set up Express/Node server with middleware', [install.id], 'backend', 'high');
			const routes = pushTask('Implement API routes', 'Create REST API endpoints', [entry.id], 'api', 'high');
			lastCore = pushTask('Connect database', 'Set up database connection and models', [routes.id], 'database', 'medium');
		} else if (projectType.includes('php') || projectType.includes('laravel')) {
			const struct = pushTask('Create PHP project structure', 'Set up Laravel or vanilla PHP directory structure', [install.id], 'backend', 'high');
			const routes = pushTask('Implement controllers and routes', 'Create PHP controllers and web routes', [struct.id], 'api', 'high');
			lastCore = pushTask('Connect database', 'Set up database connection and models', [routes.id], 'database', 'medium');
		} else if (projectType.includes('python')) {
			const struct = pushTask('Create Python project structure', 'Set up Python package with requirements', [install.id], 'backend', 'high');
			const core = pushTask('Implement core modules', 'Write main application logic', [struct.id], 'backend', 'high');
			lastCore = pushTask('Connect database', 'Set up database models and migrations', [core.id], 'database', 'medium');
		} else {
			const core = pushTask('Implement core functionality', 'Build the main features of the application', [install.id], 'general', 'high');
			lastCore = pushTask('Integrate components', 'Connect all components together', [core.id], 'general', 'medium');
		}

		// Phase 3: Testing and verification
		const writeTests = pushTask('Write tests', 'Create unit and integration tests', [lastCore.id], 'testing', 'high');
		const runTests = pushTask('Run tests and fix issues', 'Execute tests and fix any failures', [writeTests.id], 'testing', 'high');
		pushTask('Verify application works', 'Final end-to-end verification', [runTests.id], 'review', 'high');

		return tasks;
	}
}

registerSingleton(ITaskDecompositionService, TaskDecompositionService, InstantiationType.Delayed);
