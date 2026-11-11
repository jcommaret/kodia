/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import type { IByokLmInputItem } from '../../common/agentHostByokLm.js';
import { CLEARED_TOOL_RESULT, summarizedThreadMessage } from '../../../kodia/common/threadSummary.js';
import { chooseKeepIdx, clearOldToolResults, estimateHistoryTokens, latestUserIdx, modelHistory, tokensOfChars, transcriptMessages } from '../../node/kodia/kodiaContext.js';

const user = (text: string): IByokLmInputItem => ({ type: 'message', role: 'user', content: [{ type: 'text', text }] });
const assistant = (text: string): IByokLmInputItem => ({ type: 'message', role: 'assistant', content: [{ type: 'text', text }] });
const call = (callId: string, args = '{"uri":"a.ts"}'): IByokLmInputItem => ({ type: 'function_call', callId, name: 'read_file', argumentsJson: args });
const result = (callId: string, output: string): IByokLmInputItem => ({ type: 'function_call_output', callId, output });

// a turn: the request, then `steps` rounds of a call and its result, each result at least `size` characters
function turn(request: string, steps: number, from = 0, size = 0): IByokLmInputItem[] {
	const items = [user(request)];
	for (let i = from; i < from + steps; i++) {
		items.push(call(`c${i}`), result(`c${i}`, `output ${i}`.padEnd(size, '.')));
	}
	return items;
}

suite('Kodia agent - keeping a long conversation within the context window', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('estimates the tokens of what the model is sent from its characters, an image by a fixed size', () => {
		assert.strictEqual(estimateHistoryTokens([]), 0);
		assert.strictEqual(estimateHistoryTokens([user('a'.repeat(30))]), 10);
		assert.strictEqual(estimateHistoryTokens([call('c1', '{}'), result('c1', 'x'.repeat(28))]), Math.ceil(('read_file'.length + 2 + 28) / 3));
		const withImage: IByokLmInputItem = { type: 'function_call_output', callId: 'c1', output: '', content: [{ type: 'text', text: 'abc' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }] };
		assert.strictEqual(estimateHistoryTokens([withImage]), Math.ceil((3 + 3_000) / 3));
		assert.strictEqual(tokensOfChars(10), 4);
	});

	test('finds the latest message of the user', () => {
		assert.strictEqual(latestUserIdx([]), -1);
		assert.strictEqual(latestUserIdx([assistant('hi')]), -1);
		assert.strictEqual(latestUserIdx([...turn('first', 1), assistant('done'), ...turn('second', 2)]), 4);
	});

	suite('the model is sent a view of the history, which stays as it is', () => {

		test('without a compaction, it is the history', () => {
			const history = turn('Fix it', 2);
			assert.deepStrictEqual(modelHistory(history, undefined), history);
			assert.deepStrictEqual(modelHistory(history, { clearedBefore: 0 }), history);
		});

		test('the results of the tool calls before `clearedBefore` are a stub, and the others are not', () => {
			const history = [...turn('first', 2), assistant('done'), ...turn('second', 1, 2)];
			const before = JSON.stringify(history);
			const view = modelHistory(history, { clearedBefore: 6 });

			assert.deepStrictEqual(view.filter(item => item.type === 'function_call_output'), [
				{ type: 'function_call_output', callId: 'c0', output: CLEARED_TOOL_RESULT },
				{ type: 'function_call_output', callId: 'c1', output: CLEARED_TOOL_RESULT },
				{ type: 'function_call_output', callId: 'c2', output: 'output 2' },
			]);
			assert.strictEqual(view.length, history.length, 'the calls and the messages stay, so the model sees what it did');
			assert.strictEqual(JSON.stringify(history), before, 'the history is not changed');
		});

		test('a summary replaces what is before `keepFromIdx`', () => {
			const history = [...turn('first', 1), assistant('done'), ...turn('second', 1, 1)];
			const view = modelHistory(history, { clearedBefore: 0, summary: { text: 'We read a.ts.', keepFromIdx: 4 } });

			assert.deepStrictEqual(view, [
				{ type: 'message', role: 'user', content: [{ type: 'text', text: summarizedThreadMessage('We read a.ts.', undefined) }] },
				...history.slice(4),
			], 'the latest request is kept, so the summary does not carry it');
		});

		test('a summary that cut the current turn carries its request, so the work goes on', () => {
			const history = turn('Refactor the parser', 8);
			const view = modelHistory(history, { clearedBefore: 0, summary: { text: 'Read six files.', keepFromIdx: 9 } });

			assert.strictEqual(view.length, history.length - 9 + 1);
			assert.deepStrictEqual(view[0], { type: 'message', role: 'user', content: [{ type: 'text', text: summarizedThreadMessage('Read six files.', 'Refactor the parser') }] });
			assert.deepStrictEqual(view.slice(1), history.slice(9));
		});

		test('both together: the results kept after a summary can still be cleared', () => {
			const history = turn('Refactor the parser', 8);
			const view = modelHistory(history, { clearedBefore: 11, summary: { text: 'S', keepFromIdx: 9 } });
			const outputs = view.filter(item => item.type === 'function_call_output').map(item => (item as { output: string }).output);
			assert.deepStrictEqual(outputs, [CLEARED_TOOL_RESULT, 'output 5', 'output 6', 'output 7']);
		});

		test('a summary that no longer points into the history is not applied', () => {
			const history = turn('Fix it', 1);
			assert.deepStrictEqual(modelHistory(history, { clearedBefore: 0, summary: { text: 'S', keepFromIdx: 50 } }), history);
			assert.deepStrictEqual(modelHistory(history, { clearedBefore: 0, summary: { text: 'S', keepFromIdx: 0 } }), history);
		});
	});

	suite('clearing the results of old tool calls', () => {

		test('clears those before the latest message of the user, and says how much that frees', () => {
			const history = [...turn('first', 2, 0, 500), assistant('done'), ...turn('second', 1, 2, 500)];
			const cleared = clearOldToolResults(history, undefined);
			assert.ok(cleared);
			assert.strictEqual(cleared.compaction.clearedBefore, 6);
			assert.strictEqual(cleared.clearedChars, 2 * (500 - CLEARED_TOOL_RESULT.length), 'the two results of the first turn');
		});

		test('frees what the results take beyond the stub, and nothing for a result shorter than it', () => {
			assert.strictEqual(clearOldToolResults([...turn('first', 2), assistant('done'), user('second')], undefined), undefined);
			const big = [user('first'), call('c0'), result('c0', 'x'.repeat(1_000)), assistant('done'), user('second')];
			const cleared = clearOldToolResults(big, undefined);
			assert.strictEqual(cleared?.clearedChars, 1_000 - CLEARED_TOOL_RESULT.length);
			assert.deepStrictEqual(cleared?.compaction, { clearedBefore: 4 });
		});

		test('there is nothing to clear in the current turn, or twice', () => {
			assert.strictEqual(clearOldToolResults(turn('only', 3), undefined), undefined);
			const big = [user('first'), call('c0'), result('c0', 'x'.repeat(1_000)), assistant('done'), user('second')];
			const once = clearOldToolResults(big, undefined)!;
			assert.strictEqual(clearOldToolResults(big, once.compaction), undefined);
		});

		test('keeps the summary, and does not count what the summary replaces', () => {
			const history = [user('first'), call('c0'), result('c0', 'x'.repeat(1_000)), assistant('done'), user('second'), call('c1'), result('c1', 'y'.repeat(500)), assistant('ok'), user('third')];
			const summarized = { clearedBefore: 0, summary: { text: 'S', keepFromIdx: 4 } };
			const cleared = clearOldToolResults(history, summarized);
			assert.strictEqual(cleared?.clearedChars, 500 - CLEARED_TOOL_RESULT.length);
			assert.deepStrictEqual(cleared?.compaction, { clearedBefore: 8, summary: summarized.summary });
		});
	});

	suite('choosing what a summary replaces', () => {

		test('the turns before the latest message of the user', () => {
			const history = [...turn('first', 2), assistant('done'), ...turn('second', 1, 2)];
			assert.strictEqual(chooseKeepIdx(history, 0), 6);
		});

		test('nothing, if it is summarized already', () => {
			const history = [...turn('first', 2), assistant('done'), ...turn('second', 1, 2)];
			assert.strictEqual(chooseKeepIdx(history, 6), undefined, 'the current turn is too short to summarize');
		});

		test('in one long turn, its steps but the latest four, never between a call and its result', () => {
			const history = turn('Refactor the parser', 8);
			const keepFrom = chooseKeepIdx(history, 0);
			assert.strictEqual(keepFrom, 9);
			assert.strictEqual(history[keepFrom!].type, 'function_call');
			assert.strictEqual(history[keepFrom! - 1].type, 'function_call_output');
		});

		test('a turn is not summarized again at every step', () => {
			assert.strictEqual(chooseKeepIdx(turn('Refactor the parser', 7), 0), undefined, 'too few older steps');
			const first = chooseKeepIdx(turn('Refactor the parser', 14), 0)!;
			assert.strictEqual(chooseKeepIdx(turn('Refactor the parser', 14), first), undefined, 'the four steps that were kept are not enough');
			assert.strictEqual(chooseKeepIdx(turn('Refactor the parser', 18), first), first + 8, 'it takes four more to summarize, and four to keep');
			assert.strictEqual(chooseKeepIdx(turn('Refactor the parser', 10), 9), undefined);
		});

		test('nothing, without a message of the user', () => {
			assert.strictEqual(chooseKeepIdx([assistant('hi')], 0), undefined);
		});
	});

	test('the messages a model summarizes: what the user and the model said, and each call with its result', () => {
		const history = [user('Fix it'), { type: 'reasoning', summary: ['hmm'] } as IByokLmInputItem, assistant('Let me look.'), call('c1', '{"uri":"a.ts"}'), result('c1', 'const a = 1'), call('c2', 'not json'), result('c2', 'oops'), result('orphan', 'no call for this')];
		assert.deepStrictEqual(transcriptMessages(history, 0, history.length), [
			{ role: 'user', content: 'Fix it' },
			{ role: 'assistant', displayContent: 'Let me look.' },
			{ role: 'tool', name: 'read_file', rawParams: { uri: 'a.ts' }, content: 'const a = 1' },
			{ role: 'tool', name: 'read_file', rawParams: {}, content: 'oops' },
		]);
		assert.deepStrictEqual(transcriptMessages(history, 0, 1), [{ role: 'user', content: 'Fix it' }]);
	});
});
