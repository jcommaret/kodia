/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Roadmap 7: code search by meaning (embeddings) fused with words. Deterministic tests with a stand-in embedder that maps
 * words to concepts (so the meaning side is predictable), plus a LIVE evaluation with NVIDIA's real embedding model on
 * Kodia's own source (KODIA_LIVE=1; the key is read from the git-ignored repo-root .env and never printed).
 */

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ICodeEmbedder } from '../../common/codeEmbeddings.js';
import { formatCodeSearch } from '../../common/codeIndexFormatting.js';
import { NVIDIA_EMBEDDINGS, OpenAICompatibleEmbedder } from '../../node/codeEmbedder.js';
import { KodiaCodeIndexService } from '../../node/codeIndexService.js';
import { NvidiaRerankerMainService } from '../../electron-main/nvidiaRerankerMainService.js';

/** words → concept dimensions: "payment" and "invoice total" mean the same here, without sharing a word */
const CONCEPTS: Record<string, number> = { pay: 0, payment: 0, invoice: 0, charge: 0, total: 0, price: 0, money: 0, sum: 0, login: 1, auth: 1, password: 1, session: 1, credential: 1, sign: 1, color: 2, theme: 2, dark: 2, palette: 2 };
class ConceptEmbedder implements ICodeEmbedder {
	readonly id = 'concepts@4';
	calls: { kind: string; n: number }[] = [];
	fail: string | undefined;
	delayMs = 0;
	async embed(texts: string[], kind: 'query' | 'passage') {
		this.calls.push({ kind, n: texts.length });
		if (this.delayMs && kind === 'passage') { await new Promise(r => setTimeout(r, this.delayMs)); } // embedding the code is the slow part
		if (this.fail) { return { error: this.fail }; }
		// like NVIDIA's content screening: one flagged text makes the whole request fail
		if (kind === 'passage' && texts.some(t => t.includes('FLAGGED'))) { return { error: 'the embedding model x answered HTTP 422: {"error": {"message": "input rejected by content safety screening"}}' }; }
		return {
			vectors: texts.map(t => {
				const vec = new Float32Array(4); vec[3] = 0.05;
				for (const w of t.toLowerCase().split(/[^a-z]+/)) { if (w in CONCEPTS) { vec[CONCEPTS[w]] += 1; } }
				return vec;
			}), tokens: texts.length * 10,
		};
	}
}

suite('Kodia - code search by meaning (embeddings, roadmap 7)', function () {
	this.timeout(30 * 60_000);
	let dir: string, cache: string;
	const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
	setup(() => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-semantic-')));
		cache = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-semantic-cache-')));
		write('src/billing.js', 'export function computeInvoiceTotal(lines) {\n  return lines.reduce((sum, l) => sum + l.price, 0);\n}\n');
		write('src/session.js', 'export function checkPassword(user, password) {\n  return user.hash === hash(password);\n}\n');
		write('src/theme.js', 'export function applyDarkPalette() {\n  document.body.classList.add("dark");\n}\n');
		write('src/payment_words.js', 'export function paymentHelper() { return null; } // mentions the query word only\n');
	});
	teardown(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(cache, { recursive: true, force: true }); });

	test('a chunk sharing no word with the query is found by meaning, and is said to be; words alone miss it', async () => {
		const embedder = new ConceptEmbedder();
		const svc = new KodiaCodeIndexService(0, undefined, { embedder, cacheDir: cache });
		const words = await svc.search([dir], 'payment', 5);
		assert.ok(!words.hits.some(h => h.name === 'computeInvoiceTotal'), 'words alone cannot find it');

		const r = await svc.search([dir], 'payment', 5, { semantic: true });
		assert.strictEqual(r.ranking?.by, 'words+meaning');
		assert.deepStrictEqual(r.ranking?.semantic, { model: 'concepts@4', embedded: 4, total: 4 });
		const names = r.hits.map(h => h.name);
		assert.ok(names.includes('computeInvoiceTotal') && names.includes('paymentHelper'), names.join(', '));
		assert.ok(names.indexOf('computeInvoiceTotal') < names.indexOf('applyDarkPalette'), `the unrelated chunk ranks below: ${names}`);
		const text = formatCodeSearch({ ...r, query: 'payment' });
		assert.match(text, /fused with meaning matches from the embedding model concepts@4/);
		assert.match(text, /computeInvoiceTotal  \(found by meaning: shares no words with the query\)/);
	});

	test('vectors are cached on disk: a restart embeds no unchanged code; an edited file re-embeds only its chunk', async () => {
		const first = new ConceptEmbedder();
		await new KodiaCodeIndexService(0, undefined, { embedder: first, cacheDir: cache }).search([dir], 'payment', 5, { semantic: true });
		assert.deepStrictEqual(first.calls.filter(c => c.kind === 'passage').map(c => c.n), [4]);

		const second = new ConceptEmbedder();
		const restarted = new KodiaCodeIndexService(0, undefined, { embedder: second, cacheDir: cache });
		const r = await restarted.search([dir], 'login', 5, { semantic: true });
		assert.deepStrictEqual(second.calls.map(c => c.kind), ['query'], 'only the query was embedded after the restart');
		assert.strictEqual(r.hits[0].name, 'checkPassword', 'login → the password check, by meaning');

		write('src/theme.js', 'export function applyDarkPalette() {\n  document.body.classList.add("dark", "high-contrast");\n}\n');
		await restarted.search([dir], 'color', 5, { semantic: true });
		assert.deepStrictEqual(second.calls.filter(c => c.kind === 'passage').map(c => c.n), [1], 'only the edited chunk');
	});

	test('a chunk refused by content screening is isolated and skipped; everything else is embedded, and the count is said', async () => {
		write('src/flagged.js', 'export function odd() { return "FLAGGED"; }\n');
		const embedder = new ConceptEmbedder();
		const svc = new KodiaCodeIndexService(0, undefined, { embedder, cacheDir: cache });
		const r = await svc.search([dir], 'payment', 5, { semantic: true });
		assert.strictEqual(r.ranking?.by, 'words+meaning');
		assert.deepStrictEqual(r.ranking?.semantic, { model: 'concepts@4', embedded: 4, total: 5 });
		assert.match(r.ranking!.note!, /covered 4 of 5 code chunks \(1 refused by the embedding provider's content screening: found by words only\)$/);
		const passageCalls = embedder.calls.filter(c => c.kind === 'passage').length;
		await svc.search([dir], 'login', 5, { semantic: true });
		assert.strictEqual(embedder.calls.filter(c => c.kind === 'passage').length, passageCalls, 'the refused chunk is not sent again');
	});

	test('a failing embedding model: words only, the reason said, no retry storm; a slow one: partial coverage is reported', async () => {
		const failing = new ConceptEmbedder();
		failing.fail = 'the embedding model nvidia/x answered HTTP 401: unauthorized';
		const svc = new KodiaCodeIndexService(0, undefined, { embedder: failing, cacheDir: cache });
		const r = await svc.search([dir], 'payment', 5, { semantic: true });
		assert.strictEqual(r.ranking?.by, 'words');
		assert.match(r.ranking!.note!, /meaning search unavailable: .*HTTP 401/);
		const callsAfterFirst = failing.calls.filter(c => c.kind === 'passage').length;
		await svc.search([dir], 'payment', 5, { semantic: true });
		assert.strictEqual(failing.calls.filter(c => c.kind === 'passage').length, callsAfterFirst, 'the job is not retried at once after a failure');
		assert.match((await new KodiaCodeIndexService(0).search([dir], 'x', 5, { semantic: true })).ranking!.note!, /no embedding model is available/);

		const slow = new ConceptEmbedder();
		slow.delayMs = 300;
		const partial = new KodiaCodeIndexService(0, undefined, { embedder: slow, cacheDir: undefined, waitMs: 50 });
		const p = await partial.search([dir], 'payment', 5, { semantic: true });
		assert.match(p.ranking!.note!, /nothing is embedded yet/, 'the search did not wait past its budget');
		await new Promise(r => setTimeout(r, 900));
		const later = await partial.search([dir], 'payment', 5, { semantic: true });
		assert.strictEqual(later.ranking?.by, 'words+meaning', 'the background job finished meanwhile');
	});

	test('LIVE: NVIDIA embeddings on Kodia\'s own source: words vs words+meaning (+reranker) on paraphrased questions (KODIA_LIVE=1)', async function () {
		const envFile = path.resolve(process.cwd(), '.env');
		const key = fs.existsSync(envFile) ? /^\s*NVIDIA_API_KEY\s*=\s*["']?([^"'\r\n]+)/m.exec(fs.readFileSync(envFile, 'utf8'))?.[1] : undefined;
		if (process.env.KODIA_LIVE !== '1' || !key) { this.skip(); }
		const here = path.dirname(fileURLToPath(import.meta.url));
		const voidSrc = path.resolve(here, '../../../../../../../src/vs/workbench/contrib/void');
		const embedder = new OpenAICompatibleEmbedder({ ...NVIDIA_EMBEDDINGS, nvidiaInputType: true, getApiKey: async () => key });
		const reranker = new NvidiaRerankerMainService();
		reranker.setStorageService({ get: () => JSON.stringify({ settingsOfProvider: { nvidia: { apiKey: key } } }) } as any);
		reranker.setEncryptionService({ decrypt: async (s: string) => s } as any);
		const liveCache = path.join(os.tmpdir(), 'kodia-semantic-live-cache'); // kept between runs on purpose
		const svc = new KodiaCodeIndexService(0, reranker, { embedder, cacheDir: liveCache });
		const started = Date.now();
		const coverage = await svc.embedAll([voidSrc]);
		const embedMs = Date.now() - started;

		// asked the way a person would, avoiding the code's own words
		const cases: [string, string][] = [
			['wait longer before each new attempt after a request fails', 'common/retryPolicy.ts'],
			['the model says it will do something but never actually does it', 'common/unfulfilledActionDetection.ts'],
			['someone removed checks from a test so it passes', 'common/testIntegrity.ts'],
			['the conversation no longer fits what the model can read', 'common/contextOverflow.ts'],
			['commands that could wipe out a disk or a whole folder', 'common/terminalSafety.ts'],
			['remember facts about this project between conversations', 'common/projectMemoryService.ts'],
			['how many pieces of text a message will cost', 'common/tokenizer.ts'],
			['tests that pass sometimes and fail other times on the same code', 'common/testHistory.ts'],
			['which lines of the program did the tests never run', 'common/testCoverage.ts'],
			['stop on the line where a unit test failed in the debugger', 'common/testDebug.ts'],
			['split a big job into smaller steps that depend on each other', 'common/taskDecompositionService.ts'],
			['keep a file path from escaping the project folder', 'common/pathSecurity.ts'],
		];
		const score = { words: { top1: 0, top3: 0 }, meaning: { top1: 0, top3: 0 }, meaningReranked: { top1: 0, top3: 0 } };
		const rows: string[] = [];
		for (const [q, expected] of cases) {
			const files = (hits: { relativePath: string }[]) => [...new Set(hits.map(h => h.relativePath.replace(/\\/g, '/')))].slice(0, 3);
			const w = files((await svc.search([voidSrc], q, 10)).hits);
			const m = await svc.search([voidSrc], q, 10, { semantic: true });
			assert.strictEqual(m.ranking?.by, 'words+meaning', `meaning used: ${m.ranking?.note}`);
			const mr = await svc.search([voidSrc], q, 10, { semantic: true, rerank: true });
			for (const [k, list] of [['words', w], ['meaning', files(m.hits)], ['meaningReranked', files(mr.hits)]] as const) {
				if (list[0] === expected) { score[k].top1++; }
				if (list.includes(expected)) { score[k].top3++; }
			}
			rows.push(`${q}  [expect ${expected}]\n   words:            ${w.join(' | ')}\n   words+meaning:    ${files(m.hits).join(' | ')}\n   +reranker:        ${files(mr.hits).join(' | ')} (${mr.ranking?.by})`);
		}
		const report = `${JSON.stringify(score)}\ncoverage ${JSON.stringify(coverage)} embedAll ${embedMs} ms\n${rows.join('\n')}`;
		fs.writeFileSync(path.join(os.tmpdir(), 'kodia-code-semantic-eval.txt'), report);
		assert.ok(coverage.embedded + coverage.refused === coverage.total && !coverage.lastError, `everything embedded or refused by screening: ${JSON.stringify(coverage)}`);
		assert.ok(score.meaning.top3 > score.words.top3, `meaning beats words alone on paraphrased questions\n${report}`);
	});
});
