/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * The real KodiaBrowserMainService in its own Node process (test/node/browserServiceHost.ts), as in the app where
 * it lives in the Electron main process; calls cross a real process boundary. (The test renderer, like the
 * workbench, cannot load Playwright itself.)
 */

import * as cp from 'child_process';
import { FileAccess } from '../../../../../base/common/network.js';
import { IBrowserService } from '../../common/browserServiceTypes.js';

export async function startBrowserServiceProcess(): Promise<{ service: IBrowserService; stop: () => Promise<void> }> {
	const host = FileAccess.asFileUri('vs/workbench/contrib/void/test/node/browserServiceHost.js').fsPath;
	const child = cp.spawn('node', [host], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
	let stderr = '';
	child.stderr!.on('data', d => { stderr += String(d); });
	const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	let nextId = 0;
	await new Promise<void>((resolve, reject) => {
		child.once('exit', code => reject(new Error(`browser service process exited (${code}): ${stderr}`)));
		child.on('message', (m: any) => {
			if (m.ready) { resolve(); return; }
			const p = pending.get(m.id);
			pending.delete(m.id);
			if (m.error !== undefined) { p?.reject(new Error(m.error)); } else { p?.resolve(m.result); }
		});
	});
	const service = new Proxy({}, {
		get: (_t, command) => typeof command !== 'string' || command === 'then' ? undefined : (...args: unknown[]) => new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			child.send({ id, command, args });
		}),
	}) as IBrowserService;
	const stop = async () => {
		if (child.exitCode !== null) { return; }
		const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
		child.disconnect(); // the host closes its browsers, then exits
		await Promise.race([exited, new Promise(r => setTimeout(r, 10_000))]);
		if (child.exitCode === null) { child.kill(); }
	};
	return { service, stop };
}
