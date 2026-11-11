/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { editorToolParams, IKodiaEditorTools, KodiaEditorToolsService } from '../../common/kodiaEditorToolsService.js';

suite('Kodia - which window runs the editor tools for the Agents window\'s agent', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const tools = (name: string): IKodiaEditorTools => ({ call: async () => ({ isError: false, output: name }) });

	test('the Agents Window has none, an editor window\'s tools service provides them', async () => {
		const service = new KodiaEditorToolsService();
		const current = () => service.tools;
		assert.strictEqual(current(), undefined);

		const editor = tools('editor');
		const provided = service.provide(editor);
		assert.strictEqual(current(), editor);
		assert.deepStrictEqual(await current()!.call('read_lint_errors', { uri: '/a.ts' }), { isError: false, output: 'editor' });

		provided.dispose();
		assert.strictEqual(current(), undefined);
	});

	test('a tools service that is replaced does not withdraw its successor\'s tools', () => {
		const service = new KodiaEditorToolsService();
		const current = () => service.tools;
		const first = service.provide(tools('first'));
		const second = tools('second');
		const secondProvided = service.provide(second);

		first.dispose();
		assert.strictEqual(current(), second);
		secondProvided.dispose();
		assert.strictEqual(current(), undefined);
	});

	test('reads the arguments a model sends as the chat\'s tools take them: strings, the numbers and flags written out', () => {
		assert.deepStrictEqual(editorToolParams('{"uri":"/a.ts","line":12,"symbol":"a"}'), { uri: '/a.ts', line: '12', symbol: 'a' });
		assert.deepStrictEqual(editorToolParams('{"line":"7","flag":true}'), { line: '7', flag: 'true' });
		assert.deepStrictEqual(editorToolParams(''), {}, 'a call without arguments');
		assert.deepStrictEqual(editorToolParams('{"query":"x","nested":{"a":1},"list":[1],"none":null}'), { query: 'x' }, 'what is not a string, a number or a flag is not an argument');
	});

	test('arguments that are not a JSON object are none', () => {
		for (const notArguments of ['not json', '[1]', 'null', '"a.ts"', '12']) {
			assert.strictEqual(editorToolParams(notArguments), undefined, notArguments);
		}
	});
});
