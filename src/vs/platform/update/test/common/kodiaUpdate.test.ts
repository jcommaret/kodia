/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IProductService } from '../../../product/common/productService.js';
import { createKodiaUpdateURL, getKodiaReleaseName, isNewerRelease, isNewerUpdate } from '../../common/kodiaUpdate.js';
import { IUpdate } from '../../common/update.js';

suite('Kodia update feed', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const feed = (name: string | undefined, version = 'def456'): IUpdate => ({
		url: 'https://github.com/jcommaret/kodia/releases/download/x/Kodia.zip',
		name,
		version,
		productVersion: '1.141.0.0',
	});

	test('builds the static manifest URL', () => {
		assert.strictEqual(
			createKodiaUpdateURL('https://raw.githubusercontent.com/jcommaret/kodia/refs/heads/master', 'win32-x64-user', 'stable'),
			'https://raw.githubusercontent.com/jcommaret/kodia/refs/heads/master/stable/win32-x64-user/latest.json'
		);
	});

	test('names this build like its release tag', () => {
		assert.strictEqual(getKodiaReleaseName({ version: '1.141.0', voidVersion: '2.5.5' } as IProductService), '1.141.0-2.5.5');
		assert.strictEqual(getKodiaReleaseName({ version: '1.141.0' } as IProductService), undefined);
	});

	test('compares release names numerically', () => {
		assert.strictEqual(isNewerRelease('1.141.0-2.5.10', '1.141.0-2.5.9'), true);
		assert.strictEqual(isNewerRelease('1.142.0-2.6.0', '1.141.0-2.5.9'), true);
		assert.strictEqual(isNewerRelease('1.141.0-2.5.5', '1.141.0-2.5.5'), false);
		assert.strictEqual(isNewerRelease('1.141.0-2.5.4', '1.141.0-2.5.5'), false);
		assert.strictEqual(isNewerRelease('1.141.0-2.5.4-insider', '1.141.0-2.5.5'), true, 'unparseable names only need to differ');
	});

	test('offers a newer release only', () => {
		const current: IUpdate = { version: 'abc123', name: '1.141.0-2.5.5' };
		assert.strictEqual(isNewerUpdate(feed('1.141.0-2.5.6'), current), true);
		assert.strictEqual(isNewerUpdate(feed('1.141.0-2.5.4'), current), false, 'no downgrade');
		assert.strictEqual(isNewerUpdate(feed('1.141.0-2.5.6', 'abc123'), current), false, 'same build');
		assert.strictEqual(isNewerUpdate(feed(undefined), current), true, 'another build without a name');
		assert.strictEqual(isNewerUpdate(feed('1.141.0-2.5.6'), { version: 'abc123' }), true, 'pending update without a name');
		assert.strictEqual(isNewerUpdate({ ...feed('1.141.0-2.5.6'), url: undefined }, current), false, 'incomplete feed');
		assert.strictEqual(isNewerUpdate(null, current), false);
	});
});
