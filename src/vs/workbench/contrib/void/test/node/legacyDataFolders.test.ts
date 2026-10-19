/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { copyLegacyDataFolders } from '../../../../../platform/environment/node/legacyDataFolders.js';

suite('Kodia - data folders named after Void', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let home: string;
	setup(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-home-')); });
	teardown(() => { fs.rmSync(home, { recursive: true, force: true }); });

	const write = (relativePath: string, content: string) => {
		fs.mkdirSync(path.dirname(path.join(home, relativePath)), { recursive: true });
		fs.writeFileSync(path.join(home, relativePath), content);
	};
	const read = (relativePath: string) => fs.readFileSync(path.join(home, relativePath), 'utf8');

	test('copies the old folder to the new name, and keeps the old one', () => {
		write('.void-editor/argv.json', '{ "locale": "fr" }');
		write('.void-editor/extensions/extensions.json', '[]');
		copyLegacyDataFolders(fs, home, [{ from: '.void-editor', to: '.kodia' }]);
		assert.strictEqual(read('.kodia/argv.json'), '{ "locale": "fr" }');
		assert.strictEqual(read('.kodia/extensions/extensions.json'), '[]');
		assert.ok(fs.existsSync(path.join(home, '.void-editor/argv.json')));
		assert.ok(!fs.existsSync(path.join(home, '.kodia.copying')));
	});

	test('never touches a new folder that already exists', () => {
		write('.void-editor/argv.json', 'old');
		write('.kodia/argv.json', 'new');
		copyLegacyDataFolders(fs, home, [{ from: '.void-editor', to: '.kodia' }]);
		assert.strictEqual(read('.kodia/argv.json'), 'new');
	});

	test('redoes a copy that was cut short', () => {
		write('.void-editor/argv.json', 'old');
		write('.kodia.copying/half', 'x');
		copyLegacyDataFolders(fs, home, [{ from: '.void-editor', to: '.kodia' }]);
		assert.strictEqual(read('.kodia/argv.json'), 'old');
		assert.ok(!fs.existsSync(path.join(home, '.kodia/half')));
	});

	test('does nothing without an old folder, or when the names are the same', () => {
		copyLegacyDataFolders(fs, home, [{ from: '.void-editor', to: '.kodia' }, { from: '.kodia', to: '.kodia' }]);
		assert.deepStrictEqual(fs.readdirSync(home), []);
	});
});
