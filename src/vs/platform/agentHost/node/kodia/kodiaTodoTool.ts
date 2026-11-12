/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import type { IByokLmFunctionTool } from '../../common/agentHostByokLm.js';

// A task list the Kodia agent keeps for a long task: the model sends the whole list each time and gets it back, written
// out. The list lives in the conversation, in the model's own calls and the results it gets, so there is nothing for the
// agent to store, and a restored chat has its list back with its history.

export const TODO_TOOL_NAME = 'todo_write';

export const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export type TodoStatus = typeof TODO_STATUSES[number];

export interface ITodoItem {
	readonly content: string;
	readonly status: TodoStatus;
}

export const MAX_TODO_ITEMS = 50;

export const TODO_FUNCTION_TOOL: IByokLmFunctionTool = {
	type: 'function',
	name: TODO_TOOL_NAME,
	description: 'Keeps a task list for a long or multi-step task, so you and the user can see what is done and what is left. Send the whole list each time: it replaces the previous one. Use it for a task of three steps or more, not for a simple request. Have one task in_progress at a time, and mark each task completed as soon as it is done.',
	parametersSchema: {
		type: 'object',
		properties: {
			todos: {
				type: 'array',
				description: 'The whole list, in the order the tasks are done.',
				items: {
					type: 'object',
					properties: {
						content: { type: 'string', description: 'The task, in the imperative: "Fix the failing test".' },
						status: { type: 'string', enum: [...TODO_STATUSES], description: 'pending, in_progress or completed.' },
					},
					required: ['content', 'status'],
					additionalProperties: false,
				},
			},
		},
		required: ['todos'],
		additionalProperties: false,
	},
};

/** The items of a call's arguments, or what is wrong with them. */
export function parseTodoItems(args: Record<string, unknown>): { readonly items: readonly ITodoItem[] } | { readonly error: string } {
	if (!Array.isArray(args.todos)) {
		return { error: 'Missing "todos": the whole list, as an array of { content, status }.' };
	}
	if (args.todos.length > MAX_TODO_ITEMS) {
		return { error: `A list of at most ${MAX_TODO_ITEMS} tasks: group the small ones.` };
	}
	const items: ITodoItem[] = [];
	for (const [i, entry] of args.todos.entries()) {
		const content = entry && typeof entry === 'object' && typeof (entry as { content?: unknown }).content === 'string' ? (entry as { content: string }).content.trim() : '';
		const status = entry && typeof entry === 'object' ? (entry as { status?: unknown }).status : undefined;
		if (!content) {
			return { error: `Task ${i + 1} has no "content".` };
		}
		if (!(TODO_STATUSES as readonly unknown[]).includes(status)) {
			return { error: `Task ${i + 1} ("${content}") has status ${JSON.stringify(status)}: use ${TODO_STATUSES.join(', ')}.` };
		}
		items.push({ content, status: status as TodoStatus });
	}
	return { items };
}

const MARKS: Readonly<Record<TodoStatus, string>> = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };

/** The list as text for the model, which sees it again at each call, and the one-line summary the user sees. */
export function describeTodoList(items: readonly ITodoItem[]): { readonly text: string; readonly summary: string } {
	const done = items.filter(item => item.status === 'completed').length;
	const inProgress = items.filter(item => item.status === 'in_progress');
	const summary = items.length ? `${done}/${items.length} done${inProgress.length === 1 ? `, now: ${inProgress[0].content}` : ''}` : 'cleared';
	if (!items.length) {
		return { text: 'The task list is empty.', summary };
	}
	const lines = items.map(item => `${MARKS[item.status]} ${item.content}`);
	const advice = inProgress.length > 1 ? '\nMore than one task is in progress: have one at a time.' : !inProgress.length && done < items.length ? '\nNo task is in progress: mark the one you start next.' : '';
	return { text: `Task list updated (${done} of ${items.length} done):\n${lines.join('\n')}${advice}`, summary };
}
