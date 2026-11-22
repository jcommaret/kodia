/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Roadmap 7 follow-up: code search re-ranked by meaning. Deterministic tests with a stand-in reranker, plus a LIVE
 * evaluation with Kodia's real NvidiaRerankerMainService on Kodia's own source (run with KODIA_LIVE=1; it reads the
 * key from the git-ignored repo-root .env and never prints it).
 */

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { fuseWithReranker, ICodeReranker } from '../../common/codeIndexServiceTypes.js';
import { KodiaCodeIndexService } from '../../node/codeIndexService.js';
import { NvidiaRerankerMainService } from '../../electron-main/nvidiaRerankerMainService.js';

suite('Kodia - code search re-ranked by meaning (roadmap 7)', function () {
	this.timeout(10 * 60_000);

	let dir: string;
	setup(() => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-rerank-')));
		fs.mkdirSync(path.join(dir, 'src'));
		fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'export function alphaUser() { return "user" }\n');
		fs.writeFileSync(path.join(dir, 'src', 'b.js'), 'export function betaUser() { return "user user" }\n');
	});
	teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

	test('fusion: a candidate the reranker strongly prefers moves up; one it could not score keeps its word rank', () => {
		// 10 word-ranked candidates; the reranker likes #5 best and could not score #2 (e.g. content screening)
		const scores = [0.1, 0.2, null, 0.3, 0.4, 9, 0.05, 0.01, 0.02, 0.03];
		const order = fuseWithReranker(scores);
		assert.strictEqual(order[0], 5, `#5 moved to the top: ${order}`);
		assert.ok(order.indexOf(2) < order.indexOf(6), `the unscored #2 keeps (about) its word rank: ${order}`);
		const equalWeights = fuseWithReranker(scores, 60, 1);
		assert.ok(equalWeights.indexOf(5) > 0, `with equal weights the reranker barely moves it: ${equalWeights}`);
		assert.deepStrictEqual(fuseWithReranker([null, null, null]), [0, 1, 2], 'nothing scored: word order');
	});

	test('the service reports how it ranked; a failing reranker keeps the word order and says why; unscored candidates are noted', async () => {
		const words = await new KodiaCodeIndexService(0).search([dir], 'user', 5);
		assert.deepStrictEqual(words.ranking, { by: 'words', note: undefined });
		const partly: ICodeReranker = { rerankTexts: async (_q, texts) => ({ scores: texts.map((_, i) => i === 0 ? null : 1) }) };
		const reranked = await new KodiaCodeIndexService(0, partly).search([dir], 'user', 5, { rerank: true });
		assert.strictEqual(reranked.ranking?.by, 'words+reranker');
		assert.match(reranked.ranking!.note!, /1 of 2 candidates could not be scored by the reranker and kept their word rank/);

		const failing: ICodeReranker = { rerankTexts: async () => ({ error: 'the NVIDIA reranker answered HTTP 503' }) };
		const fallback = await new KodiaCodeIndexService(0, failing).search([dir], 'user', 5, { rerank: true });
		assert.deepStrictEqual(fallback.hits.map(h => h.name), words.hits.map(h => h.name));
		assert.match(fallback.ranking!.note!, /re-ranking unavailable: the NVIDIA reranker answered HTTP 503/);
		assert.match((await new KodiaCodeIndexService(0).search([dir], 'user', 5, { rerank: true })).ranking!.note!, /no reranker is available/);
	});

	test('LIVE: on Kodia\'s own source, re-ranking with NVIDIA\'s reranker vs words alone (KODIA_LIVE=1)', async function () {
		const envFile = path.resolve(process.cwd(), '.env');
		const key = fs.existsSync(envFile) ? /^\s*NVIDIA_API_KEY\s*=\s*["']?([^"'\r\n]+)/m.exec(fs.readFileSync(envFile, 'utf8'))?.[1] : undefined;
		if (process.env.KODIA_LIVE !== '1' || !key) { this.skip(); }
		const reranker = new NvidiaRerankerMainService();
		reranker.setStorageService({ get: () => JSON.stringify({ settingsOfProvider: { nvidia: { apiKey: key } } }) } as any);
		reranker.setEncryptionService({ decrypt: async (s: string) => s } as any);

		const here = path.dirname(fileURLToPath(import.meta.url));
		const voidSrc = path.resolve(here, '../../../../../../../src/vs/workbench/contrib/void');
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
		const plain = new KodiaCodeIndexService(0);
		const withReranker = new KodiaCodeIndexService(0, reranker);
		const score = { words: { top1: 0, top3: 0 }, reranked: { top1: 0, top3: 0 } };
		const rows: string[] = [];
		for (const [q, expected] of cases) {
			const files = (hits: { relativePath: string }[]) => [...new Set(hits.map(h => h.relativePath.replace(/\\/g, '/')))].slice(0, 3);
			const w = files((await plain.search([voidSrc], q, 10)).hits);
			const rr = await withReranker.search([voidSrc], q, 10, { rerank: true });
			assert.strictEqual(rr.ranking?.by, 'words+reranker', `re-ranked: ${rr.ranking?.note}`);
			const r = files(rr.hits);
			for (const [k, list] of [['words', w], ['reranked', r]] as const) {
				if (list[0] === expected) { score[k].top1++; }
				if (list.includes(expected)) { score[k].top3++; }
			}
			rows.push(`${q}\n   words:    ${w.join(' | ')}\n   reranked: ${r.join(' | ')}`);
		}
		const report = `${JSON.stringify(score)}\n${rows.join('\n')}`;
		fs.writeFileSync(path.join(os.tmpdir(), 'kodia-code-rerank-eval.txt'), report);
		assert.ok(score.reranked.top3 >= 9, `re-ranked top-3 ${score.reranked.top3}/10\n${report}`);
	});
});
