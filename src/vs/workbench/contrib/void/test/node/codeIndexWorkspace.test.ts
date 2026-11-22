/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Roadmap 7: the codebase index on real folders — a temporary git repository (what gets indexed, freshness) and
 * Kodia's own source (retrieval quality on questions with known answers, and indexing time).
 */

import assert from 'assert';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KodiaCodeIndexService } from '../../node/codeIndexService.js';

suite('Kodia - codebase index on real folders (roadmap 7)', function () {
	this.timeout(120_000);

	let dir: string;
	const p = (rel: string) => path.join(dir, rel);
	const write = (rel: string, content: string | Buffer) => { fs.mkdirSync(path.dirname(p(rel)), { recursive: true }); fs.writeFileSync(p(rel), content); };

	setup(() => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-index-')));
		cp.execFileSync('git', ['init', '-q'], { cwd: dir });
		write('.gitignore', 'ignored/\n*.log\n');
		write('src/auth/login.js', 'const { findUserByEmail } = require("../db/users");\n\nasync function login(email, password) {\n\tconst user = await findUserByEmail(email);\n\treturn user && user.password === password;\n}\nmodule.exports = { login };\n');
		write('src/db/users.js', 'const users = [];\n\nasync function findUserByEmail(email) {\n\treturn users.find(u => u.email === email);\n}\nmodule.exports = { findUserByEmail };\n');
		write('ignored/secret.js', 'function login() { /* must not be indexed: git-ignored */ }\n');
		write('debug.log', 'login failed for user\n');
		write('assets/logo.js', Buffer.from([0x66, 0x00, 0x01, 0x02])); // binary content with a text extension
		write('big/huge.js', 'function login() {}\n' + 'x'.repeat(600 * 1024));
		write('package-lock.json', '{ "login": true }');
	});
	teardown(() => {
		for (const f of fs.readdirSync(dir, { recursive: true }) as string[]) { try { fs.chmodSync(path.join(dir, f), 0o666); } catch { } }
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	});

	test('indexes the given folder through git (.gitignore applies); skips binary, oversized and lock files, and says so', async () => {
		const svc = new KodiaCodeIndexService();
		const stats = await svc.indexWorkspace([dir]);
		assert.strictEqual(stats.listedWith, 'git');
		const files = (await svc.findLiteral([dir], 'login', 50)).matches.map(m => m.relativePath.replace(/\\/g, '/'));
		assert.deepStrictEqual([...new Set(files)].sort(), ['src/auth/login.js'], 'not the ignored, binary, huge, log or lock file');
		assert.strictEqual(stats.totalFiles, 2, 'login.js and users.js');
		assert.deepStrictEqual([stats.skipped.binary, stats.skipped.tooLarge], [1, 1]);
	});

	test('searches index lazily and are always fresh: edits, deletions and new files show up on the next search', async () => {
		const svc = new KodiaCodeIndexService(0); // re-list on every search (the default is every 2s)
		let r = await svc.search([dir], 'look up a user by email', 5);
		assert.strictEqual(r.hits[0].name, 'findUserByEmail');
		assert.strictEqual(r.hits[0].relativePath.replace(/\\/g, '/'), 'src/db/users.js');
		assert.deepStrictEqual(r.hits[0].snippet.map(s => s.line), [3, 4]);

		write('src/db/users.js', 'const users = [];\n\nasync function getAccountByMail(mail) {\n\treturn users.find(u => u.mail === mail);\n}\n');
		r = await svc.search([dir], 'findUserByEmail', 5);
		assert.deepStrictEqual(r.refreshed, { added: 0, changed: 1, removed: 0 });
		assert.ok(!r.hits.some(h => h.name === 'findUserByEmail'), 'the old definition is gone at once');

		write('src/billing/invoice.ts', 'export function totalInvoiceAmount(lines: { price: number }[]) {\n\treturn lines.reduce((a, l) => a + l.price, 0);\n}\n');
		fs.rmSync(p('src/auth/login.js'));
		r = await svc.search([dir], 'invoice total amount', 3);
		assert.deepStrictEqual(r.refreshed, { added: 1, changed: 0, removed: 1 });
		assert.strictEqual(r.hits[0].name, 'totalInvoiceAmount');
		assert.deepStrictEqual((await svc.findLiteral([dir], 'async function login', 5)).matches, []);
	});

	test('falls back to a directory walk outside git, skipping dependency and build folders', async () => {
		fs.rmSync(p('.git'), { recursive: true, force: true });
		write('node_modules/lib/index.js', 'function login() {}\n');
		write('dist/bundle.js', 'function login() {}\n');
		const svc = new KodiaCodeIndexService();
		const stats = await svc.indexWorkspace([dir]);
		assert.strictEqual(stats.listedWith, 'walk');
		const files = new Set((await svc.findLiteral([dir], 'function login', 50)).matches.map(m => m.relativePath.replace(/\\/g, '/')));
		// not node_modules or dist; without git there is no .gitignore support, so ignored/ IS walked
		assert.deepStrictEqual([...files].sort(), ['ignored/secret.js', 'src/auth/login.js']);
	});

	test('Kodia\'s own source: questions with known answers are answered in the top 3, and indexing is fast', async () => {
		const here = path.dirname(fileURLToPath(import.meta.url)); // out/vs/workbench/contrib/void/test/node
		const voidSrc = path.resolve(here, '../../../../../../../src/vs/workbench/contrib/void');
		const svc = new KodiaCodeIndexService();
		const started = Date.now();
		const stats = await svc.indexWorkspace([voidSrc]);
		const indexMs = Date.now() - started;
		assert.ok(stats.totalFiles > 200, `indexed ${stats.totalFiles} files`);

		const cases: [string, string][] = [
			['format the subagent report', 'common/subagents.ts'],
			['context window overflow error from the provider', 'common/contextOverflow.ts'],
			['test file weakened: fewer assertions or skipped tests', 'common/testIntegrity.ts'],
			['git push with force-with-lease', 'common/gitOperations.ts'],
			['nudge when the model announces actions but calls no tool', 'common/unfulfilledActionDetection.ts'],
			['exponential backoff retry policy', 'common/retryPolicy.ts'],
			['search/replace ORIGINAL block is not unique in the file', 'browser/editCodeService.ts'],
			['layout issues: covered element, horizontal overflow, clipped text', 'electron-main/browserMainService.ts'],
			['parse junit xml test report', 'common/testCommandRunner.ts'],
			['split identifiers camelCase into words for BM25', 'common/codeIndex.ts'],
		];
		const rows: string[] = [];
		let found = 0;
		let searchMs = 0;
		for (const [q, expected] of cases) {
			const t0 = Date.now();
			const top = (await svc.search([voidSrc], q, 10)).hits.map(h => h.relativePath.replace(/\\/g, '/'));
			searchMs += Date.now() - t0;
			const files = [...new Set(top)].slice(0, 3);
			const rank = files.indexOf(expected) + 1;
			if (rank > 0) { found++; }
			rows.push(`${rank || '-'}  ${q}  →  ${files.join(' | ')}`);
		}
		const report = `indexed ${stats.totalFiles} files / ${stats.totalChunks} chunks in ${indexMs} ms; ${cases.length} searches in ${searchMs} ms\n${rows.join('\n')}`;
		fs.writeFileSync(path.join(os.tmpdir(), 'kodia-code-index-eval.txt'), report);
		assert.ok(found >= 9, `top-3 hits ${found}/${cases.length}\n${report}`);
		assert.ok(indexMs < 20_000, `indexing took ${indexMs} ms`);
		assert.ok(searchMs / cases.length < 500, `a search took ${searchMs / cases.length} ms on average`);
	});
});
