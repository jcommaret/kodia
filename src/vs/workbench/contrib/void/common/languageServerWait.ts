/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import type { Event } from '../../../../base/common/event.js';

// A language server starts when the first file of its language is loaded, then registers its providers and analyzes the
// file a few seconds later. A tool that loads a file and asks the server at once, as the Kodia agent does, has to wait.

/** Polls `isReady` until it is true or `timeoutMs` has passed. Returns whether it became true. */
export async function waitUntil(isReady: () => boolean, timeoutMs: number, pollMs = 250, wait: (ms: number) => Promise<unknown> = timeout): Promise<boolean> {
	for (let waited = 0; !isReady(); waited += pollMs) {
		if (waited >= timeoutMs) {
			return false;
		}
		await wait(pollMs);
	}
	return true;
}

/**
 * Resolves once a relevant `event` has fired and then stayed quiet for `settleMs`, so a server that reports its first
 * diagnostics in several steps is read after the last of them. Resolves after `timeoutMs` if none fired, or if they
 * were still coming. Returns whether one fired.
 */
export function whenEventSettles<T>(event: Event<T>, isRelevant: (e: T) => boolean, timeoutMs: number, settleMs: number): Promise<boolean> {
	return new Promise(resolve => {
		let settle: ReturnType<typeof setTimeout> | undefined;
		const finish = () => {
			clearTimeout(settle);
			clearTimeout(limit);
			listener.dispose();
			resolve(settle !== undefined);
		};
		const listener = event(e => {
			if (isRelevant(e)) {
				clearTimeout(settle);
				settle = setTimeout(finish, settleMs);
			}
		});
		const limit = setTimeout(finish, timeoutMs);
	});
}
