/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { contextLimitFromError, isContextOverflowError } from '../../common/contextOverflow.js';

suite('Kodia - context overflow errors', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const cases: { name: string; message: string; limit: number | undefined }[] = [
		{ name: 'OpenAI', message: `400 This model's maximum context length is 8192 tokens. However, your messages resulted in 9500 tokens. Please reduce the length of the messages.`, limit: 8192 },
		{ name: 'OpenAI code', message: `400 {"error":{"code":"context_length_exceeded","message":"Input too long"}}`, limit: undefined },
		{ name: 'vLLM', message: `This model's maximum context length is 32,768 tokens. However, you requested 40000 tokens (36000 in the messages, 4000 in the completion).`, limit: 32768 },
		{ name: 'llama.cpp', message: `the request exceeds the available context size, try increasing it (n_ctx: 4096) exceed_context_size_error`, limit: 4096 },
		{ name: 'Anthropic', message: `prompt is too long: 210000 tokens > 200000 maximum`, limit: undefined },
		{ name: 'Gemini', message: `The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).`, limit: undefined },
		{ name: 'generic', message: `Request exceeds the model's maximum context window`, limit: undefined },
	];
	for (const c of cases) {
		test(`recognizes ${c.name}`, () => {
			assert.strictEqual(isContextOverflowError(c.message), true);
			assert.strictEqual(contextLimitFromError(c.message), c.limit);
		});
	}

	for (const message of ['401 Incorrect API key provided', '429 Rate limit reached for requests', '500 Internal server error', 'fetch failed', '', undefined]) {
		test(`ignores unrelated error ${JSON.stringify(message)}`, () => {
			assert.strictEqual(isContextOverflowError(message), false);
		});
	}
});
