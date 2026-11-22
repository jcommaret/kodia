/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isTestFilePath, testFileWithoutTestCases, testWeakeningReasons } from '../../common/testIntegrity.js';

// the real weakening observed live (lightning-30b): a node:test file rewritten as a plain script
const NODE_TEST = `import { test } from 'node:test';
import assert from 'node:assert';
import { total } from '../src/cart.js';
test('normal cart', () => { assert.strictEqual(total([{ price: 10, qty: 2 }]), 20); });
test('empty cart', () => { assert.strictEqual(total([]), 0); });
test('TypeError', () => { assert.throws(() => total('x'), TypeError); });
`;
const PLAIN_SCRIPT = `import assert from 'node:assert';
import { total } from '../src/cart.js';
console.log('Test 1: normal cart', total([{ price: 10, qty: 2 }]));
console.log('Test 2: empty cart', total([]));
try { total('x'); } catch (e) { assert.strictEqual(e.name, 'TypeError'); }
console.log('All tests passed!');
`;

suite('Kodia - test weakening detection', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('recognizes test files across ecosystems', () => {
		for (const p of ['C:\\p\\test\\cart.test.js', '/p/src/cart.spec.ts', '/p/__tests__/a.js', '/p/tests/test_cart.py', '/p/cart_test.go', '/p/tests/CartTest.php', '/p/src/CartTests.cs']) {
			assert.strictEqual(isTestFilePath(p), true, p);
		}
		for (const p of ['/p/src/cart.js', '/p/src/latest.ts', '/p/contest.py', '/p/README.md']) {
			assert.strictEqual(isTestFilePath(p), false, p);
		}
	});

	test('flags the observed rewrite of a node:test file into a plain script', () => {
		const reasons = testWeakeningReasons('/p/test/cart.test.js', NODE_TEST, PLAIN_SCRIPT);
		assert.ok(reasons.some(r => r.startsWith('test cases 3 → 0')), reasons.join('; '));
		assert.ok(reasons.some(r => r.includes('test framework removed: node:test')), reasons.join('; '));
		assert.ok(reasons.some(r => r.startsWith('assertions 3 → 1')), reasons.join('; '));
	});

	test('flags commented-out, skipped and deleted tests', () => {
		const commented = NODE_TEST.replace(`test('empty cart'`, `// test('empty cart'`);
		assert.ok(testWeakeningReasons('/p/test/cart.test.js', NODE_TEST, commented).some(r => r.startsWith('test cases 3 → 2')));
		const skipped = NODE_TEST.replace(`test('TypeError'`, `test.skip('TypeError'`);
		assert.ok(testWeakeningReasons('/p/test/cart.test.js', NODE_TEST, skipped).some(r => r.startsWith('skipped tests 0 → 1')));
		assert.ok(testWeakeningReasons('/p/test/cart.test.js', NODE_TEST, undefined)[0].startsWith('the test file was deleted'));
	});

	test('flags removed assertions and Python skips', () => {
		const py = `import pytest\nfrom cart import total\n\ndef test_total():\n    assert total([]) == 0\n    assert total([1]) == 1\n`;
		assert.ok(testWeakeningReasons('/p/tests/test_cart.py', py, py.replace('    assert total([1]) == 1\n', '')).some(r => r.startsWith('assertions 2 → 1')));
		assert.ok(testWeakeningReasons('/p/tests/test_cart.py', py, py.replace('def test_total', '@pytest.mark.skip\ndef test_total')).some(r => r.startsWith('skipped tests')));
	});

	test('a test-named file without test cases is flagged; helpers and real tests are not', () => {
		// the file the model actually wrote in failed live runs: assertions, but no runner-visible test case
		const exportedChecks = `import assert from 'node:assert';\nimport { total } from '../src/cart.js';\nexport const tests = [{ name: 'normal cart', fn: () => assert.strictEqual(total([]), 0) }];\n`;
		assert.strictEqual(testFileWithoutTestCases('/p/test/cart.test.js', exportedChecks), true);
		assert.strictEqual(testFileWithoutTestCases('/p/test/cart.test.js', PLAIN_SCRIPT), true);
		assert.strictEqual(testFileWithoutTestCases('/p/test/cart.test.js', NODE_TEST), false);
		assert.strictEqual(testFileWithoutTestCases('/p/tests/test_cart.py', 'def test_total():\n    assert True\n'), false);
		assert.strictEqual(testFileWithoutTestCases('/p/test/helpers.js', exportedChecks), false, 'a helper in a test folder is not a test file');
		assert.strictEqual(testFileWithoutTestCases('/p/test/cart.test.js', ''), false, 'an empty placeholder is not flagged');
		assert.strictEqual(testFileWithoutTestCases('/p/test/cart.test.js', undefined), false);
	});

	test('does not flag new files, added tests, refactors or fixed imports', () => {
		assert.deepStrictEqual(testWeakeningReasons('/p/test/cart.test.js', undefined, NODE_TEST), [], 'new file');
		assert.deepStrictEqual(testWeakeningReasons('/p/test/cart.test.js', NODE_TEST, NODE_TEST + `test('rounding', () => { assert.strictEqual(total([{ price: 0.1, qty: 3 }]), 0.3); });\n`), [], 'added a test');
		assert.deepStrictEqual(testWeakeningReasons('/p/test/cart.test.js', NODE_TEST, NODE_TEST.replace(/normal cart/g, 'regular cart')), [], 'renamed');
		// the observed invalid `import { test, assert } from 'node:test'` fixed to a working import is not a weakening
		const brokenImport = NODE_TEST.replace(`import { test } from 'node:test';\nimport assert from 'node:assert';`, `import { test, assert } from 'node:test';`);
		assert.deepStrictEqual(testWeakeningReasons('/p/test/cart.test.js', brokenImport, NODE_TEST), [], 'fixed import');
		// URLs in strings are not comments
		const withUrl = NODE_TEST + `test('url', () => { assert.ok('https://example.com'); });\n`;
		assert.deepStrictEqual(testWeakeningReasons('/p/test/cart.test.js', withUrl, withUrl), []);
	});
});
