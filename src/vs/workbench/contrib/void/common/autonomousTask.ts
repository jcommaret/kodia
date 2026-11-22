/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked';

export type TaskPriority = 'high' | 'medium' | 'low';

export type TaskPlanTask = {
	id: string;
	title: string;
	description: string;
	status: TaskStatus;
	dependencies: string[]; // task IDs that must be completed before this task
	result?: string; // result/output from completed task
	error?: string; // error message if failed
	priority?: TaskPriority;
	assignedAgent?: string;
	acceptanceCriteria?: string[];
	evidence?: string;
	retryCount?: number;
	updatedAt?: string;
};

export type TaskPlan = {
	id: string;
	title: string;
	description: string;
	overallStatus: 'pending' | 'in_progress' | 'completed' | 'failed';
	tasks: TaskPlanTask[];
	createdAt: string;
	updatedAt: string;
};

export const newTaskPlan = (title: string, description: string): TaskPlan => {
	const now = new Date().toISOString();
	const id = 'task-plan-' + now.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 30);
	return {
		id,
		title,
		description,
		overallStatus: 'pending',
		tasks: [],
		createdAt: now,
		updatedAt: now,
	};
};

export const newTask = (
	title: string,
	description: string,
	dependencies: string[] = [],
	extras?: { priority?: TaskPriority; assignedAgent?: string; acceptanceCriteria?: string[] },
): TaskPlanTask => {
	return {
		id: 'task-' + Math.random().toString(36).slice(2, 11),
		title,
		description,
		status: 'pending',
		dependencies,
		...(extras?.priority ? { priority: extras.priority } : {}),
		...(extras?.assignedAgent ? { assignedAgent: extras.assignedAgent } : {}),
		...(extras?.acceptanceCriteria?.length ? { acceptanceCriteria: extras.acceptanceCriteria } : {}),
		updatedAt: new Date().toISOString(),
	};
};

export const addTask = (plan: TaskPlan, task: TaskPlanTask): TaskPlan => {
	const tasks = [...plan.tasks, task];
	return {
		...plan,
		tasks,
		overallStatus: computeOverallStatus(tasks),
		updatedAt: new Date().toISOString(),
	};
};

export const updateTaskStatus = (plan: TaskPlan, taskId: string, status: TaskStatus, result?: string, error?: string, evidence?: string): TaskPlan => {
	const now = new Date().toISOString();
	const tasks = plan.tasks.map(t =>
		t.id === taskId
			? {
				...t,
				status,
				...(result !== undefined ? { result } : {}),
				...(error !== undefined ? { error } : {}),
				...(evidence !== undefined ? { evidence } : {}),
				updatedAt: now,
			}
			: t
	);
	return {
		...plan,
		tasks,
		overallStatus: computeOverallStatus(tasks),
		updatedAt: now,
	};
};

/** Explicitly reset a failed or blocked task back to pending so it can be retried. */
export const retryTask = (plan: TaskPlan, taskId: string): TaskPlan => {
	const now = new Date().toISOString();
	const tasks = plan.tasks.map(t =>
		t.id === taskId && (t.status === 'failed' || t.status === 'blocked')
			? { ...t, status: 'pending' as TaskStatus, error: undefined, retryCount: (t.retryCount ?? 0) + 1, updatedAt: now }
			: t
	);
	return {
		...plan,
		tasks,
		overallStatus: computeOverallStatus(tasks),
		updatedAt: now,
	};
};

export type TaskEditPatch = {
	title?: string;
	description?: string;
	dependencies?: string[];
	priority?: TaskPriority;
	assignedAgent?: string | undefined;
	acceptanceCriteria?: string[];
	evidence?: string;
};

export const editTask = (plan: TaskPlan, taskId: string, patch: TaskEditPatch): TaskPlan => {
	const now = new Date().toISOString();
	const tasks = plan.tasks.map(t => {
		if (t.id !== taskId) { return t; }
		return {
			...t,
			...(patch.title !== undefined ? { title: patch.title } : {}),
			...(patch.description !== undefined ? { description: patch.description } : {}),
			...(patch.dependencies !== undefined ? { dependencies: patch.dependencies } : {}),
			...(patch.priority !== undefined ? { priority: patch.priority } : {}),
			...('assignedAgent' in patch ? { assignedAgent: patch.assignedAgent } : {}),
			...(patch.acceptanceCriteria !== undefined ? { acceptanceCriteria: patch.acceptanceCriteria } : {}),
			...(patch.evidence !== undefined ? { evidence: patch.evidence } : {}),
			updatedAt: now,
		};
	});
	return {
		...plan,
		tasks,
		overallStatus: computeOverallStatus(tasks),
		updatedAt: now,
	};
};

export const removeTask = (plan: TaskPlan, taskId: string): TaskPlan => {
	const now = new Date().toISOString();
	const tasks = plan.tasks
		.filter(t => t.id !== taskId)
		.map(t => ({ ...t, dependencies: t.dependencies.filter(d => d !== taskId) }));
	return {
		...plan,
		tasks,
		overallStatus: computeOverallStatus(tasks),
		updatedAt: now,
	};
};

export const computeOverallStatus = (tasks: TaskPlanTask[]): 'pending' | 'in_progress' | 'completed' | 'failed' => {
	if (tasks.length === 0) return 'pending';
	const hasFailed = tasks.some(t => t.status === 'failed');
	const hasBlocked = tasks.some(t => t.status === 'blocked');
	const allCompleted = tasks.every(t => t.status === 'completed');
	const anyRunning = tasks.some(t => t.status === 'running');
	if (hasFailed) return 'failed';
	if (allCompleted) return 'completed';
	if (anyRunning || hasBlocked) return 'in_progress';
	return 'pending';
};

export const getParallelReadyTasks = (plan: TaskPlan): TaskPlanTask[] => {
	const completedIds = new Set(plan.tasks.filter(t => t.status === 'completed').map(t => t.id));
	const priorityRank: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 };
	return plan.tasks
		.filter(task => task.status === 'pending' && task.dependencies.every(depId => completedIds.has(depId)))
		.sort((a, b) => (priorityRank[a.priority ?? 'medium'] - priorityRank[b.priority ?? 'medium']));
};

export const getNextPendingTask = (plan: TaskPlan): TaskPlanTask | null => {
	return getParallelReadyTasks(plan)[0] ?? null;
};

export const getTaskById = (plan: TaskPlan, taskId: string): TaskPlanTask | undefined => {
	return plan.tasks.find(t => t.id === taskId);
};

export const getPlanProgress = (plan: TaskPlan): { completed: number, total: number, percent: number } => {
	const completed = plan.tasks.filter(t => t.status === 'completed').length;
	const total = plan.tasks.length;
	const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
	return { completed, total, percent };
};

export const isValidStateTransition = (from: TaskStatus, to: TaskStatus): boolean => {
	// Define valid state transitions
	const validTransitions: Record<TaskStatus, TaskStatus[]> = {
		pending: ['running', 'completed', 'blocked', 'failed'],
		running: ['completed', 'failed', 'blocked'],
		completed: [], // Terminal state — no transitions out
		failed: [], // Terminal state — no transitions out
		blocked: ['pending', 'running', 'failed'], // Can be unblocked
	};
	return validTransitions[from]?.includes(to) ?? false;
};

/**
 * Detect circular dependencies in a task plan.
 * Uses DFS to find cycles in the dependency graph.
 */
export const hasCircularDependencies = (plan: TaskPlan): boolean => {
	const taskMap = new Map(plan.tasks.map(t => [t.id, t]));
	const visiting = new Set<string>();
	const visited = new Set<string>();

	const dfs = (taskId: string): boolean => {
		if (visited.has(taskId)) return false;
		if (visiting.has(taskId)) return true; // Back edge = cycle

		visiting.add(taskId);
		const task = taskMap.get(taskId);
		if (task) {
			for (const depId of task.dependencies) {
				if (dfs(depId)) return true;
			}
		}
		visiting.delete(taskId);
		visited.add(taskId);
		return false;
	};

	for (const task of plan.tasks) {
		if (dfs(task.id)) return true;
	}
	return false;
};

export const formatTaskPlanForLLM = (plan: TaskPlan): string => {
	const lines: string[] = [];
	lines.push(`Task Plan: ${plan.title}`);
	lines.push(`Description: ${plan.description}`);
	lines.push(`Overall Status: ${plan.overallStatus}`);
	lines.push(`Progress: ${getPlanProgress(plan).percent}% (${getPlanProgress(plan).completed}/${getPlanProgress(plan).total} tasks)`);
	lines.push('');
	lines.push('Tasks:');
	for (const task of plan.tasks) {
		const meta: string[] = [];
		if (task.priority) meta.push(`priority: ${task.priority}`);
		if (task.assignedAgent) meta.push(`agent: ${task.assignedAgent}`);
		if (task.dependencies.length > 0) meta.push(`depends on: ${task.dependencies.join(', ')}`);
		const metaStr = meta.length > 0 ? ` (${meta.join('; ')})` : '';
		lines.push(`- [${task.status}] ${task.id}: ${task.title}${metaStr}`);
		lines.push(`  Description: ${task.description}`);
		if (task.acceptanceCriteria?.length) lines.push(`  Acceptance criteria: ${task.acceptanceCriteria.join(' | ')}`);
		if (task.result) lines.push(`  Result: ${task.result}`);
		if (task.evidence) lines.push(`  Evidence: ${task.evidence}`);
		if (task.error) lines.push(`  Error: ${task.error}`);
	}
	const ready = getParallelReadyTasks(plan);
	if (ready.length > 0) {
		lines.push('');
		lines.push(`Ready tasks (${ready.length}${ready.length > 1 ? ', parallelizable' : ''}): ${ready.map(t => `${t.id} (${t.title})`).join(', ')}`);
	}
	return lines.join('\n');
};

// Verification result for a task step
export type VerificationResult = {
	passed: boolean;
	evidence: string; // human-readable description of what was checked
	details?: string; // additional details (output, error messages, etc.)
};

// Verify that a file exists at the given URI path
export const verifyFileExists = async (fileService: any, uri: string): Promise<VerificationResult> => {
	try {
		const stat = await fileService.stat(URI.file(uri));
		if (stat) {
			return {
				passed: true,
				evidence: `File exists at ${uri}`,
				details: `File stat: isFile=${stat.isFile}, isDirectory=${stat.isDirectory}`,
			};
		}
		return {
			passed: false,
			evidence: `File does not exist at ${uri}`,
			details: 'File service stat returned no result',
		};
	} catch (err: any) {
		return {
			passed: false,
			evidence: `File does not exist at ${uri}`,
			details: err?.message || String(err),
		};
	}
};

// Verify that terminal command output contains expected text
export const verifyTerminalOutput = (terminalOutput: string, expectedPattern: string | RegExp): VerificationResult => {
	const pattern = typeof expectedPattern === 'string' ? new RegExp(expectedPattern, 'i') : expectedPattern;
	const matched = pattern.test(terminalOutput);
	if (matched) {
		return {
			passed: true,
			evidence: `Output matches pattern: ${expectedPattern}`,
			details: terminalOutput,
		};
	}
	return {
		passed: false,
		evidence: `Output does not match pattern: ${expectedPattern}`,
		details: terminalOutput,
	};
};

// Verify that a terminal command exited successfully (exit code 0)
export const verifyCommandSuccess = (exitCode: number | undefined): VerificationResult => {
	if (exitCode === 0) {
		return {
			passed: true,
			evidence: `Command exited with code 0`,
		};
	}
	return {
		passed: false,
		evidence: `Command exited with code ${exitCode ?? 'unknown'}`,
	};
};

// Verify that a file contains expected text
export const verifyFileContains = async (fileService: any, uri: string, expectedText: string): Promise<VerificationResult> => {
	try {
		const stat = await fileService.stat(URI.file(uri));
		if (!stat || !stat.isFile) {
			return {
				passed: false,
				evidence: `File does not exist at ${uri}`,
			};
		}
		const contents = await fileService.readFile(URI.file(uri));
		const text = contents.value.toString();
		if (text.includes(expectedText)) {
			return {
				passed: true,
				evidence: `File contains expected text at ${uri}`,
				details: `Found: "${expectedText}"`,
			};
		}
		return {
			passed: false,
			evidence: `File does not contain expected text at ${uri}`,
			details: `Expected: "${expectedText}"`,
		};
	} catch (err: any) {
		return {
			passed: false,
			evidence: `Could not read file at ${uri}`,
			details: err?.message || String(err),
		};
	}
};
