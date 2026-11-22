/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Roadmap 7 through the real agent loop: the agent locates a bug it was only described in words with
 * code_semantic_search, fixes it, and its next search already reflects the edit. The index service is the real one
 * (node/codeIndexService.ts, the class the main process hosts), reached over the code-index channel with IPC-style
 * serialization (ProxyChannel), over the workspace folder of the harness.
 */

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { KodiaCodeIndexService } from '../../node/codeIndexService.js';
import { DIVIDER, FINAL, ORIGINAL } from '../../common/prompt/prompts.js';
import { createHarness, ProcessTerminalToolService, RecordedRequest, runTurn, ScriptedLLMService, ScriptStep, toolMessages } from './agentHarness.js';

const FILES: Record<string, string> = {
	'package.json': '{ "name": "shop" }\n',
	'src/auth/login.js': 'const { findUserByEmail } = require(\'../db/users\');\n\nasync function login(email, password) {\n\tconst user = await findUserByEmail(email);\n\treturn !!user && user.password === password;\n}\n\nmodule.exports = { login };\n',
	'src/db/users.js': 'const users = [{ email: \'ada@example.com\', password: \'pw\' }];\n\nasync function findUserByEmail(email) {\n\treturn users.find(u => u.email === email);\n}\n\nmodule.exports = { findUserByEmail, users };\n',
	'src/ui/header.js': 'function renderHeader(title) {\n\treturn `<header>${title}</header>`;\n}\nmodule.exports = { renderHeader };\n',
	'src/cart/cart.js': 'function addToCart(cart, item) {\n\tcart.items.push(item);\n\treturn cart;\n}\nmodule.exports = { addToCart };\n',
	'test/login.test.js': 'const test = require(\'node:test\');\nconst assert = require(\'node:assert\');\nconst { login } = require(\'../src/auth/login\');\ntest(\'email is case-insensitive\', async () => assert.strictEqual(await login(\'Ada@Example.com\', \'pw\'), true));\n',
};

suite('Kodia - code search through the agent loop (roadmap 7)', function () {
	this.timeout(120_000);

	let store: DisposableStore;
	let dir: string;
	const p = (rel: string) => path.join(dir, rel);

	setup(() => {
		store = new DisposableStore();
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-code-search-')));
		for (const [rel, content] of Object.entries(FILES)) { fs.mkdirSync(path.dirname(p(rel)), { recursive: true }); fs.writeFileSync(p(rel), content); }
	});
	teardown(() => {
		store.dispose();
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	});

	test('find the code from a description, fix it, and the next search already sees the fix', async () => {
		const last = (req: RecordedRequest) => JSON.stringify(req.messages[req.messages.length - 1]);
		const llm = new ScriptedLLMService((i, req): ScriptStep => {
			switch (i) {
				case 0: return { text: '', toolCalls: [{ name: 'code_semantic_search', params: { query: 'look up the user account for a login email', limit: '5' } }] };
				case 1: {
					const out = last(req);
					assert.match(out, /Ranked code search for .* over 6 files .*The workspace was indexed for this search: 6 files/, 'the workspace folder was indexed on first use');
					// the two functions on the path from "login" to "email lookup" lead, definitions before import lines
					assert.match(out, /1\. src[\\/]+auth[\\/]+login\.js:3-6 \[function\] login .*2\. src[\\/]+db[\\/]+users\.js:3-5 \[function\] findUserByEmail/, `ranking:\n${out}`);
					assert.match(out, /4: return users\.find\(u => u\.email === email\);/, 'with the line that matters');
					assert.doesNotMatch(out, /renderHeader|addToCart/, 'unrelated code is not listed');
					return { text: '', toolCalls: [{ name: 'edit_file', params: { uri: p('src/db/users.js'), search_replace_blocks: `${ORIGINAL}\n\treturn users.find(u => u.email === email);\n${DIVIDER}\n\treturn users.find(u => u.email.toLowerCase() === email.toLowerCase());\n${FINAL}` } }] };
				}
				case 2: return { text: '', toolCalls: [{ name: 'code_keyword_search', params: { query: '.email === ' } }] };
				case 3:
					assert.match(last(req), /Updated first: 1 changed file/, 'the search re-read the file the agent just edited');
					assert.match(last(req), /No occurrences/, 'no case-sensitive email comparison is left');
					return { text: '', toolCalls: [{ name: 'run_command', params: { command: 'node --test --test-reporter=tap' } }] };
				case 4:
					assert.match(last(req), /# pass 1/);
					assert.match(last(req), /# fail 0/);
					return { text: 'findUserByEmail compared emails case-sensitively; it now compares them lowercased. The test passes.' };
				default: throw new Error(`unexpected request ${i}`);
			}
		});
		const { chat } = createHarness(dir, llm, store, {
			modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' },
			mainProcessServices: { 'void-channel-code-index': new KodiaCodeIndexService() },
			terminal: new ProcessTerminalToolService(dir, 60_000),
			globalSettings: { verifyBeforeFinishing: false },
		});

		const { messages } = await runTurn(chat, 'Users whose email has capital letters cannot log in. Fix it.', 100_000);
		assert.deepStrictEqual(llm.scriptErrors, []);
		assert.deepStrictEqual(toolMessages(messages).map((t: any) => `${t.name}:${t.type}`), ['code_semantic_search:success', 'edit_file:success', 'code_keyword_search:success', 'run_command:success']);
		assert.match(fs.readFileSync(p('src/db/users.js'), 'utf8'), /u\.email\.toLowerCase\(\) === email\.toLowerCase\(\)/);
	});
});
