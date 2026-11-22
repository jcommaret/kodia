/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Regression for a real incident: in Agent mode a Kodia agent emptied a user's project folder (8917 files) with
 * `Remove-Item -Recurse -Force` without asking. PowerShell's Remove-Item was unknown to the destructive-command check,
 * only rm/del/rd with BOTH recursive and force counted, and only the first word of a command line was looked at.
 */

import assert from 'assert';
import { assessRisk, evaluateAutonomy } from '../../common/autonomyPolicy.js';
import { isDestructiveCommand } from '../../common/terminalSafety.js';

suite('Kodia - destructive terminal commands need approval', () => {

	test('PowerShell deletes: Remove-Item and its aliases, recursive (with or without -Force), whole folders, piped', () => {
		for (const c of [
			'Remove-Item -Recurse -Force c:\\wamp64\\www\\wondercommerce\\*',
			'Remove-Item -Path "C:\\proj" -Recurse',
			'Remove-Item C:\\proj -Force -Recurse',
			'remove-item -rec -fo .\\app',
			'ri -r C:\\proj',
			'rm -Recurse -Force C:\\proj',
			'Remove-Item .\\*',
			'Remove-Item * -Force',
			'Get-ChildItem C:\\proj -Recurse | Remove-Item -Force',
			'gci | ri',
		]) { assert.strictEqual(isDestructiveCommand(c), true, c); }
	});

	test('chained and wrapped commands are all checked, not just the first word', () => {
		for (const c of [
			'cd C:\\proj; Remove-Item -Recurse -Force .',
			'cd /srv/app && rm -rf .',
			'npm test || rm -r dist',
			'cmd /c "rd /s /q C:\\proj"',
			'cmd /c \'rmdir /s C:\\proj\'',
			'powershell -NoProfile -Command "Remove-Item -Recurse C:\\proj"',
			'sudo rm -r /var/www',
			'echo ok\nrm -r build',
		]) { assert.strictEqual(isDestructiveCommand(c), true, c); }
	});

	test('POSIX and cmd recursive deletes without force, git history/working-tree destruction, deletes from inside other programs', () => {
		for (const c of [
			'rm -r src', 'rm -R src', 'rm --recursive src', 'rmdir /s C:\\proj', 'del /s *.log', 'del /q *.*', '/bin/rm -rf /tmp/x',
			'git clean -fdx', 'git clean -f', 'git reset --hard HEAD~3', 'git push --force origin main', 'git push origin +main',
			'node -e "require(\'fs\').rmSync(\'src\', { recursive: true, force: true })"',
			'python -c "import shutil; shutil.rmtree(\'src\')"',
			'npx rimraf node_modules',
			'[System.IO.Directory]::Delete("C:\\proj", $true)',
			'diskpart',
		]) { assert.strictEqual(isDestructiveCommand(c), true, c); }
	});

	test('everyday commands are not flagged', () => {
		for (const c of [
			'npm install', 'npm run format', 'git log --format=%H -3', 'git status', 'git push origin main', 'git clean -n',
			'rm file.txt', 'del notes.txt', 'Remove-Item .\\out\\report.txt', 'Remove-Item -Force .\\lock.tmp', 'rm -i a.txt',
			'echo "rm -rf /"', 'Get-ChildItem -Recurse', 'node --test', 'ls -R', 'grep -r foo src', 'cp -r a b', 'node build.js 2>&1',
		]) { assert.strictEqual(isDestructiveCommand(c), false, c); }
	});

	test('the policy: such a command needs the user\'s approval in every mode, even with terminal auto-approve or an explicit allow', () => {
		const command = 'Remove-Item -Recurse -Force c:\\wamp64\\www\\wondercommerce\\*';
		assert.strictEqual(assessRisk('run_command', { command }), 'critical');
		for (const mode of ['assist', 'agent', 'autonomous'] as const) {
			for (const [autoApprove, operationPolicy] of [[{}, {}], [{ terminal: true }, {}], [{}, { run_command: 'allow' }]] as const) {
				const e = evaluateAutonomy({ mode, autoApprove: { ...autoApprove }, operationPolicy: { ...operationPolicy }, toolName: 'run_command', params: { command }, isOutsideWorkspace: false });
				assert.strictEqual(e.decision, 'requireApproval', `${mode} ${JSON.stringify(autoApprove)} ${JSON.stringify(operationPolicy)}`);
			}
		}
		assert.strictEqual(evaluateAutonomy({ mode: 'agent', autoApprove: {}, operationPolicy: {}, toolName: 'run_command', params: { command: 'npm test' }, isOutsideWorkspace: false }).decision, 'allow');
	});
});
