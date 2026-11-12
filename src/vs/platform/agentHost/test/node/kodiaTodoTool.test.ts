/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { approvalOfTool, describeKodiaToolCall, executeKodiaTool, toolDisplayName } from '../../node/kodia/kodiaTools.js';
import { describeTodoList, MAX_TODO_ITEMS, parseTodoItems, TODO_FUNCTION_TOOL, TODO_TOOL_NAME } from '../../node/kodia/kodiaTodoTool.js';

suite('Kodia agent task list', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const run = (args: object) => executeKodiaTool(TODO_TOOL_NAME, JSON.stringify(args), { workingDirectory: URI.file('/work'), signal: new AbortController().signal });
	const list = [
		{ content: 'Read the config', status: 'completed' },
		{ content: 'Fix the bug', status: 'in_progress' },
		{ content: 'Add a test', status: 'pending' },
	];

	test('is offered with the whole list as an array of tasks, and asks for nothing', () => {
		const schema = TODO_FUNCTION_TOOL.parametersSchema as { properties: { todos: { type: string, items: { properties: { status: { enum: string[] } }, required: string[] } } }, required: string[] };
		assert.strictEqual(TODO_FUNCTION_TOOL.name, 'todo_write');
		assert.deepStrictEqual(schema.required, ['todos']);
		assert.strictEqual(schema.properties.todos.type, 'array');
		assert.deepStrictEqual(schema.properties.todos.items.properties.status.enum, ['pending', 'in_progress', 'completed']);
		assert.deepStrictEqual(schema.properties.todos.items.required, ['content', 'status']);
		assert.strictEqual(approvalOfTool(TODO_TOOL_NAME), undefined);
		assert.strictEqual(toolDisplayName(TODO_TOOL_NAME), 'Update Task List');
	});

	test('gives the list back, written out, for the model to see at each call', async () => {
		assert.deepStrictEqual(await run({ todos: list }), {
			success: true,
			output: 'Task list updated (1 of 3 done):\n[x] Read the config\n[~] Fix the bug\n[ ] Add a test',
		});
	});

	test('says when no task is in progress, or when several are', () => {
		assert.ok(describeTodoList([{ content: 'A', status: 'completed' }, { content: 'B', status: 'pending' }]).text.endsWith('No task is in progress: mark the one you start next.'));
		assert.ok(describeTodoList([{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'in_progress' }]).text.endsWith('More than one task is in progress: have one at a time.'));
		// nothing is left to start
		assert.ok(!describeTodoList([{ content: 'A', status: 'completed' }]).text.includes('No task is in progress'));
	});

	test('an empty list clears it', async () => {
		assert.deepStrictEqual(await run({ todos: [] }), { success: true, output: 'The task list is empty.' });
	});

	test('says what is wrong with a list', async () => {
		assert.deepStrictEqual(await run({}), { success: false, output: 'Missing "todos": the whole list, as an array of { content, status }.' });
		assert.deepStrictEqual(await run({ todos: 'Fix the bug' }), { success: false, output: 'Missing "todos": the whole list, as an array of { content, status }.' });
		assert.deepStrictEqual(await run({ todos: [{ content: '  ', status: 'pending' }] }), { success: false, output: 'Task 1 has no "content".' });
		assert.deepStrictEqual(await run({ todos: [{ content: 'A', status: 'pending' }, 'B'] }), { success: false, output: 'Task 2 has no "content".' });
		assert.deepStrictEqual(await run({ todos: [{ content: 'A', status: 'done' }] }), { success: false, output: 'Task 1 ("A") has status "done": use pending, in_progress, completed.' });
		assert.deepStrictEqual(await run({ todos: [{ content: 'A' }] }), { success: false, output: 'Task 1 ("A") has status undefined: use pending, in_progress, completed.' });
		const tooMany = parseTodoItems({ todos: Array.from({ length: MAX_TODO_ITEMS + 1 }, () => ({ content: 'A', status: 'pending' })) });
		assert.ok('error' in tooMany && tooMany.error.includes(`${MAX_TODO_ITEMS}`));
	});

	test('shows the user how far along it is', () => {
		const describe = (args: object) => describeKodiaToolCall(TODO_TOOL_NAME, JSON.stringify(args), undefined).invocationMessage;
		assert.strictEqual(describe({ todos: list }), 'Update the task list (1/3 done, now: Fix the bug)');
		assert.strictEqual(describe({ todos: [{ content: 'A', status: 'completed' }] }), 'Update the task list (1/1 done)');
		assert.strictEqual(describe({ todos: [] }), 'Update the task list (cleared)');
		assert.strictEqual(describe({ todos: 'nonsense' }), 'Update Task List');
	});
});
