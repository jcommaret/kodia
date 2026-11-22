/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Roadmap 8: recovering from an agent's multi-file change. The agent edits, overwrites, creates and deletes files
 * in one turn (real ToolsService/EditCodeService on the real disk); the user then rewinds to before the turn — the
 * sidebar's "jump to checkpoint" — and forward again. Every file must be exactly as it was at each point.
 */

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { DIVIDER, FINAL, ORIGINAL } from '../../common/prompt/prompts.js';
import { createHarness, runTurn, ScriptedLLMService, ScriptStep, toolMessages } from './agentHarness.js';

const BEFORE: Record<string, string> = {
	'src/a.js': 'const a = 1;\nmodule.exports = { a };\n',
	'src/c.js': 'old c\n',
	'src/d.js': 'to be deleted\n',
	'docs/notes.md': '# Notes\n',
};

suite('Kodia - checkpoint recovery of multi-file agent changes (roadmap 8)', function () {
	this.timeout(60_000);

	let store: DisposableStore;
	let dir: string;
	const p = (rel: string) => path.join(dir, rel);
	const snapshot = () => {
		const out: Record<string, string> = {};
		const walk = (d: string) => {
			for (const e of fs.readdirSync(d, { withFileTypes: true })) {
				const full = path.join(d, e.name);
				if (e.isDirectory()) { walk(full); } else { out[path.relative(dir, full).replace(/\\/g, '/')] = fs.readFileSync(full, 'utf8'); }
			}
		};
		walk(dir);
		return out;
	};
	const same = (a: Record<string, string>, b: Record<string, string>) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
	const until = async (cond: () => boolean, what: string) => {
		for (let i = 0; i < 100 && !cond(); i++) { await new Promise(r => setTimeout(r, 50)); }
		assert.ok(cond(), what);
	};

	setup(() => {
		store = new DisposableStore();
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-checkpoints-')));
		for (const [rel, content] of Object.entries(BEFORE)) { fs.mkdirSync(path.dirname(p(rel)), { recursive: true }); fs.writeFileSync(p(rel), content); }
	});
	teardown(() => {
		store.dispose();
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	});

	test('rewinding a turn restores every file it changed — edited, overwritten, created and deleted — and replaying redoes them', async () => {
		const llm = new ScriptedLLMService((i): ScriptStep => {
			switch (i) {
				case 0: return { text: '', toolCalls: [{ name: 'edit_file', params: { uri: p('src/a.js'), search_replace_blocks: `${ORIGINAL}\nconst a = 1;\n${DIVIDER}\nconst a = 2;\n${FINAL}` } }] };
				case 1: return { text: '', toolCalls: [{ name: 'write_file', params: { uri: p('src/c.js'), new_content: 'new c\n' } }] };
				case 2: return { text: '', toolCalls: [{ name: 'write_file', params: { uri: p('src/b.js'), new_content: 'brand new b\n' } }] };
				case 3: return { text: '', toolCalls: [{ name: 'delete_file_or_folder', params: { uri: p('src/d.js') } }] };
				case 4: return { text: '', toolCalls: [{ name: 'create_file_or_folder', params: { uri: p('src/lib/') } }] };
				default: return { text: 'Done.' };
			}
		});
		const { chat } = createHarness(dir, llm, store, { modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' }, globalSettings: { verifyBeforeFinishing: false, autonomyOperationPolicy: { delete_file_or_folder: 'allow' } } }); // the user allowed deletes
		const { threadId, messages } = await runTurn(chat, 'Refactor the src folder.', 50_000);
		assert.deepStrictEqual(llm.scriptErrors, []);
		assert.deepStrictEqual(toolMessages(messages).map((t: any) => `${t.name}:${t.type}`), ['edit_file:success', 'write_file:success', 'write_file:success', 'delete_file_or_folder:success', 'create_file_or_folder:success']);

		const AFTER = { 'src/a.js': 'const a = 2;\nmodule.exports = { a };\n', 'src/c.js': 'new c\n', 'src/b.js': 'brand new b\n', 'docs/notes.md': '# Notes\n' };
		assert.deepStrictEqual(snapshot(), AFTER);
		assert.ok(fs.statSync(p('src/lib')).isDirectory());

		// rewind to before the user's message
		const userIdx = chat.state.allThreads[threadId]!.messages.findIndex(m => m.role === 'user');
		await chat.jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx: userIdx, jumpToUserModified: false });
		const shape = () => chat.state.allThreads[threadId]!.messages.map(m => m.role === 'checkpoint' ? `cp(${m.type}:${Object.keys(m.voidFileSnapshotOfURI).map(k => path.basename(k)).join(',')})` : m.role === 'tool' ? `tool:${m.name}` : m.role).join(' ');
		await until(() => same(snapshot(), BEFORE), `rewound to before the turn: ${JSON.stringify(snapshot())}\nthread: ${shape()}`);
		assert.ok(!fs.existsSync(p('src/lib')), 'the folder the agent created is gone (it was empty)');

		// and forward again, to the end of the turn
		const lastIdx = chat.state.allThreads[threadId]!.messages.length - 1;
		await chat.jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx: lastIdx, jumpToUserModified: false });
		await until(() => same(snapshot(), AFTER), `replayed the turn: ${JSON.stringify(snapshot())}`);
		assert.ok(fs.statSync(p('src/lib')).isDirectory());
	});

	test('saved snapshots are bounded per conversation: the oldest contents are dropped, recent rewinds still work, too-old ones are refused', async () => {
		const big = (tag: string) => `${tag}\n${'x'.repeat(400)}\n`;
		const llm = new ScriptedLLMService((i): ScriptStep => {
			switch (i) {
				case 0: return { text: '', toolCalls: [{ name: 'write_file', params: { uri: p('src/c.js'), new_content: big('v1') } }] };
				case 1: return { text: 'turn 1 done' };
				case 2: return { text: '', toolCalls: [{ name: 'write_file', params: { uri: p('src/c.js'), new_content: big('v2') } }] };
				default: return { text: 'turn 2 done' };
			}
		});
		const { chat } = createHarness(dir, llm, store, { modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' }, globalSettings: { verifyBeforeFinishing: false } });
		(chat as any)._maxSnapshotCharsPerThread = 1300; // room for about three of these snapshots (a turn makes three)
		const { threadId } = await runTurn(chat, 'turn 1', 30_000);
		await runTurn(chat, 'turn 2', 30_000);

		const cps = chat.state.allThreads[threadId]!.messages.filter(m => m.role === 'checkpoint') as any[];
		const snaps = cps.flatMap(c => Object.values(c.voidFileSnapshotOfURI) as any[]);
		const keptChars = snaps.filter(s => !s.pruned).reduce((a, s) => a + s.entireFileCode.length, 0);
		assert.ok(snaps.some(s => s.pruned), 'old snapshots were dropped');
		assert.ok(keptChars <= 1300, `kept within the bound: ${keptChars}`);

		// the most recent turn can still be rewound
		const userIdxs = chat.state.allThreads[threadId]!.messages.map((m, k) => m.role === 'user' ? k : -1).filter(k => k >= 0);
		await chat.jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx: userIdxs[1], jumpToUserModified: false });
		assert.strictEqual(fs.readFileSync(p('src/c.js'), 'utf8'), big('v1'), 'rewound turn 2');
		// before turn 1 the saved copy is gone: the file is left as it is rather than restored wrongly
		await chat.jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx: userIdxs[0], jumpToUserModified: false });
		assert.strictEqual(fs.readFileSync(p('src/c.js'), 'utf8'), big('v1'), 'too old: not restored (and reported to the user)');
	});

	test('rewinding a recursive folder delete brings back the whole tree', async () => {
		fs.mkdirSync(p('src/legacy/deep'), { recursive: true });
		fs.writeFileSync(p('src/legacy/old.js'), 'old\n');
		fs.writeFileSync(p('src/legacy/deep/older.js'), 'older\n');
		const before = snapshot();
		const llm = new ScriptedLLMService((i): ScriptStep => i === 0
			? { text: '', toolCalls: [{ name: 'delete_file_or_folder', params: { uri: p('src/legacy'), is_recursive: 'true' } }] }
			: { text: 'Removed the legacy folder.' });
		const { chat } = createHarness(dir, llm, store, { modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' }, // a recursive delete is critical: the user must both allow deletes and auto-approve edits
			globalSettings: { verifyBeforeFinishing: false, autonomyOperationPolicy: { delete_file_or_folder: 'allow' }, autoApprove: { edits: true } } });
		const { threadId, messages } = await runTurn(chat, 'Delete src/legacy.', 30_000);
		assert.deepStrictEqual(toolMessages(messages).map((t: any) => `${t.name}:${t.type}`), ['delete_file_or_folder:success'], JSON.stringify(toolMessages(messages).map((t: any) => t.content)));
		assert.ok(!fs.existsSync(p('src/legacy')));

		const userIdx = chat.state.allThreads[threadId]!.messages.findIndex(m => m.role === 'user');
		await chat.jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx: userIdx, jumpToUserModified: false });
		assert.ok(same(snapshot(), before), `restored: ${JSON.stringify(snapshot())}`);
		assert.ok(fs.statSync(p('src/legacy/deep')).isDirectory());
	});
});
