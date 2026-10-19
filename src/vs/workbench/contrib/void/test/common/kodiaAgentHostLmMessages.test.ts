/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { toInternalTool, toOutput, toSimpleMessages, toUsage } from '../../common/kodiaAgentHostLmMessages.js';

suite('kodiaAgentHostLmMessages', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('pairs each tool call with its result, after the assistant message of its response', () => {
		const thinking = [{ type: 'thinking' as const, thinking: 'hmm', signature: 'sig' }];
		const messages = toSimpleMessages([
			{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Fix it' }] },
			// Response 1: text and two calls.
			{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Looking.' }] },
			{ type: 'function_call', callId: 'a', name: 'read_file', argumentsJson: '{"path":"x.ts"}' },
			{ type: 'function_call', callId: 'b', name: 'list_dir', argumentsJson: '{}' },
			{ type: 'function_call_output', callId: 'a', output: 'contents' },
			{ type: 'function_call_output', callId: 'b', output: 'x.ts' },
			// Response 2: reasoning and a call, no text.
			{ type: 'reasoning', summary: ['hmm'], metadata: { anthropicReasoning: thinking } },
			{ type: 'function_call', callId: 'c', name: 'write_file', argumentsJson: '{"path":"x.ts","content":"y"}' },
			{ type: 'function_call_output', callId: 'c', output: 'ok' },
			// Response 3: the answer.
			{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Fixed.' }] },
		]);

		assert.deepStrictEqual(messages, [
			{ role: 'user', content: 'Fix it' },
			{ role: 'assistant', content: 'Looking.', anthropicReasoning: null },
			{ role: 'tool', id: 'a', name: 'read_file', rawParams: { path: 'x.ts' }, content: 'contents' },
			{ role: 'tool', id: 'b', name: 'list_dir', rawParams: {}, content: 'x.ts' },
			{ role: 'assistant', content: '', anthropicReasoning: thinking },
			{ role: 'tool', id: 'c', name: 'write_file', rawParams: { path: 'x.ts', content: 'y' }, content: 'ok' },
			{ role: 'assistant', content: 'Fixed.', anthropicReasoning: null },
		]);
	});

	test('leaves out a tool call without a result', () => {
		assert.deepStrictEqual(toSimpleMessages([
			{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Hi' }] },
			{ type: 'function_call', callId: 'a', name: 'list_dir', argumentsJson: '{}' },
		]), [{ role: 'user', content: 'Hi' }]);
	});

	test('turns a final message into reasoning, text and tool call items', () => {
		const anthropicReasoning = [{ type: 'thinking' as const, thinking: 'hmm', signature: 'sig' }];
		assert.deepStrictEqual(toOutput({
			fullText: 'Reading.',
			fullReasoning: 'hmm',
			anthropicReasoning,
			toolCalls: [{ id: 'a', name: 'read_file', rawParams: { path: 'x.ts' }, doneParams: [], isDone: true }],
		}), [
			{ type: 'reasoning', summary: ['hmm'], metadata: { anthropicReasoning } },
			{ type: 'message', content: [{ type: 'text', text: 'Reading.' }] },
			{ type: 'function_call', callId: 'a', name: 'read_file', argumentsJson: '{"path":"x.ts"}' },
		]);
		assert.deepStrictEqual(toOutput({ fullText: '', fullReasoning: '', anthropicReasoning: null }), []);
	});

	test('offers a function tool\'s parameters with their descriptions', () => {
		assert.deepStrictEqual(toInternalTool({
			type: 'function',
			name: 'read_file',
			description: 'Read a file.',
			parametersSchema: { type: 'object', properties: { path: { type: 'string', description: 'File path.' } } },
		}), [{ name: 'read_file', description: 'Read a file.', params: { path: { description: 'File path.' } } }]);
		assert.deepStrictEqual(toInternalTool({ type: 'custom', name: 'apply_patch' }), []);
	});

	test('counts cached input tokens as input', () => {
		assert.deepStrictEqual(toUsage({ input: 10, output: 5, cacheRead: 100, cacheWrite: 20 }), { inputTokens: 130, outputTokens: 5 });
		assert.strictEqual(toUsage(undefined), undefined);
	});
});
