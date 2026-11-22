/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Regression for a real incident, through the agent loop in Agent mode with a real terminal: an agent's
 * `Remove-Item -Recurse -Force <project>\*` ran without asking and deleted a user's project. Now Kodia stops and asks;
 * when the user declines, nothing is deleted and the model is told so. A harmless command still runs without asking.
 */

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { createHarness, ProcessTerminalToolService, removeRepo, runTurn, ScriptedLLMService, ScriptStep, toolMessages } from './agentHarness.js';

suite('Kodia - a destructive command waits for the user (Agent mode, real terminal)', function () {
	this.timeout(90_000);
	let store: DisposableStore;
	let dir: string;
	setup(() => {
		store = new DisposableStore();
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-destructive-')));
		for (const f of ['app/Http/Kernel.php', 'routes/web.php', 'composer.json']) {
			fs.mkdirSync(path.dirname(path.join(dir, 'project', f)), { recursive: true });
			fs.writeFileSync(path.join(dir, 'project', f), `${f}\n`);
		}
	});
	teardown(() => { store.dispose(); removeRepo(dir); });

	test('the recursive delete asks first; declined, every file is still there; a harmless command ran without asking', async () => {
		const project = path.join(dir, 'project');
		const wipe = isWindows ? `Remove-Item -Recurse -Force ${project}\\*` : `rm -rf ${project}/*`;
		const { chat } = createHarness(dir, new ScriptedLLMService((i, req): ScriptStep => {
			const payload = JSON.stringify(req.messages);
			switch (i) {
				case 0: return { text: '', toolCalls: [{ name: 'run_command', params: { command: 'node --version' } }] };
				case 1: return { text: '', toolCalls: [{ name: 'run_command', params: { command: wipe } }] };
				default:
					assert.match(payload, /reject|declin|denied/i, 'the model is told the user declined');
					return { text: 'The user declined the delete; nothing was removed.' };
			}
		}), store, { modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' }, terminal: store.add(new ProcessTerminalToolService(dir, 60_000)), globalSettings: { verifyBeforeFinishing: false } });

		const asked: string[] = [];
		store.add(chat.onDidChangeStreamState(({ threadId }) => {
			if (chat.streamState[threadId]?.isRunning !== 'awaiting_user') { return; }
			const last = chat.state.allThreads[threadId]!.messages.at(-1) as any;
			asked.push(String(last?.params?.command));
			setTimeout(() => chat.rejectLatestToolRequest(threadId), 0); // the user says no
		}));

		const { messages } = await runTurn(chat, 'Empty the project folder.', 60_000);
		assert.deepStrictEqual(asked, [wipe], 'only the delete needed approval (it ran without asking before)');
		assert.deepStrictEqual(toolMessages(messages).map((t: any) => `${t.name}:${t.type}`), ['run_command:success', 'run_command:rejected']);
		for (const f of ['app/Http/Kernel.php', 'routes/web.php', 'composer.json']) {
			assert.ok(fs.existsSync(path.join(project, f)), `${f} was not deleted`);
		}
	});
});
