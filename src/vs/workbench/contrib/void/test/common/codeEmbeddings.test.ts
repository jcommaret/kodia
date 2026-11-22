/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { contentKey, embeddingText, EmbeddingStore, fuseRankings, MAX_STORED_VECTORS } from '../../common/codeEmbeddings.js';

const v = (...xs: number[]) => Float32Array.from(xs);

suite('Kodia - code embeddings store (roadmap 7)', () => {

	test('cosine nearest: unit-normalized, best first, candidates without a vector are skipped', () => {
		const s = new EmbeddingStore('m@4');
		s.set('a', v(10, 0, 0, 0));
		s.set('b', v(1, 1, 0, 0));
		s.set('c', v(0, 0, 3, 0));
		const r = s.nearest(v(1, 0.1, 0, 0), [{ key: 'a', item: 'A' }, { key: 'b', item: 'B' }, { key: 'c', item: 'C' }, { key: 'missing', item: 'X' }], 3);
		assert.deepStrictEqual(r.map(x => x.item), ['A', 'B', 'C']);
		assert.ok(Math.abs(r[0].score - 0.995) < 0.01, 'a cosine, not a raw dot product');
		assert.throws(() => s.set('d', v(1, 2)), /size changed from 4 to 2/);
	});

	test('serializes and loads back exactly; another model\'s or a damaged file is not used', () => {
		const s = new EmbeddingStore('nvidia/x@3');
		s.set('k1', v(1, 2, 3));
		s.set('k2', v(-1, 0, 0.5));
		const bytes = s.serialize();
		const back = EmbeddingStore.deserialize(bytes, 'nvidia/x@3')!;
		assert.deepStrictEqual([back.size, back.dimensions], [2, 3]);
		assert.deepStrictEqual([...back.get('k1')!], [...s.get('k1')!]);
		assert.strictEqual(EmbeddingStore.deserialize(bytes, 'other@3'), undefined, 'vectors of another model are never mixed in');
		assert.strictEqual(EmbeddingStore.deserialize(bytes.subarray(0, bytes.length - 4), 'nvidia/x@3'), undefined, 'a truncated file');
		assert.strictEqual(EmbeddingStore.deserialize(new Uint8Array([1, 2, 3]), 'nvidia/x@3'), undefined);
	});

	test('the store is bounded (oldest dropped); a key is the hash of exactly the embedded text', () => {
		const s = new EmbeddingStore('m@1');
		for (let i = 0; i <= MAX_STORED_VECTORS; i++) { s.set(`k${i}`, v(1)); }
		assert.strictEqual(s.size, MAX_STORED_VECTORS);
		assert.ok(!s.has('k0') && s.has(`k${MAX_STORED_VECTORS}`));
		const t = embeddingText('src\\pay.ts', 'function', 'charge', 'return amount');
		assert.strictEqual(t, 'src/pay.ts — function charge\nreturn amount');
		assert.strictEqual(contentKey(t), contentKey('src/pay.ts — function charge\nreturn amount'));
		assert.notStrictEqual(contentKey(t), contentKey(t + ' '));
	});

	test('rank fusion: agreement wins, each side contributes, ties keep the first ranking\'s order', () => {
		assert.deepStrictEqual(fuseRankings([{ ids: ['a', 'b', 'c'], weight: 1 }, { ids: ['c', 'x', 'a'], weight: 1 }]).slice(0, 2), ['a', 'c']);
		assert.deepStrictEqual(fuseRankings([{ ids: ['a', 'b'], weight: 1 }, { ids: ['b', 'a'], weight: 1 }]), ['a', 'b']);
		assert.deepStrictEqual(fuseRankings([{ ids: [], weight: 1 }, { ids: ['m'], weight: 1 }]), ['m'], 'found by meaning only');
	});
});
