/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isPermanentModelError, MODEL_REQUEST_ATTEMPTS, shouldRetryModelRequest } from '../../../../../platform/kodia/common/modelRequestRetry.js';

suite('Kodia - a model request that failed', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('is sent again until it was sent three times', () => {
		assert.strictEqual(MODEL_REQUEST_ATTEMPTS, 3);
		assert.strictEqual(shouldRetryModelRequest({ attempt: 1, error: 'fetch failed' }), true);
		assert.strictEqual(shouldRetryModelRequest({ attempt: 2, error: undefined }), true);
		assert.strictEqual(shouldRetryModelRequest({ attempt: 3, error: 'fetch failed' }), false);
	});

	test('is not sent again when part of the reply is on screen', () => {
		assert.strictEqual(shouldRetryModelRequest({ attempt: 1, error: 'socket hang up', shownReply: true }), false);
	});

	test('is not sent again for a key the provider refuses', () => {
		for (const error of ['401 Incorrect API key provided: sk-...', 'Invalid API key', 'invalid_api_key', 'API key not valid. Please pass a valid API key.', 'Unauthorized', 'authentication_error: invalid x-api-key', 'Error: 403 Forbidden', 'PERMISSION_DENIED']) {
			assert.strictEqual(isPermanentModelError(error), true, error);
			assert.strictEqual(shouldRetryModelRequest({ attempt: 1, error }), false, error);
		}
	});

	test('is sent again for what may pass: a server still loading, a dropped connection, a rate limit', () => {
		for (const error of ['fetch failed: ECONNREFUSED', '503 Service Unavailable', '429 Too Many Requests', 'Model is loading', 'terminated', 'context length 4010 exceeds 4030 tokens', undefined]) {
			assert.strictEqual(isPermanentModelError(error), false, String(error));
		}
	});
});
