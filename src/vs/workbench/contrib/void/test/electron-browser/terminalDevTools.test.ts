/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * dep_install / db_migrate / lint_run with real processes: the reported success and exit code must be the command's
 * real outcome. (They used to report success: true, exit_code: 0 no matter what happened; lint_run decided by
 * counting the word "error" in the output.)
 */

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { createHarness, ProcessTerminalToolService, ScriptedLLMService } from './agentHarness.js';

suite('Kodia - terminal dev tools report the real outcome', function () {
	this.timeout(60_000);

	let store: DisposableStore;
	let tmpDir: string;
	let tools: any;
	setup(() => {
		store = new DisposableStore();
		tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-devtools-')));
		// scripts instead of inline code: no shell-quoting differences between platforms
		fs.writeFileSync(path.join(tmpDir, 'fail3.js'), `console.log('npm ERR! code ELIFECYCLE'); process.exit(3);\n`);
		fs.writeFileSync(path.join(tmpDir, 'ok.js'), `console.log('added 12 packages, found 0 errors');\n`);
		fs.writeFileSync(path.join(tmpDir, 'lintfail.js'), `console.log('src/a.ts:1:1  problem  no-unused-vars'); process.exit(1);\n`);
		const terminal = new ProcessTerminalToolService(tmpDir, 30_000);
		tools = createHarness(tmpDir, new ScriptedLLMService(() => ({ text: '' })), store, { modelSelection: { providerName: 'openAICompatible', modelName: 'x' }, terminal }).tools;
	});
	teardown(() => { store.dispose(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

	const call = async (tool: string, command: string) => {
		const params = tools.validateParams[tool]({ command, cwd: tmpDir });
		return (await tools.callTool[tool](params)).result;
	};

	test('dep_install: a failing install is reported as a failure with its exit code', async () => {
		const r = await call('dep_install', 'node fail3.js');
		assert.strictEqual(r.success, false);
		assert.strictEqual(r.exit_code, 3);
		assert.match(r.output, /npm ERR!/);
	});

	test('dep_install: a successful install is a success', async () => {
		const r = await call('dep_install', 'node ok.js');
		assert.strictEqual(r.success, true);
		assert.strictEqual(r.exit_code, 0);
	});

	test('db_migrate: a failing migration is reported as a failure', async () => {
		const r = await call('db_migrate', 'node fail3.js');
		assert.strictEqual(r.success, false);
		assert.strictEqual(r.exit_code, 3);
	});

	test('lint_run: success follows the exit code, not the word "error"', async () => {
		const clean = await call('lint_run', 'node ok.js'); // prints "0 errors", exits 0
		assert.strictEqual(clean.success, true);
		assert.strictEqual(clean.errors_found, 0, '"0 errors" is not an error');
		const dirty = await call('lint_run', 'node lintfail.js'); // a lint problem without the word "error", exits 1
		assert.strictEqual(dirty.success, false);
		assert.strictEqual(dirty.exit_code, 1);
	});
});
