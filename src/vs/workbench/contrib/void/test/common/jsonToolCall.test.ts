/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { jsonToolCallOfText, withNativeToolsForMlx } from '../../common/jsonToolCall.js';
import { OverridesOfModel } from '../../common/voidSettingsTypes.js';

suite('Kodia - a tool call written as JSON', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const tools = new Set(['read_file', 'run_subagent']);

	test('reads the object in a code block, and takes it out of the text', () => {
		const reply = 'I will read it.\n```json\n{"name": "read_file", "arguments": {"uri": "src/a.ts"}}\n```';
		assert.deepStrictEqual(jsonToolCallOfText(reply, tools, 'id-1'), {
			text: 'I will read it.',
			call: { name: 'read_file', rawParams: { uri: 'src/a.ts' }, doneParams: ['uri'], id: 'id-1', isDone: true },
		});
	});

	test('reads an object on its own, at the end of the text', () => {
		const reply = 'Here it is: {"name": "run_subagent", "arguments": {"task": "find greet"}}';
		const found = jsonToolCallOfText(reply, tools, 'id-2');
		assert.strictEqual(found?.call.name, 'run_subagent');
		assert.strictEqual(found?.call.rawParams.task, 'find greet');
		assert.strictEqual(found?.text, 'Here it is:');
	});

	test('turns numbers, flags and nested values into the strings the tools take', () => {
		const reply = '{"name": "read_file", "arguments": {"uri": "a.ts", "start_line": 3, "page_number": 1, "flag": true, "extra": {"k": "v"}, "gone": null}}';
		const found = jsonToolCallOfText(reply, tools, 'id-3');
		assert.deepStrictEqual(found?.call.rawParams, { uri: 'a.ts', start_line: '3', page_number: '1', flag: 'true', extra: '{"k":"v"}' });
	});

	test('accepts the arguments as a JSON string, and the parameters key', () => {
		assert.strictEqual(jsonToolCallOfText('{"name": "read_file", "arguments": "{\\"uri\\": \\"b.ts\\"}"}', tools, 'i')?.call.rawParams.uri, 'b.ts');
		assert.strictEqual(jsonToolCallOfText('{"name": "read_file", "parameters": {"uri": "c.ts"}}', tools, 'i')?.call.rawParams.uri, 'c.ts');
	});

	test('takes the last call when there are several, and ignores objects that name another tool', () => {
		const reply = '```json\n{"name": "read_file", "arguments": {"uri": "first.ts"}}\n```\nand then\n```json\n{"name": "read_file", "arguments": {"uri": "second.ts"}}\n```';
		assert.strictEqual(jsonToolCallOfText(reply, tools, 'i')?.call.rawParams.uri, 'second.ts');
		assert.strictEqual(jsonToolCallOfText('```json\n{"name": "delete_everything", "arguments": {}}\n```', tools, 'i'), undefined);
	});

	test('leaves ordinary text alone, and JSON that is not a call', () => {
		assert.strictEqual(jsonToolCallOfText('The answer is 42.', tools, 'i'), undefined);
		assert.strictEqual(jsonToolCallOfText('```json\n{"name": "read_file", "arguments": ["not", "an", "object"]}\n```', tools, 'i'), undefined);
		assert.strictEqual(jsonToolCallOfText('```json\n{"name": "read_file", "arguments": {"uri": \n```', tools, 'i'), undefined);
		assert.strictEqual(jsonToolCallOfText('{"answer": "no name here"}', tools, 'i'), undefined);
	});

	test('a local MLX model with no tool format of its own is offered the tools natively, and nothing else changes', () => {
		const mlx = withNativeToolsForMlx({ providerName: 'mlx', modelName: 'mlx-community/Some-Unknown-Model-4bit' }, {} as OverridesOfModel);
		assert.strictEqual(mlx.mlx?.['mlx-community/Some-Unknown-Model-4bit']?.specialToolFormat, 'openai-style');
		const openAI = {} as OverridesOfModel;
		assert.strictEqual(withNativeToolsForMlx({ providerName: 'openAI', modelName: 'gpt-6.1-sol' }, openAI), openAI);
	});
});
