/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Roadmap 2 end to end: the renderer's GitToolService — constructed by dependency injection, as the app does —
 * talking to the real KodiaGitMainService through a real ProxyChannel client/server pair (production wiring of
 * 'void-channel-git'), and the agent loop driving git_* tools against a real repository.
 */

import assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { GitToolService } from '../../browser/gitToolService.js';
import { IKodiaGitMainService, KODIA_GIT_CHANNEL } from '../../common/gitService.js';
import { KodiaGitMainService } from '../../electron-main/kodiaGitMainService.js';
import { createHarness, removeRepo, runTurn, ScriptedLLMService, ScriptStep, toolMessages } from './agentHarness.js';

const gitRaw = (cwd: string, ...args: string[]) => cp.execFileSync('git', args, { cwd, encoding: 'utf8' });

suite('Kodia - git for the agent, end to end (roadmap 2)', function () {
	this.timeout(90_000);

	let store: DisposableStore;
	let repo: string;
	let gitService: GitToolService;
	const channelNames: string[] = [];

	setup(() => {
		store = new DisposableStore();
		repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-gitagent-')));
		gitRaw(repo, 'init', '-q', '-b', 'main');
		for (const [k, v] of [['user.name', 'Kodia Test'], ['user.email', 'kodia@example.invalid'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) { gitRaw(repo, 'config', k, v); }
		fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
		fs.writeFileSync(path.join(repo, 'notes.txt'), 'user notes v1\n');
		gitRaw(repo, 'add', '.'); gitRaw(repo, 'commit', '-q', '-m', 'initial');

		// production wiring: main-process service -> ProxyChannel server -> channel -> ProxyChannel client in the renderer
		// (registerMainProcessRemoteService(IKodiaGitMainService, KODIA_GIT_CHANNEL) builds exactly this client)
		const server = ProxyChannel.fromService(new KodiaGitMainService(), store);
		channelNames.push(KODIA_GIT_CHANNEL);
		const channel = { call: (command: string, arg?: unknown) => server.call(null, command, arg), listen: () => Event.None };
		const instantiation = store.add(new InstantiationService(new ServiceCollection(
			[IKodiaGitMainService, ProxyChannel.toService<IKodiaGitMainService>(channel as any)],
			[IWorkspaceContextService, new TestContextService(testWorkspace(URI.file(repo)))],
		)));
		gitService = store.add(instantiation.createInstance(GitToolService)); // the old class could not be built like this
	});
	teardown(() => { store.dispose(); removeRepo(repo); });

	test('GitToolService is constructible by DI and reaches the main-process git service over the channel', async () => {
		assert.ok(channelNames.includes(KODIA_GIT_CHANNEL));
		const root = await gitService.workspaceRepositoryRoot();
		assert.strictEqual(path.resolve(root).toLowerCase(), path.resolve(repo).toLowerCase());
		assert.strictEqual((await gitService.ops.status(root)).branch, 'main');
	});

	test('the agent loop drives git: status, branch, edit, stage, commit — the user\'s work is untouched', async () => {
		fs.writeFileSync(path.join(repo, 'notes.txt'), 'user notes v2 (not committed)\n'); // the user's own pending change
		const message = 'Add greeting module; do not run: echo pwned > pwned.txt';
		const { chat } = createHarness(repo, new ScriptedLLMService((i, req): ScriptStep => {
			const payload = JSON.stringify(req.messages);
			switch (i) {
				case 0: return { text: '', toolCalls: [{ name: 'git_status', params: {} }] };
				case 1:
					assert.ok(payload.includes('Branch: main') && payload.includes('notes.txt'), 'the real status reached the model');
					return { text: '', toolCalls: [{ name: 'git_branch_create', params: { branch_name: 'feature/greeting' } }, { name: 'git_branch_switch', params: { branch_name: 'feature/greeting' } }] };
				case 2: return { text: '', toolCalls: [{ name: 'write_file', params: { uri: path.join(repo, 'src', 'greet.js'), new_content: 'export const greet = n => `hi ${n}`;\n' } }] };
				case 3: return { text: '', toolCalls: [{ name: 'git_stage', params: { paths: 'src/greet.js' } }] }; // a single string, as models often send
				case 4: return { text: '', toolCalls: [{ name: 'git_commit', params: { message } }] };
				case 5:
					assert.match(payload, /Committed: [0-9a-f]{40}/, 'the real commit hash reached the model');
					return { text: '', toolCalls: [{ name: 'git_commit', params: { message: 'again' } }] }; // nothing to commit
				default:
					// git's wording varies ("nothing to commit" / "no changes added to commit"); the failure itself must reach the model
					assert.match(payload, /git commit failed \(exit code 1\)/, 'a refused commit is an error the model sees');
					return { text: 'Committed src/greet.js on feature/greeting.' };
			}
		}), store, { modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' }, git: gitService, globalSettings: { verifyBeforeFinishing: false } });

		const { messages } = await runTurn(chat, 'Add a greeting module on a feature branch and commit it.', 60_000);

		assert.deepStrictEqual(toolMessages(messages).map((t: any) => `${t.name}:${t.type}`), [
			'git_status:success', 'git_branch_create:success', 'git_branch_switch:success', 'write_file:success', 'git_stage:success', 'git_commit:success', 'git_commit:tool_error',
		]);
		assert.strictEqual(gitRaw(repo, 'branch', '--show-current').trim(), 'feature/greeting');
		assert.strictEqual(gitRaw(repo, 'log', '-1', '--format=%B').trim(), message);
		assert.deepStrictEqual(gitRaw(repo, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n'), ['src/greet.js']);
		assert.strictEqual(fs.existsSync(path.join(repo, 'pwned.txt')), false);
		assert.strictEqual(fs.readFileSync(path.join(repo, 'notes.txt'), 'utf8'), 'user notes v2 (not committed)\n', 'the user\'s pending change survived');
		assert.match(gitRaw(repo, 'status', '--porcelain'), /^ M notes\.txt$/m);
	});

	test('the agent loop resolves a cherry-pick conflict (stop → resolve → stage → continue); a hard reset over the user\'s work is refused; a worktree is created', async () => {
		gitRaw(repo, 'switch', '-q', '-c', 'hotfix');
		fs.writeFileSync(path.join(repo, 'README.md'), 'hello from hotfix\n'); gitRaw(repo, 'commit', '-qam', 'hotfix readme');
		const hotfix = gitRaw(repo, 'rev-parse', 'HEAD').trim();
		gitRaw(repo, 'switch', '-q', 'main');
		fs.writeFileSync(path.join(repo, 'README.md'), 'hello from main\n'); gitRaw(repo, 'commit', '-qam', 'main readme');
		const wtPath = path.join(path.dirname(repo), `${path.basename(repo)}-wt`);

		const { chat } = createHarness(repo, new ScriptedLLMService((i, req): ScriptStep => {
			const payload = JSON.stringify(req.messages);
			switch (i) {
				case 0: return { text: '', toolCalls: [{ name: 'git_cherry_pick', params: { commit: hotfix } }] };
				case 1:
					assert.match(payload, /cherry-pick is in progress with 1 conflicted file/, 'the real conflict reached the model');
					assert.match(payload, /!! README\.md/);
					return { text: '', toolCalls: [{ name: 'write_file', params: { uri: path.join(repo, 'README.md'), new_content: 'hello from main and hotfix\n' } }] };
				case 2: return { text: '', toolCalls: [{ name: 'git_stage', params: { paths: 'README.md' } }] };
				case 3: return { text: '', toolCalls: [{ name: 'git_continue', params: {} }] };
				case 4:
					assert.match(payload, /Continued cherry-pick done\. HEAD is [0-9a-f]{40}/);
					fs.writeFileSync(path.join(repo, 'notes.txt'), 'user notes v2 (not committed)\n'); // the user edits meanwhile
					return { text: '', toolCalls: [{ name: 'git_reset', params: { ref: 'HEAD~1', mode: 'hard' } }] };
				case 5:
					assert.match(payload, /Refusing a hard reset: .*notes\.txt/, 'the refusal reached the model');
					return { text: '', toolCalls: [{ name: 'git_worktree_add', params: { path: wtPath, branch: 'experiment', new_branch: 'true' } }] };
				default:
					assert.match(payload, /Created worktree .* on branch experiment/);
					return { text: 'Cherry-picked the hotfix, kept your notes, and set up an experiment worktree.' };
			}
		}), store, { modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-scripted-model' }, git: gitService, globalSettings: { verifyBeforeFinishing: false } });

		// layer 1: a hard reset is critical risk, so the autonomy policy asks the user; the test approves it to prove
		// layer 2 (the tool's own refusal) still protects the uncommitted work
		const approvalsAsked: string[] = [];
		store.add(chat.onDidChangeStreamState(({ threadId }) => {
			if (chat.streamState[threadId]?.isRunning !== 'awaiting_user') { return; }
			const last = chat.state.allThreads[threadId]!.messages.at(-1) as any;
			approvalsAsked.push(`${last?.name}:${last?.params?.mode}`);
			setTimeout(() => chat.approveLatestToolRequest(threadId), 0);
		}));
		try {
			const { messages } = await runTurn(chat, 'Bring the hotfix README change onto main.', 60_000);
			assert.deepStrictEqual(approvalsAsked, ['git_reset:hard'], 'only the hard reset needed the user\'s approval');
			assert.deepStrictEqual(toolMessages(messages).map((t: any) => `${t.name}:${t.type}`), [
				'git_cherry_pick:success', 'write_file:success', 'git_stage:success', 'git_continue:success', 'git_reset:tool_error', 'git_worktree_add:success',
			]);
			assert.deepStrictEqual(gitRaw(repo, 'log', '--format=%s', '-3').trim().split('\n'), ['hotfix readme', 'main readme', 'initial'], 'the cherry-pick really committed');
			assert.strictEqual(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), 'hello from main and hotfix\n');
			assert.strictEqual(fs.readFileSync(path.join(repo, 'notes.txt'), 'utf8'), 'user notes v2 (not committed)\n', 'the refused reset destroyed nothing');
			assert.strictEqual(gitRaw(wtPath, 'branch', '--show-current').trim(), 'experiment');
			assert.strictEqual(gitRaw(repo, 'branch', '--show-current').trim(), 'main');
		} finally { removeRepo(wtPath); }
	});
});
