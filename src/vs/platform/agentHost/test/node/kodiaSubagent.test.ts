/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import type { IByokLmChatResult, IByokLmFunctionCallItem, IByokLmInputItem } from '../../common/agentHostByokLm.js';
import { MAX_SUBAGENT_REPORT_CHARS, MAX_SUBAGENT_ROUNDS, MAX_SUBAGENT_TOOL_OUTPUT_CHARS, parseSubagentTask, runSubagent, SUBAGENT_TOOLS, subagentInstructions } from '../../node/kodia/kodiaSubagent.js';
import { approvalOfTool } from '../../node/kodia/kodiaTools.js';

suite('Kodia agent - sub-agent', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const text = (value: string): IByokLmChatResult => ({ output: [{ type: 'message', content: [{ type: 'text', text: value }] }] });
	const call = (name: string, callId: string): IByokLmChatResult => ({ output: [{ type: 'function_call', callId, name, argumentsJson: '{}' }] });

	function host(results: IByokLmChatResult[], toolOutput = 'result') {
		const requests: IByokLmInputItem[][] = [];
		const calls: IByokLmFunctionCallItem[] = [];
		const controller = new AbortController();
		return {
			requests, calls, controller,
			signal: controller.signal,
			chat: async (input: readonly IByokLmInputItem[]) => { requests.push([...input]); return results.shift() ?? text(''); },
			runTool: async (toolCall: IByokLmFunctionCallItem) => { calls.push(toolCall); return toolOutput; },
		};
	}

	test('has only tools that need no approval, and cannot hand a task over itself', () => {
		for (const tool of SUBAGENT_TOOLS) {
			assert.strictEqual(approvalOfTool(tool.name), undefined, tool.name);
		}
		const names = SUBAGENT_TOOLS.map(tool => tool.name);
		assert.ok(names.includes('read_file') && names.includes('search_codebase') && names.includes('git_diff'));
		assert.ok(!names.includes('run_subagent') && !names.includes('edit_file') && !names.includes('run_command') && !names.includes('fetch_url'));
		assert.ok(subagentInstructions('/p').includes('/p') && subagentInstructions(undefined).includes('cannot change files'));
	});

	test('reads its task from the call, and says when there is none', () => {
		assert.deepStrictEqual(parseSubagentTask('{"task":"  Find it. "}'), { task: 'Find it.' });
		assert.ok('error' in parseSubagentTask('{}'));
		assert.ok('error' in parseSubagentTask('{"task":""}'));
		assert.ok('error' in parseSubagentTask('{task'));
	});

	test('calls its tools until it reports, each result sent back to the model', async () => {
		const h = host([call('read_file', 'a'), call('search_codebase', 'b'), text('Found in a.ts:3.')]);
		const result = await runSubagent('Find it.', h);
		assert.deepStrictEqual(result, { success: true, output: 'Found in a.ts:3.', rounds: 3 });
		assert.deepStrictEqual(h.calls.map(c => c.name), ['read_file', 'search_codebase']);
		assert.deepStrictEqual(h.requests[2].map(item => item.type), ['message', 'function_call', 'function_call_output', 'function_call', 'function_call_output']);
	});

	test('a long tool result and a long report are cut', async () => {
		const h = host([call('read_file', 'a'), text('r'.repeat(MAX_SUBAGENT_REPORT_CHARS + 10))], 'x'.repeat(MAX_SUBAGENT_TOOL_OUTPUT_CHARS + 10));
		const result = await runSubagent('Find it.', h);
		const sent = h.requests[1].find(item => item.type === 'function_call_output')!;
		assert.ok(sent.type === 'function_call_output' && sent.output.length < MAX_SUBAGENT_TOOL_OUTPUT_CHARS + 200 && sent.output.includes('cut here'));
		assert.ok(result.success && result.output.length < MAX_SUBAGENT_REPORT_CHARS + 200 && result.output.includes('cut here'));
	});

	test('stops after its rounds, with what it had written last', async () => {
		const results = Array.from({ length: MAX_SUBAGENT_ROUNDS + 5 }, (_, i): IByokLmChatResult => ({ output: [{ type: 'message', content: [{ type: 'text', text: `So far ${i}.` }] }, { type: 'function_call', callId: `c${i}`, name: 'ls_dir', argumentsJson: '{}' }] }));
		const h = host(results);
		const result = await runSubagent('Loop.', h);
		assert.strictEqual(result.success, false);
		assert.strictEqual(h.requests.length, MAX_SUBAGENT_ROUNDS);
		assert.ok(result.output.includes(`So far ${MAX_SUBAGENT_ROUNDS - 1}.`));
	});

	test('fails when the model fails, when it says nothing, and when the turn is stopped', async () => {
		assert.deepStrictEqual(await runSubagent('x', host([{ output: [], error: 'Boom' }])), { success: false, output: `The sub-agent's model request failed: Boom`, rounds: 1 });
		assert.strictEqual((await runSubagent('x', host([text('')]))).success, false);

		const h = host([call('read_file', 'a'), text('never')]);
		h.runTool = async () => { h.controller.abort(); return 'late'; };
		const stopped = await runSubagent('x', h);
		assert.deepStrictEqual([stopped.success, h.requests.length], [false, 1]);
	});
});
