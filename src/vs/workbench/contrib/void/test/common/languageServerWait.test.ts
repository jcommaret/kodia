/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { waitUntil, whenEventSettles } from '../../common/languageServerWait.js';

suite('Kodia - waiting for a language server', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	suite('waitUntil', () => {
		test('answers at once when it is ready', async () => {
			const waits: number[] = [];
			assert.strictEqual(await waitUntil(() => true, 1000, 250, async ms => { waits.push(ms); }), true);
			assert.deepStrictEqual(waits, []);
		});

		test('polls until it becomes ready', async () => {
			let polls = 0;
			const waits: number[] = [];
			assert.strictEqual(await waitUntil(() => polls >= 3, 10_000, 250, async ms => { waits.push(ms); polls++; }), true);
			assert.deepStrictEqual(waits, [250, 250, 250]);
		});

		test('gives up once the time is spent', async () => {
			const waits: number[] = [];
			assert.strictEqual(await waitUntil(() => false, 1000, 250, async ms => { waits.push(ms); }), false);
			assert.strictEqual(waits.length, 4);
		});
	});

	suite('whenEventSettles', () => {
		test('waits for the events to stop, and ignores the ones that are not relevant', () => runWithFakedTimers({}, async () => {
			const emitter = store.add(new Emitter<number>());
			setTimeout(() => emitter.fire(1), 100);
			setTimeout(() => emitter.fire(2), 500); // restarts the quiet period, which then ends at 1300
			setTimeout(() => emitter.fire(-1), 900); // not relevant
			const log: string[] = [];
			setTimeout(() => log.push('1200'), 1200);
			setTimeout(() => log.push('1400'), 1400);

			const fired = await whenEventSettles(emitter.event, n => n > 0, 5000, 800);
			log.push('settled');

			assert.strictEqual(fired, true);
			assert.deepStrictEqual(log, ['1200', 'settled']);
			assert.strictEqual(emitter.hasListeners(), false);
		}));

		test('gives up, saying nothing fired, when no relevant event comes in time', () => runWithFakedTimers({}, async () => {
			const emitter = store.add(new Emitter<number>());
			setTimeout(() => emitter.fire(-1), 100);

			assert.strictEqual(await whenEventSettles(emitter.event, n => n > 0, 2000, 800), false);
			assert.strictEqual(emitter.hasListeners(), false);
		}));

		test('stops at the time limit when the events keep coming', () => runWithFakedTimers({}, async () => {
			const emitter = store.add(new Emitter<number>());
			let fires = 0;
			const handle = setInterval(() => emitter.fire(++fires), 300);

			assert.strictEqual(await whenEventSettles(emitter.event, () => true, 2000, 800), true);
			clearInterval(handle);
			assert.strictEqual(emitter.hasListeners(), false);
		}));
	});
});
