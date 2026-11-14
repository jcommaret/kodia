/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { extractXMLToolsWrapper } from '../../electron-main/llmMessage/extractGrammar.js';
import { OnFinalMessage, OnText } from '../../common/sendLLMMessageTypes.js';
import { InternalToolInfo } from '../../common/prompt/prompts.js';

const tools: InternalToolInfo[] = [
	{ name: 'read_file', description: 'Reads a file.', params: { uri: { description: 'The file.' } } },
	{ name: 'run_subagent', description: 'Hands a task over.', params: { task: { description: 'The task.' } } },
];

suite('Kodia - the JSON tool call through the XML wrapper', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// the wrapper as the Agents window's model requests use it: no native tools, the tools given explicitly
	function finish(text: string) {
		let final: Parameters<OnFinalMessage>[0] | undefined;
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(() => { }, p => { final = p; }, 'agent', undefined, tools);
		const streamed: Parameters<OnText>[0] = { fullText: text, fullReasoning: '' };
		newOnText(streamed);
		newOnFinalMessage({ fullText: text, fullReasoning: '', anthropicReasoning: null });
		return final!;
	}

	test('a call written as JSON becomes the call of the reply, and its text is kept without it', () => {
		const final = finish('I will read the file.\n```json\n{"name": "read_file", "arguments": {"uri": "src/a.ts"}}\n```');
		assert.strictEqual(final.fullText, 'I will read the file.');
		assert.strictEqual(final.toolCalls?.length, 1);
		assert.strictEqual(final.toolCalls![0].name, 'read_file');
		assert.strictEqual(final.toolCalls![0].rawParams.uri, 'src/a.ts');
	});

	test('an XML call is still read as before, and a plain reply has no call', () => {
		const xml = finish('<read_file>\n<uri>src/b.ts</uri>\n</read_file>');
		assert.strictEqual(xml.toolCalls?.[0].rawParams.uri, 'src/b.ts');
		const plain = finish('Just an answer.');
		assert.strictEqual(plain.toolCalls, undefined);
		assert.strictEqual(plain.fullText, 'Just an answer.');
	});
});
