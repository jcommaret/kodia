/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { looksLikeUnfulfilledAction } from '../../common/unfulfilledActionDetection.js';

suite('Kodia - unfulfilled action detection', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const narrated = [
		'I will create the directory structure and the files now.',
		"I'll now write src/server.ts with an Express app.",
		'Let me create the project folders.',
		'Great plan. Next, I will install the dependencies with npm.',
		"I'm going to set up the database schema.",
		'Now I will go ahead and implement the login route.',
		"Here is the plan:\n1. models\n2. routes\n\nLet's start by creating the models.",
	];
	for (const text of narrated) {
		test(`flags narration: ${JSON.stringify(text.slice(0, 50))}`, () => {
			assert.strictEqual(looksLikeUnfulfilledAction(text), true);
		});
	}

	const fine = [
		'',
		'Done. I created src/server.ts and package.json, and all 4 tests pass.',
		'The bug is in parseDate: it ignores the timezone offset.',
		'Would you like me to create the migration as well?',
		'I can create the files. Should I use TypeScript or JavaScript?',
		'I will create the tables once you confirm the schema. Let me know which fields you need.',
		'Do you want me to delete the old folder?',
		// early intent followed by a long factual summary: the tail is what matters
		'I will create the files.\n' + 'Summary of what exists now: package.json, src/index.ts, README.md. '.repeat(12),
	];
	for (const text of fine) {
		test(`does not flag: ${JSON.stringify(text.slice(0, 50))}`, () => {
			assert.strictEqual(looksLikeUnfulfilledAction(text), false);
		});
	}
});
