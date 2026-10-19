/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatMessage } from '../../common/chatThreadServiceTypes.js';
import { chooseSummaryKeepIdx, transcriptForSummary } from '../../common/helpers/threadSummary.js';
import { summarizedThreadMessage } from '../../common/prompt/prompts.js';

const user = (content: string): ChatMessage => ({ role: 'user', content, displayContent: content, selections: null, state: { stagingSelections: [], isBeingEdited: false } });
const assistant = (displayContent: string): ChatMessage => ({ role: 'assistant', displayContent, reasoning: '', anthropicReasoning: null });
const tool = (content: string): ChatMessage => ({ role: 'tool', type: 'invalid_params', result: null, name: 'read_file', content, id: 'id', rawParams: { uri: '/a.ts' }, mcpServerName: undefined });

// an agent turn of n steps: each an assistant message and its tool result
const steps = (n: number) => Array.from({ length: n }, (_, i) => [assistant(`step ${i}`), tool(`result ${i}`)]).flat();

suite('Kodia - summarizing a long thread', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('summarizes the turns before the latest user message', () => {
		const messages = [user('first'), assistant('a'), user('second'), assistant('b'), user('third')];
		assert.strictEqual(chooseSummaryKeepIdx(messages, 0), 4);
	});

	test('a later summary only covers what the previous one did not', () => {
		const messages = [user('first'), assistant('a'), user('second'), assistant('b'), user('third')];
		assert.strictEqual(chooseSummaryKeepIdx(messages, 4), null, 'nothing new since the previous summary');
		assert.strictEqual(chooseSummaryKeepIdx([...messages, assistant('c'), user('fourth')], 4), 6);
	});

	test('in one long agent turn, keeps the latest steps', () => {
		const messages = [user('do it'), ...steps(10)];
		const keepFromIdx = chooseSummaryKeepIdx(messages, 0)!;
		assert.deepStrictEqual(messages[keepFromIdx], assistant('step 6'));
		assert.strictEqual(messages.slice(keepFromIdx).filter(m => m.role === 'assistant').length, 4);
	});

	test('does not summarize a turn again at every step', () => {
		const messages = [user('do it'), ...steps(10)];
		const keepFromIdx = chooseSummaryKeepIdx(messages, 0)!;
		assert.strictEqual(chooseSummaryKeepIdx([...messages, ...steps(1)], keepFromIdx), null);
		assert.notStrictEqual(chooseSummaryKeepIdx([...messages, ...steps(4)], keepFromIdx), null);
	});

	test('a short turn is left alone', () => {
		assert.strictEqual(chooseSummaryKeepIdx([user('do it'), ...steps(5)], 0), null);
		assert.strictEqual(chooseSummaryKeepIdx([], 0), null);
	});

	test('the transcript has the previous summary, the messages and capped tool results', () => {
		const transcript = transcriptForSummary([user('fix the bug'), assistant('Looking.'), tool('x'.repeat(2000))], { previousSummary: 'Earlier: set up the repo.', maxChars: 100_000 });
		assert.ok(transcript.startsWith('SUMMARY OF THE CONVERSATION BEFORE THIS:\nEarlier: set up the repo.'));
		assert.ok(transcript.includes('USER:\nfix the bug'));
		assert.ok(transcript.includes('ASSISTANT:\nLooking.'));
		assert.ok(transcript.includes('TOOL CALL read_file({"uri":"/a.ts"}):'));
		assert.ok(transcript.includes('(500 more characters)'));
	});

	test('a transcript that is too long loses its middle', () => {
		const transcript = transcriptForSummary([user('START ' + 'a'.repeat(5000)), user('b'.repeat(5000) + ' END')], { previousSummary: undefined, maxChars: 1000 });
		assert.ok(transcript.length < 1100);
		assert.ok(transcript.includes('USER:\nSTART'));
		assert.ok(transcript.endsWith(' END'));
		assert.ok(transcript.includes('[... part of the conversation left out ...]'));
	});

	test('the summary message carries the current request when the summary cut the turn', () => {
		assert.ok(!summarizedThreadMessage('S', undefined).includes('CURRENT REQUEST'));
		assert.ok(summarizedThreadMessage('S', 'do it').endsWith('CURRENT REQUEST, which you are working on:\ndo it'));
	});
});
