/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { extractReasoningWrapper, extractXMLToolsWrapper } from '../../electron-main/llmMessage/extractGrammar.js';
import { OnFinalMessage, OnText } from '../../common/sendLLMMessageTypes.js';

type Streamed = Parameters<OnText>[0];
type Final = Parameters<OnFinalMessage>[0];

// streams `text` one character at a time through a wrapper, like a provider would
const stream = (wrap: (onText: OnText, onFinalMessage: OnFinalMessage) => { newOnText: OnText; newOnFinalMessage: OnFinalMessage }, text: string) => {
	const streamed: Streamed[] = [];
	let final: Final | undefined;
	const { newOnText, newOnFinalMessage } = wrap(p => streamed.push(p), p => { final = p; });
	for (let len = 1; len <= text.length; len++) {
		newOnText({ fullText: text.slice(0, len), fullReasoning: '' });
	}
	newOnFinalMessage({ fullText: text, fullReasoning: '', anthropicReasoning: null });
	return { streamed, final: final! };
};

suite('Kodia - XML tool calls', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const reply = 'Let me read it.\n<read_file>\n<uri>/src/a.ts</uri>\n<start_line>10</start_line>\n</read_file>';

	test('parses a tool call and keeps the text before it', () => {
		const { final } = stream((t, f) => extractXMLToolsWrapper(t, f, 'agent', undefined), reply);
		assert.strictEqual(final.fullText, 'Let me read it.');
		assert.strictEqual(final.toolCalls?.length, 1);
		const [call] = final.toolCalls!;
		assert.strictEqual(call.name, 'read_file');
		assert.deepStrictEqual(call.rawParams, { uri: '/src/a.ts', start_line: '10' });
		assert.deepStrictEqual(call.doneParams, ['uri', 'start_line']);
		assert.strictEqual(call.isDone, true);
	});

	test('never shows the tool XML while it streams', () => {
		const { streamed } = stream((t, f) => extractXMLToolsWrapper(t, f, 'agent', undefined), reply);
		for (const p of streamed) {
			assert.ok(!p.fullText.includes('<'), `tool XML leaked into the text: ${JSON.stringify(p.fullText)}`);
		}
	});

	test('reports a half-written tool call as not done', () => {
		const partial = reply.slice(0, reply.indexOf('</uri>'));
		const { streamed } = stream((t, f) => extractXMLToolsWrapper(t, f, 'agent', undefined), partial);
		const call = streamed[streamed.length - 1].toolCall;
		assert.strictEqual(call?.isDone, false);
		assert.deepStrictEqual(call?.rawParams, { uri: '/src/a.ts' });
		assert.deepStrictEqual(call?.doneParams, []);
	});

	test('leaves a reply without tools alone', () => {
		const { final } = stream((t, f) => extractXMLToolsWrapper(t, f, 'agent', undefined), 'a < b, so no tool here');
		assert.strictEqual(final.fullText, 'a < b, so no tool here');
		assert.strictEqual(final.toolCalls, undefined);
	});

	test('does not parse tools in normal mode', () => {
		const { final } = stream((t, f) => extractXMLToolsWrapper(t, f, 'normal', undefined), reply);
		assert.strictEqual(final.fullText, reply);
		assert.strictEqual(final.toolCalls, undefined);
	});
});

suite('Kodia - <think> reasoning', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const thinkTags: [string, string] = ['<think>', '</think>'];

	test('separates the reasoning from the answer', () => {
		const { final } = stream((t, f) => extractReasoningWrapper(t, f, thinkTags), '<think>The user wants a sum.</think>It is 4.');
		assert.strictEqual(final.fullText, 'It is 4.');
		assert.strictEqual(final.fullReasoning, 'The user wants a sum.');
	});

	test('never shows the think tags while it streams', () => {
		const { streamed } = stream((t, f) => extractReasoningWrapper(t, f, thinkTags), '<think>hmm</think>Answer');
		for (const p of streamed) {
			assert.ok(!p.fullText.includes('<') && !p.fullReasoning.includes('<'), `a think tag leaked: ${JSON.stringify(p)}`);
		}
		assert.strictEqual(streamed[streamed.length - 1].fullReasoning, 'hmm');
	});

	test('a reply without reasoning is all answer', () => {
		const { final } = stream((t, f) => extractReasoningWrapper(t, f, thinkTags), 'Just the answer.');
		assert.strictEqual(final.fullText, 'Just the answer.');
		assert.strictEqual(final.fullReasoning, '');
	});
});
