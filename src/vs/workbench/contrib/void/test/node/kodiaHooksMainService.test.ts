/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Real-process integration tests for KodiaHooksMainService (Mandate Part 3M).
 * Spawns actual Node hook commands from `.kodia/hooks.json` against a temp workspace,
 * verifying stdin JSON payload, env vars, exit-code 2 blocking, JSON block/ask/updatedInput,
 * matcher filtering, timeout termination, and audit logging.
 */

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KodiaHooksMainService } from '../../electron-main/kodiaHooksMainService.js';

suite('Kodia - KodiaHooksMainService (real process execution)', function () {
	this.timeout(30_000);

	let dir: string;
	let service: KodiaHooksMainService;

	setup(() => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-hooks-')));
		fs.mkdirSync(path.join(dir, '.kodia'), { recursive: true });
		service = new KodiaHooksMainService();
	});

	teardown(() => {
		service.dispose();
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	});

	const writeHooks = (config: unknown) => {
		fs.writeFileSync(path.join(dir, '.kodia', 'hooks.json'), JSON.stringify(config, null, 2));
	};

	const writeScript = (name: string, code: string) => {
		const p = path.join(dir, name);
		fs.writeFileSync(p, code);
		return p;
	};

	test('PreToolUse hook receives stdin JSON + env vars, blocks on exit 2, allows safe input, and records audit log', async () => {
		const script = writeScript('guard.cjs', `
			let data = '';
			process.stdin.on('data', c => data += c);
			process.stdin.on('end', () => {
				const payload = JSON.parse(data);
				const uri = String(payload.toolInput?.uri || '');
				if (uri.includes('.env')) {
					process.stderr.write('Refusing to edit .env file (event=' + process.env.KODIA_HOOK_EVENT + ')');
					process.exit(2);
				}
				process.stdout.write(JSON.stringify({
					decision: 'allow',
					systemMessage: 'checked:' + process.env.KODIA_TOOL_NAME,
				}));
			});
		`);
		writeHooks({
			hooks: {
				PreToolUse: [{ matcher: 'write_file|edit_file', command: `node "${script}"`, timeoutMs: 5000 }],
			},
		});

		const blocked = await service.runHooks([dir], {
			event: 'PreToolUse',
			threadId: 't-1',
			toolName: 'write_file',
			toolInput: { uri: path.join(dir, 'secret.env') },
			timestamp: new Date().toISOString(),
		});
		assert.strictEqual(blocked.decision, 'block');
		assert.match(blocked.reason!, /Refusing to edit \.env file \(event=PreToolUse\)/);

		const allowed = await service.runHooks([dir], {
			event: 'PreToolUse',
			threadId: 't-1',
			toolName: 'write_file',
			toolInput: { uri: path.join(dir, 'src/index.js') },
			timestamp: new Date().toISOString(),
		});
		assert.strictEqual(allowed.decision, 'allow');
		assert.deepStrictEqual(allowed.systemMessages, ['checked:write_file']);

		// Non-matching tool skips the hook completely
		const skipped = await service.runHooks([dir], {
			event: 'PreToolUse',
			threadId: 't-1',
			toolName: 'read_file',
			toolInput: { uri: path.join(dir, 'secret.env') },
			timestamp: new Date().toISOString(),
		});
		assert.strictEqual(skipped.decision, 'allow');
		assert.strictEqual(skipped.entries.length, 0);

		const audit = await service.getAuditLog(10);
		assert.strictEqual(audit.length, 2);
		assert.strictEqual(audit[0].decision, 'block');
		assert.strictEqual(audit[1].decision, 'allow');
	});

	test('PreToolUse hook can escalate to ask or rewrite toolInput via JSON stdout', async () => {
		const script = writeScript('rewrite.cjs', `
			let data = '';
			process.stdin.on('data', c => data += c);
			process.stdin.on('end', () => {
				const payload = JSON.parse(data);
				if (payload.toolInput?.mode === 'risky') {
					process.stdout.write(JSON.stringify({ decision: 'ask', reason: 'Confirm risky mode' }));
					return;
				}
				process.stdout.write(JSON.stringify({ decision: 'allow', updatedInput: { extra: 'injected' } }));
			});
		`);
		writeHooks({ hooks: { PreToolUse: [{ command: `node "${script}"` }] } });

		const askRes = await service.runHooks([dir], {
			event: 'PreToolUse',
			threadId: 't-2',
			toolName: 'run_command',
			toolInput: { mode: 'risky' },
			timestamp: new Date().toISOString(),
		});
		assert.strictEqual(askRes.decision, 'ask');
		assert.strictEqual(askRes.reason, 'Confirm risky mode');

		const modRes = await service.runHooks([dir], {
			event: 'PreToolUse',
			threadId: 't-2',
			toolName: 'run_command',
			toolInput: { mode: 'safe' },
			timestamp: new Date().toISOString(),
		});
		assert.strictEqual(modRes.decision, 'allow');
		assert.strictEqual(modRes.updatedInput?.extra, 'injected');
	});

	test('hook timeout terminates hung process cleanly without hanging the caller', async () => {
		const script = writeScript('hang.cjs', 'setTimeout(() => {}, 30000);');
		writeHooks({
			hooks: {
				PostToolUse: [{ command: `node "${script}"`, timeoutMs: 500 }],
			},
		});

		const started = Date.now();
		const res = await service.runHooks([dir], {
			event: 'PostToolUse',
			threadId: 't-3',
			toolName: 'read_file',
			timestamp: new Date().toISOString(),
		});
		assert.ok(Date.now() - started < 5000, 'timeout did not fire promptly');
		assert.strictEqual(res.decision, 'allow');
		assert.strictEqual(res.entries.length, 1);
		assert.strictEqual(res.entries[0].timedOut, true);
	});
});
