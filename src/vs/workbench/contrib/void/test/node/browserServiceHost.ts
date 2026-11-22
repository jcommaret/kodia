/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Test helper (not a test): hosts KodiaBrowserMainService in its own Node process, the way the Electron main
 * process hosts it in the app, and answers calls sent over the process IPC pipe. Used by renderer-side tests,
 * which cannot load Playwright themselves (the test renderer, like the workbench, has no `vm`).
 *
 * Protocol: { id, command, args } → { id, result } | { id, error }. On disconnect, all browsers are closed.
 */

import { KodiaBrowserMainService } from '../../electron-main/browserMainService.js';

const service = new KodiaBrowserMainService();
const send = (msg: unknown) => { process.send?.(msg); };

process.on('message', async (msg: { id: number; command: string; args: unknown[] }) => {
	try {
		const fn = (service as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[msg.command];
		if (typeof fn !== 'function') { throw new Error(`Unknown browser service method: ${msg.command}`); }
		send({ id: msg.id, result: await fn.apply(service, msg.args) });
	} catch (e) {
		send({ id: msg.id, error: e instanceof Error ? e.message : String(e) });
	}
});
process.on('disconnect', () => {
	service.shutdown().finally(() => process.exit(0));
});
send({ ready: true });
