/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../../../../platform/environment/electron-main/environmentMainService.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { DisablementReason, IUpdateService, State } from '../../../../../platform/update/common/update.js';
import { VoidCheckUpdateRespose } from '../../common/voidUpdateServiceTypes.js';
import { VoidMainUpdateService } from '../../electron-main/voidUpdateMainService.js';

// the button the notification offers (none when there is no message)
const actionOf = (res: VoidCheckUpdateRespose) => res?.message ? res.action : undefined;

suite('Kodia - update checks', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const realFetch = globalThis.fetch;
	let fetchCalls = 0;
	const latestRelease = (tag: string) => {
		globalThis.fetch = (async () => { fetchCalls += 1; return new Response(JSON.stringify({ tag_name: tag }), { status: 200 }); }) as typeof fetch;
	};
	setup(() => { fetchCalls = 0; });
	teardown(() => { globalThis.fetch = realFetch; });

	// a release build of 1.141.0-2.5.5: no update URL, so VS Code's updater is disabled
	const service = ({ updateMode = 'default', reason = DisablementReason.MissingConfiguration }: { updateMode?: string; reason?: DisablementReason } = {}) => {
		const product = { version: '1.141.0', voidVersion: '2.5.5' } as unknown as IProductService;
		const environment = { isBuilt: true } as IEnvironmentMainService;
		const update = { state: State.Disabled(reason), checkForUpdates: async () => { } } as unknown as IUpdateService;
		const configuration = { getValue: (key: string) => key === 'update.mode' ? updateMode : undefined } as unknown as IConfigurationService;
		return disposables.add(new VoidMainUpdateService(product, environment, update, configuration));
	};

	test('the automatic check announces a newer release, once', async () => {
		latestRelease('1.141.0-2.6.0');
		const s = service();
		assert.strictEqual(actionOf(await s.check(false)), 'reinstall');
		assert.strictEqual((await s.check(false))?.message, null, 'not again 3 hours later');
		assert.strictEqual(actionOf(await s.check(true)), 'reinstall', 'the command always answers');
	});

	test('the automatic check stays quiet when up to date', async () => {
		latestRelease('1.141.0-2.5.5');
		assert.strictEqual((await service().check(false))?.message, null);
		assert.strictEqual((await service().check(true))?.message, 'Kodia is up-to-date!');
	});

	test('no automatic check when the user turned update checks off', async () => {
		latestRelease('1.141.0-2.6.0');
		assert.strictEqual((await service({ updateMode: 'none' }).check(false))?.message, null);
		assert.strictEqual((await service({ updateMode: 'manual' }).check(false))?.message, null);
		assert.strictEqual((await service({ reason: DisablementReason.DisabledByEnvironment }).check(false))?.message, null);
		assert.strictEqual(fetchCalls, 0);
		assert.strictEqual(actionOf(await service({ updateMode: 'none' }).check(true)), 'reinstall', 'the command still checks');
	});
});
