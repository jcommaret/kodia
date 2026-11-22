/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * run_command on Windows: the command Kodia builds (wrapCommandForShell) runs in a real PowerShell, as in the
 * integrated terminal. The old `cmd /c "..."` with \" escapes broke every command containing a double quote.
 */

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isWindows } from '../../../../../base/common/platform.js';
import { wrapCommandForShell } from '../../common/terminalUtils.js';
import { ProcessTerminalToolService } from './agentHarness.js';

suite('Kodia - run_command quoting in a real Windows PowerShell', function () {
	this.timeout(60_000);
	let dir: string;
	setup(function () {
		if (!isWindows) { this.skip(); } // the wrapping only applies on Windows
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-wrap-')));
	});
	teardown(() => { if (dir) { fs.rmSync(dir, { recursive: true, force: true }); } });

	const run = async (command: string) => {
		const { resPromise } = await new ProcessTerminalToolService(dir).runCommand(wrapCommandForShell(command), {});
		const r = await resPromise;
		return { out: r.result.trim(), exit: r.resolveReason.type === 'done' ? r.resolveReason.exitCode : null };
	};

	test('double and single quotes, exit codes, pipes, &&, and PowerShell-special characters reach cmd unchanged', async () => {
		assert.deepStrictEqual(await run(`node -e "console.log('a b', 1+1)"`), { out: 'a b 2', exit: 0 });
		assert.deepStrictEqual(await run(`node -e "setTimeout(() => console.log(42), 10)"`), { out: '42', exit: 0 }, 'was a PowerShell parse error');
		assert.deepStrictEqual(await run(`node -e "process.exit(3)"`), { out: '', exit: 3 }, 'the real exit code (was 1)');
		assert.deepStrictEqual(await run('echo "two words"'), { out: '"two words"', exit: 0 }, 'no stray backslashes');
		assert.deepStrictEqual(await run('echo $HOME `tick`'), { out: '$HOME `tick`', exit: 0 }, 'PowerShell expands nothing');
		assert.deepStrictEqual(await run('echo hello world| findstr world'), { out: 'hello world', exit: 0 });
		assert.deepStrictEqual((await run('node --version && echo ok')).out.split(/\r?\n/).pop(), 'ok');
	});
});
