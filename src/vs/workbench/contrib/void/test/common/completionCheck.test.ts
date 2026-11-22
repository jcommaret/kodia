/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { shouldRequestCompletionCheck, turnChangedFiles } from '../../common/completionCheck.js';

suite('Kodia - completion check decision', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const wrote = { role: 'tool', type: 'success', name: 'write_file' };
	const read = { role: 'tool', type: 'success', name: 'read_file' };
	const failedEdit = { role: 'tool', type: 'tool_error', name: 'edit_file' };
	const invalidWrite = { role: 'tool', type: 'invalid_params', name: 'write_file' };
	const assistant = { role: 'assistant' };

	test('a successful file change counts; reads, failures and invalid calls do not', () => {
		assert.strictEqual(turnChangedFiles([assistant, wrote]), true);
		for (const name of ['create_file_or_folder', 'rewrite_file', 'edit_file', 'delete_file_or_folder']) {
			assert.strictEqual(turnChangedFiles([{ role: 'tool', type: 'success', name }]), true, name);
		}
		assert.strictEqual(turnChangedFiles([assistant, read]), false);
		assert.strictEqual(turnChangedFiles([failedEdit, invalidWrite]), false);
		assert.strictEqual(turnChangedFiles([]), false);
	});

	test('only in agent mode, only once per turn, only after a change', () => {
		assert.strictEqual(shouldRequestCompletionCheck({ chatMode: 'agent', alreadyRequested: false, messagesThisTurn: [wrote] }), true);
		assert.strictEqual(shouldRequestCompletionCheck({ chatMode: 'agent', alreadyRequested: true, messagesThisTurn: [wrote] }), false);
		assert.strictEqual(shouldRequestCompletionCheck({ chatMode: 'gather', alreadyRequested: false, messagesThisTurn: [wrote] }), false);
		assert.strictEqual(shouldRequestCompletionCheck({ chatMode: 'normal', alreadyRequested: false, messagesThisTurn: [wrote] }), false);
		assert.strictEqual(shouldRequestCompletionCheck({ chatMode: 'agent', alreadyRequested: false, messagesThisTurn: [read, failedEdit] }), false);
	});
});
