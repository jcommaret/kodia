/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Real debugging of a live Node.js process through the V8 inspector protocol (CDP).
 *
 * Replaces test/common/realDebuggerIntegration.test.ts and realDAPDebuggerIntegration.test.ts, which were
 * scripts rather than tests: they ran at import time, ended with process.exit (killing the electron test
 * runner), reported nothing to mocha, and printed "✓" lines for steps they never performed (the "DAP" client
 * returned hard-coded values).
 *
 * Scope, stated honestly: this verifies the inspector protocol against a real process — launch paused,
 * conditional breakpoints, hit detection, call stack, scopes, variables, expression evaluation, step over/out,
 * uncaught-exception pauses and clean shutdown. It does NOT exercise a DAP adapter or Kodia's IDebugService /
 * debugToolService (those need the workbench debug platform; see debugToolService.test.ts).
 */

import assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import WebSocket from 'ws';

// 1-based line numbers below are referenced by the test
const TEST_APP = [
	/* 1 */ 'function calculateTotal(items) {',
	/* 2 */ '  let subtotal = 0;',
	/* 3 */ '  for (const item of items) {',
	/* 4 */ '    subtotal += item.price * item.quantity;',
	/* 5 */ '  }',
	/* 6 */ '  return subtotal;',
	/* 7 */ '}',
	/* 8 */ 'function applyDiscount(total, discountCode) {',
	/* 9 */ "  const rate = discountCode === 'SAVE10' ? 0.1 : 0;",
	/* 10 */ '  return total * (1 - rate);',
	/* 11 */ '}',
	/* 12 */ 'function checkout(items, discountCode) {',
	/* 13 */ '  const subtotal = calculateTotal(items);',
	/* 14 */ '  const discounted = applyDiscount(subtotal, discountCode);',
	/* 15 */ '  return discounted;',
	/* 16 */ '}',
	/* 17 */ "const result = checkout([{ price: 10, quantity: 2 }, { price: 25, quantity: 1 }], 'SAVE10');",
	/* 18 */ "console.log('result', result);",
	/* 19 */ "throw new Error('Simulated checkout failure: payment declined');",
].join('\n') + '\n';

type Paused = { reason: string; hitBreakpoints?: string[]; data?: { description?: string }; callFrames: { callFrameId: string; functionName: string; location: { lineNumber: number }; scopeChain: { type: string; object: { objectId: string } }[] }[] };

class Inspector {
	private ws!: WebSocket;
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	private readonly pausedQueue: Paused[] = [];
	private pausedWaiter: ((p: Paused) => void) | undefined;

	async connect(url: string) {
		this.ws = new WebSocket(url);
		await new Promise<void>((resolve, reject) => { this.ws.once('open', () => resolve()); this.ws.once('error', reject); });
		this.ws.on('message', raw => {
			const msg = JSON.parse(raw.toString());
			if (msg.id !== undefined) {
				const p = this.pending.get(msg.id);
				this.pending.delete(msg.id);
				if (msg.error) { p?.reject(new Error(`${msg.error.message}`)); } else { p?.resolve(msg.result); }
			} else if (msg.method === 'Debugger.paused') {
				if (this.pausedWaiter) { const w = this.pausedWaiter; this.pausedWaiter = undefined; w(msg.params); } else { this.pausedQueue.push(msg.params); }
			}
		});
	}
	send(method: string, params: object = {}): Promise<any> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
	}
	nextPause(timeoutMs = 10_000): Promise<Paused> {
		const queued = this.pausedQueue.shift();
		if (queued) { return Promise.resolve(queued); }
		return new Promise((resolve, reject) => {
			const t = setTimeout(() => { this.pausedWaiter = undefined; reject(new Error('timed out waiting for the debuggee to pause')); }, timeoutMs);
			this.pausedWaiter = p => { clearTimeout(t); resolve(p); };
		});
	}
	async evaluate(callFrameId: string, expression: string) {
		const r = await this.send('Debugger.evaluateOnCallFrame', { callFrameId, expression, returnByValue: true });
		return r.result.value;
	}
	close() { try { this.ws?.close(); } catch { } }
}

suite('Kodia - real debugging of a Node.js process (V8 inspector)', function () {
	this.timeout(60_000);

	let tmpDir: string;
	let child: cp.ChildProcess | undefined;
	let inspector: Inspector | undefined;

	setup(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-inspector-')); });
	teardown(() => {
		inspector?.close();
		if (child && child.exitCode === null) { child.kill(); }
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('launch paused, conditional breakpoint, stack/scopes/variables, evaluate, step, exception pause, clean exit', async () => {
		const appPath = path.join(tmpDir, 'app.js');
		fs.writeFileSync(appPath, TEST_APP);

		// --inspect-brk=0: a free port, paused before the first line
		child = cp.spawn(process.execPath, ['--inspect-brk=0', appPath], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
		let stdout = '';
		child.stdout!.on('data', d => { stdout += d; });
		const exited = new Promise<number | null>(resolve => child!.once('exit', code => resolve(code)));
		const wsUrl = await new Promise<string>((resolve, reject) => {
			let stderr = '';
			const t = setTimeout(() => reject(new Error(`inspector did not start: ${stderr}`)), 10_000);
			child!.stderr!.on('data', d => {
				stderr += d;
				const m = /Debugger listening on (ws:\/\/\S+)/.exec(stderr);
				if (m) { clearTimeout(t); resolve(m[1]); }
			});
		});

		inspector = new Inspector();
		await inspector.connect(wsUrl);
		await inspector.send('Runtime.enable');
		await inspector.send('Debugger.enable');
		await inspector.send('Debugger.setPauseOnExceptions', { state: 'uncaught' });
		await inspector.send('Runtime.runIfWaitingForDebugger');

		const onStart = await inspector.nextPause();
		// function declarations are not statements: the first executable line is 17 (const result = checkout(...))
		assert.strictEqual(onStart.callFrames[0].location.lineNumber, 16, 'paused on entry, before any code ran');
		assert.strictEqual(stdout, '', 'nothing has run yet');

		const urlRegex = 'app\\.js$';
		const conditional = await inspector.send('Debugger.setBreakpointByUrl', { urlRegex, lineNumber: 3, condition: 'item.price === 25' }); // line 4
		const inDiscount = await inspector.send('Debugger.setBreakpointByUrl', { urlRegex, lineNumber: 9 }); // line 10
		assert.ok(conditional.locations.length >= 1 && inDiscount.locations.length >= 1, 'both breakpoints resolve to real locations');

		// 1) the conditional breakpoint fires only for the 25 item (second loop iteration)
		await inspector.send('Debugger.resume');
		const atLoop = await inspector.nextPause();
		assert.deepStrictEqual(atLoop.hitBreakpoints, [conditional.breakpointId]);
		const loopFrame = atLoop.callFrames[0];
		assert.strictEqual(loopFrame.functionName, 'calculateTotal');
		assert.strictEqual(loopFrame.location.lineNumber, 3);
		assert.strictEqual(await inspector.evaluate(loopFrame.callFrameId, 'item.price'), 25);
		assert.strictEqual(await inspector.evaluate(loopFrame.callFrameId, 'subtotal'), 20, 'first item already added');

		// scopes and variables of the paused frame
		const localScope = loopFrame.scopeChain.find(s => s.type === 'local')!;
		const locals = await inspector.send('Runtime.getProperties', { objectId: localScope.object.objectId, ownProperties: true });
		const localNames = locals.result.map((p: { name: string }) => p.name);
		assert.ok(localNames.includes('items') && localNames.includes('subtotal'), `local scope has items and subtotal: ${localNames}`);

		// step over executes exactly the paused line: the 25 item is added
		await inspector.send('Debugger.stepOver');
		const afterStepOver = await inspector.nextPause();
		assert.strictEqual(afterStepOver.callFrames[0].functionName, 'calculateTotal', 'still in the same function');
		assert.notStrictEqual(afterStepOver.callFrames[0].location.lineNumber, 3, 'moved off line 4');
		assert.strictEqual(await inspector.evaluate(afterStepOver.callFrames[0].callFrameId, 'subtotal'), 45, 'line 4 ran once more');

		// 2) the second breakpoint, with the full call stack
		await inspector.send('Debugger.resume');
		const atDiscount = await inspector.nextPause();
		assert.deepStrictEqual(atDiscount.hitBreakpoints, [inDiscount.breakpointId]);
		assert.deepStrictEqual(atDiscount.callFrames.slice(0, 2).map(f => f.functionName), ['applyDiscount', 'checkout']);
		const discountFrame = atDiscount.callFrames[0].callFrameId;
		assert.strictEqual(await inspector.evaluate(discountFrame, 'total'), 45);
		assert.strictEqual(await inspector.evaluate(discountFrame, 'rate'), 0.1);
		assert.strictEqual(await inspector.evaluate(discountFrame, 'total * (1 - rate)'), 40.5, 'arbitrary expressions evaluate in the frame');

		// 3) step out finishes applyDiscount and stops in the caller with its return value assigned
		await inspector.send('Debugger.stepOut');
		const afterStepOut = await inspector.nextPause();
		assert.strictEqual(afterStepOut.callFrames[0].functionName, 'checkout');
		assert.ok([13, 14].includes(afterStepOut.callFrames[0].location.lineNumber), `in checkout after the call (line ${afterStepOut.callFrames[0].location.lineNumber + 1})`);
		assert.strictEqual(await inspector.evaluate(afterStepOut.callFrames[0].callFrameId, 'discounted'), 40.5, 'the returned value reached the caller');

		// 4) uncaught exception pause
		await inspector.send('Debugger.removeBreakpoint', { breakpointId: conditional.breakpointId });
		await inspector.send('Debugger.removeBreakpoint', { breakpointId: inDiscount.breakpointId });
		await inspector.send('Debugger.resume');
		const onException = await inspector.nextPause();
		assert.strictEqual(onException.reason, 'exception');
		assert.ok(onException.data?.description?.includes('Simulated checkout failure'), `exception details: ${onException.data?.description}`);
		assert.strictEqual(onException.callFrames[0].location.lineNumber, 18, 'paused on the throwing line (19)');

		// 5) let it finish: the program ran to completion with the expected output and exited with the error
		await inspector.send('Debugger.resume');
		inspector.close();
		const code = await exited;
		assert.match(stdout, /result 40\.5/);
		assert.notStrictEqual(code, 0, 'the uncaught exception terminates the process');
	});
});
