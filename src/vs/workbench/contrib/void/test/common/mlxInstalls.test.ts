/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { compareVersions, mlxErrorWithHint, newestMlxInstall, pythonOfScript, versionFromOutput, wellKnownPythons } from '../../common/mlxInstalls.js';

suite('Kodia - the mlx-lm installs of a Mac', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('compares versions by their numbers, not as text', () => {
		assert.ok(compareVersions('0.31.3', '0.29.1') > 0);
		assert.ok(compareVersions('0.9.0', '0.10.0') < 0);
		assert.ok(compareVersions('0.30', '0.30.0') === 0);
		assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
		assert.ok(compareVersions('0.30.0rc1', '0.29.9') > 0, 'a release candidate is read by its numbers');
	});

	test('picks the newest install, and the first of them when two are the same', () => {
		const xcode = { python: '/usr/bin/python3', version: '0.29.1' };
		const framework = { python: '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3', version: '0.31.3' };
		const brew = { python: '/opt/homebrew/bin/python3', version: '0.31.3' };
		assert.strictEqual(newestMlxInstall([xcode, framework]), framework, 'the Python of Xcode, which a short PATH names, is the older one');
		assert.strictEqual(newestMlxInstall([xcode, framework, brew]), framework);
		assert.strictEqual(newestMlxInstall([brew, framework]), brew);
		assert.strictEqual(newestMlxInstall([]), undefined);
	});

	test('reads the version a Python prints, and nothing else', () => {
		assert.strictEqual(versionFromOutput('0.31.3\n'), '0.31.3');
		assert.strictEqual(versionFromOutput('warning: something\n0.29.1\n'), '0.29.1');
		assert.strictEqual(versionFromOutput(''), undefined);
		assert.strictEqual(versionFromOutput('Traceback (most recent call last):'), undefined);
	});

	test('finds the Python an installed script runs on', () => {
		assert.strictEqual(pythonOfScript('#!/Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13\n# -*- coding: utf-8 -*-\n'), '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13');
		assert.strictEqual(pythonOfScript('#!/usr/bin/env python3\nimport sys\n'), 'python3');
		assert.strictEqual(pythonOfScript('\u0000ELF binary'), undefined);
		assert.strictEqual(pythonOfScript(''), undefined);
	});

	test('looks in the usual places, the newest framework Python first, and never at the Xcode shim', () => {
		const pythons = wellKnownPythons('/Users/me', ['3.9', '3.13', '3.12']);
		assert.deepStrictEqual(pythons.slice(0, 5), [
			'/opt/homebrew/bin/python3',
			'/usr/local/bin/python3',
			'/Library/Frameworks/Python.framework/Versions/3.13/bin/python3',
			'/Library/Frameworks/Python.framework/Versions/3.12/bin/python3',
			'/Library/Frameworks/Python.framework/Versions/3.9/bin/python3',
		]);
		assert.ok(pythons.includes('/Users/me/.local/share/uv/tools/mlx-lm/bin/python'));
		assert.ok(pythons.includes('/Users/me/miniconda3/bin/python'));
		assert.ok(!pythons.includes('/usr/bin/python3'));
	});

	test('says what to do about a model the server\'s mlx-lm is too old for, and leaves other errors alone', () => {
		const hinted = mlxErrorWithHint('Error: (KodiaModelError) Error: 404 Model type qwen3_5 not supported.');
		assert.ok(hinted.startsWith('Error: (KodiaModelError) Error: 404 Model type qwen3_5 not supported.'));
		assert.ok(hinted.includes('"qwen3_5" architecture') && hinted.includes('pip install --upgrade mlx-lm'));
		assert.strictEqual(mlxErrorWithHint('Error: connect ECONNREFUSED 127.0.0.1:8080'), 'Error: connect ECONNREFUSED 127.0.0.1:8080');
	});
});
