/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { buildCoverageCommand, lineRanges, mergeCoverage, missingCoveragePlugin, parseGoCoverProfile, parseLcov, relativeToRoot, summarizeCoverage } from '../../common/testCoverage.js';

// exactly what Node 24's lcov reporter wrote for a 6-line module where two branches are never taken
const NODE_LCOV = `TN:
SF:src\\m.mjs
FN:1,add
FN:2,sign
FNDA:1,add
FNDA:1,sign
FNF:2
FNH:2
BRDA:1,0,0,1
BRDA:1,1,0,1
BRDA:2,2,0,1
BRDA:3,3,0,0
BRF:4
BRH:3
DA:1,1
DA:2,1
DA:3,1
DA:4,0
DA:5,0
DA:6,1
LH:4
LF:6
end_of_record
`;

suite('Kodia - test coverage (roadmap 3)', () => {

	test('lcov: per-file lines, branches, functions and the uncovered lines; paths made relative to the root', () => {
		const [f] = parseLcov(NODE_LCOV, 'C:\\proj');
		assert.deepStrictEqual(f, { file: 'src/m.mjs', linesFound: 6, linesHit: 4, uncoveredLines: [4, 5], branchesFound: 4, branchesHit: 3, functionsFound: 2, functionsHit: 2 });
		const [abs] = parseLcov('SF:C:\\proj\\lib\\a.js\nDA:1,0\nend_of_record\n', 'C:\\proj');
		assert.strictEqual(abs.file, 'lib/a.js');
		assert.strictEqual(relativeToRoot('/other/x.js', '/proj'), '/other/x.js', 'files outside the root keep their path');
	});

	test('summary: totals, percentages, worst-covered first, focus on given files, files no test loaded', () => {
		const files = [...parseLcov(NODE_LCOV, 'C:\\proj'), { file: 'src/full.mjs', linesFound: 3, linesHit: 3, uncoveredLines: [] }];
		const s = summarizeCoverage(files);
		assert.strictEqual(s.linesFound, 9); assert.strictEqual(s.linesHit, 7); assert.strictEqual(s.linePercent, 77.8);
		assert.strictEqual(s.branchPercent, 75);
		assert.deepStrictEqual(s.files.map(f => [f.file, f.linePercent, f.uncoveredRanges]), [['src/m.mjs', 66.7, '4-5'], ['src/full.mjs', 100, '']]);
		const focused = summarizeCoverage(files, ['src\\full.mjs', 'src/never.mjs']);
		assert.deepStrictEqual(focused.files.map(f => f.file), ['src/full.mjs']);
		assert.deepStrictEqual(focused.notInReport, ['src/never.mjs']);
		assert.strictEqual(summarizeCoverage([]).linePercent, undefined, 'no lines is "n/a", not 0% or 100%');
	});

	test('two reports covering the same file: a line is covered if either covered it', () => {
		const merged = mergeCoverage([
			[{ file: 'a.js', linesFound: 4, linesHit: 2, uncoveredLines: [3, 4] }],
			[{ file: 'a.js', linesFound: 4, linesHit: 3, uncoveredLines: [4] }],
		]);
		assert.deepStrictEqual(merged, [{ file: 'a.js', linesFound: 4, linesHit: 3, uncoveredLines: [4] }]);
	});

	test('Go cover profile: statements per block, module path stripped', () => {
		const profile = 'mode: set\nexample.com/calc/calc.go:3.24,5.2 1 1\nexample.com/calc/calc.go:7.24,9.2 2 0\nexample.com/calc/util/u.go:1.1,2.2 1 1\n';
		const files = parseGoCoverProfile(profile, '/proj', 'example.com/calc');
		assert.deepStrictEqual(files, [
			{ file: 'calc.go', linesFound: 3, linesHit: 1, uncoveredLines: [7, 8, 9] },
			{ file: 'util/u.go', linesFound: 1, linesHit: 1, uncoveredLines: [] },
		]);
	});

	test('line ranges are compact and bounded', () => {
		assert.strictEqual(lineRanges([3, 4, 5, 9, 11, 12]), '3-5, 9, 11-12');
		assert.match(lineRanges(Array.from({ length: 100 }, (_, i) => i * 2), 3), /^0, 2, 4, … \(97 more ranges\)$/);
	});

	test('commands: coverage flags per framework; plugins that are needed but absent are explained, unsupported ones refused', () => {
		const o = { reportFile: '.kodia/test-results/r.xml', coverageDir: '.kodia/coverage/r', files: ['test/a.test.mjs'] };
		const node = buildCoverageCommand('node-test', o);
		assert.ok(!('unavailable' in node));
		assert.match(node.command, /^node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=\.kodia\/coverage\/r\/lcov\.info .*--test-reporter=junit --test-reporter-destination=\.kodia\/test-results\/r\.xml.* test\/a\.test\.mjs$/);
		const jest = buildCoverageCommand('jest', o);
		assert.ok(!('unavailable' in jest) && /--coverage --coverageReporters=lcov --coverageDirectory=\.kodia\/coverage\/r$/.test(jest.command));
		const py = buildCoverageCommand('pytest', o);
		assert.ok(!('unavailable' in py) && /^python -m pytest --cov=\. --cov-report=lcov:\.kodia\/coverage\/r\/lcov\.info /.test(py.command));
		const go = buildCoverageCommand('go', o);
		assert.ok(!('unavailable' in go) && go.coverageFormat === 'go-profile' && /^go test -coverprofile=\.kodia\/coverage\/r\/cover\.out /.test(go.command));
		assert.match((buildCoverageCommand('mocha', o) as { unavailable: string }).unavailable, /Install c8 \(npm i -D c8\)/);
		const mocha = buildCoverageCommand('mocha', { ...o, hasC8: true });
		assert.ok(!('unavailable' in mocha) && /^npx --no-install c8 --reporter=lcov --report-dir=\.kodia\/coverage\/r mocha /.test(mocha.command));
		for (const fw of ['cargo', 'dotnet', 'phpunit'] as const) { assert.ok('unavailable' in buildCoverageCommand(fw, o), fw); }
		assert.throws(() => buildCoverageCommand('jest', { ...o, coverageDir: 'a dir; rm -rf /' }), /Unsafe coverage directory/);
		assert.strictEqual(missingCoveragePlugin('pytest', 'ERROR: usage: pytest [options]\npytest: error: unrecognized arguments: --cov=. --cov-report=lcov:x'), 'pytest-cov is not installed (pip install pytest-cov).');
		assert.match(missingCoveragePlugin('vitest', 'MISSING DEPENDENCY  Cannot find dependency \'@vitest/coverage-v8\'')!, /@vitest\/coverage-v8/);
		assert.strictEqual(missingCoveragePlugin('jest', 'all good'), undefined);
	});
});
