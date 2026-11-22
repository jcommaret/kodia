/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Roadmap 10 / weak-model support: through the real agent loop, a small-context model is offered a tool set that fits
 * its window (with the real tokenizer), told what it lacks, and can still do file work; a large one gets everything.
 */

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { availableTools, builtinTools } from '../../common/prompt/prompts.js';
import { estimateTokens, whenTokenizerLoaded } from '../../common/tokenizer.js';
import { createHarness, RecordedRequest, runTurn, ScriptedLLMService, ScriptStep, toolMessages } from './agentHarness.js';

suite('Kodia - tool set sized to the model\'s context window (roadmap 10)', function () {
	this.timeout(60_000);
	let store: DisposableStore;
	let dir: string;
	setup(async () => { await whenTokenizerLoaded(); store = new DisposableStore(); dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-toolbudget-'))); });
	teardown(() => { store.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });

	const run = async (contextWindow: number) => {
		let first: RecordedRequest | undefined;
		const llm = new ScriptedLLMService((i, req): ScriptStep => {
			if (i === 0) { first = req; return { text: '', toolCalls: [{ name: 'write_file', params: { uri: path.join(dir, 'a.txt'), new_content: 'ok\n' } }] }; }
			return { text: 'done' };
		});
		const { chat } = createHarness(dir, llm, store, {
			modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' }, globalSettings: { verifyBeforeFinishing: false },
			overridesOfModel: { openAICompatible: { 'kodia-scripted-model': { contextWindow } } },
		});
		const { messages } = await runTurn(chat, 'write a.txt', 30_000);
		return { first: first!, tools: toolMessages(messages).map((t: any) => `${t.name}:${t.type}`) };
	};

	test('a 16k-token model gets a subset that fits half its window, is told what it lacks, and still works', async () => {
		const { first, tools } = await run(16_000);
		assert.ok(first.tools && first.tools.length < availableTools('agent', undefined)!.length, `a subset was offered: ${first.tools?.length}`);
		const offeredTokens = first.tools!.reduce((a, name) => a + estimateTokens(JSON.stringify({ name, description: (builtinTools as any)[name].description, params: (builtinTools as any)[name].params })), 0);
		assert.ok(offeredTokens <= 8_000, `the offered definitions fit: ${offeredTokens} tokens`);
		assert.match(first.separateSystemMessage ?? JSON.stringify(first.messages[0]), /only the tools listed here are available in this conversation; \d+ others are not/);
		assert.deepStrictEqual(tools, ['write_file:success']);
		assert.ok(fs.existsSync(path.join(dir, 'a.txt')));
	});

	test('a 128k-token model gets every tool, as before', async () => {
		const { first } = await run(128_000);
		assert.strictEqual(first.tools, undefined, 'no explicit subset: the chat mode\'s full set');
	});
});
