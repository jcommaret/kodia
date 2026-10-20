/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as os from 'os';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { AgentSession, type AgentSignal, type IAgentActionSignal, type IAgentChatDataChange } from '../../common/agent.js';
import type { IByokLmBridgeConnection, IByokLmChatRequest, IByokLmChatResult, IByokLmModelInfo } from '../../common/agentHostByokLm.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { buildDefaultChatUri, ResponsePartKind } from '../../common/state/sessionState.js';
import type { IByokLmBridgeRegistry } from '../../node/byokLmBridgeRegistry.js';
import { KodiaAgent } from '../../node/kodia/kodiaAgent.js';

/** A Kodia window: replays scripted results and records each request and its token. */
class FakeKodiaWindow implements IByokLmBridgeConnection {
	readonly onDidChangeModels: Event<IByokLmModelInfo[]> = Event.None;
	readonly requests: IByokLmChatRequest[] = [];
	readonly tokens: CancellationToken[] = [];
	results: IByokLmChatResult[] = [];
	/** When set, the next request waits for it instead of answering. */
	pending: Promise<IByokLmChatResult> | undefined;

	async chat(request: IByokLmChatRequest, token?: CancellationToken): Promise<IByokLmChatResult> {
		// Snapshot: the agent keeps appending to the history it sent.
		this.requests.push(JSON.parse(JSON.stringify(request)));
		this.tokens.push(token ?? CancellationToken.None);
		if (this.pending) {
			return this.pending;
		}
		return this.results.shift() ?? { output: [] };
	}
}

class FakeBridgeRegistry implements IByokLmBridgeRegistry {
	declare readonly _serviceBrand: undefined;
	private readonly _listeners = new Set<() => void>();
	models: IByokLmModelInfo[] = [];
	window: FakeKodiaWindow | undefined = new FakeKodiaWindow();

	register(): IDisposable { return toDisposable(() => { }); }
	getModels(): readonly IByokLmModelInfo[] { return this.window ? this.models : []; }
	getServingConnection(): IByokLmBridgeConnection | undefined { return this.window; }
	onDidChangeModels(listener: () => void): IDisposable {
		this._listeners.add(listener);
		return toDisposable(() => this._listeners.delete(listener));
	}
	setModels(models: IByokLmModelInfo[]): void {
		this.models = models;
		for (const listener of this._listeners) {
			listener();
		}
	}
}

function actionTypes(signals: readonly AgentSignal[]): string[] {
	return signals.filter((s): s is IAgentActionSignal => s.kind === 'action').map(s => s.action.type);
}

function text(value: string): IByokLmChatResult {
	return { output: [{ type: 'message', content: [{ type: 'text', text: value }] }], usage: { inputTokens: 10, outputTokens: 5 } };
}

suite('KodiaAgent', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const gemini: IByokLmModelInfo = { vendor: 'gemini', id: 'gemini-3-pro', name: 'gemini-3-pro', maxContextWindowTokens: 1_000_000, supportsVision: true };
	const openRouter: IByokLmModelInfo = { vendor: 'openRouter', id: 'qwen/qwen3-coder', name: 'qwen/qwen3-coder' };

	function createAgent(registry = new FakeBridgeRegistry()): { agent: KodiaAgent; registry: FakeBridgeRegistry } {
		registry.models = [gemini, openRouter];
		return { agent: store.add(new KodiaAgent(new NullLogService(), registry)), registry };
	}

	let sessionCounter = 0;
	function newChat(): { session: URI; chat: URI } {
		const session = AgentSession.uri('kodia', `session-${++sessionCounter}`);
		return { session, chat: URI.parse(buildDefaultChatUri(session)) };
	}

	function watch(agent: KodiaAgent) {
		const signals: AgentSignal[] = [];
		const data: IAgentChatDataChange[] = [];
		store.add(agent.onDidChatProgress(s => signals.push(s)));
		store.add(agent.onDidChangeChatData(e => data.push(e)));
		return { signals, data };
	}

	const cwd = URI.file(os.tmpdir());

	test('offers the models of the Kodia window as <provider>/<model>, and follows them', () => {
		const { agent, registry } = createAgent();
		assert.deepStrictEqual(agent.models.get().map(m => m.id), ['gemini/gemini-3-pro', 'openRouter/qwen/qwen3-coder']);
		assert.strictEqual(agent.models.get()[0].maxContextWindow, 1_000_000);
		assert.strictEqual(agent.models.get()[0].supportsVision, true);

		registry.setModels([openRouter]);
		assert.deepStrictEqual(agent.models.get().map(m => m.id), ['openRouter/qwen/qwen3-coder']);

		registry.window = undefined;
		registry.setModels([openRouter]);
		assert.deepStrictEqual(agent.models.get(), [], 'no model without a Kodia window to run it');
	});

	test('does not ask for GitHub', () => {
		const { agent } = createAgent();
		assert.deepStrictEqual(agent.getProtectedResources().map(r => r.required), [false]);
	});

	test('a turn runs the chat\'s model in the Kodia window and persists the history', async () => {
		const { agent, registry } = createAgent();
		registry.window!.results = [text('Hello!')];
		const { session, chat } = newChat();
		const { signals, data } = watch(agent);
		await agent.chats.createChat(chat, session, { workingDirectories: [cwd], model: { id: 'openRouter/qwen/qwen3-coder' } });

		await agent.chats.sendMessage(chat, 'Hi', [cwd], undefined, 'turn-1');

		const request = registry.window!.requests[0];
		assert.strictEqual(request.vendor, 'openRouter');
		assert.strictEqual(request.modelId, 'qwen/qwen3-coder');
		assert.deepStrictEqual(request.tools?.map(t => t.name), ['read_file', 'write_file', 'list_dir', 'run_bash']);
		assert.deepStrictEqual(request.input, [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Hi' }] }]);
		assert.deepStrictEqual(actionTypes(signals), [ActionType.ChatUsage, ActionType.ChatResponsePart, ActionType.ChatTurnComplete]);

		// The history is in the backing, so a restored chat shows the turn.
		const restored = createAgent().agent;
		await restored.materializeChat(chat, session, data[data.length - 1].providerData);
		const turns = await restored.chats.getMessages(chat, session);
		assert.strictEqual(turns.length, 1);
		assert.strictEqual(turns[0].id, 'turn-1');
		assert.strictEqual(turns[0].message.text, 'Hi');
		assert.deepStrictEqual(turns[0].responseParts.map(p => p.kind === ResponsePartKind.Markdown ? p.content : p.kind), ['Hello!']);
	});

	test('runs a read-only tool the model calls and sends its result back', async () => {
		const { agent, registry } = createAgent();
		registry.window!.results = [
			{ output: [{ type: 'function_call', callId: 'call-1', name: 'list_dir', argumentsJson: '{}' }] },
			text('Done.'),
		];
		const { session, chat } = newChat();
		const { signals } = watch(agent);
		await agent.chats.createChat(chat, session, { workingDirectories: [cwd] });

		await agent.chats.sendMessage(chat, 'What is here?', [cwd], undefined, 'turn-1');

		assert.strictEqual(registry.window!.requests[0].vendor, 'gemini', 'without a chosen model, the first one runs');
		const second = registry.window!.requests[1].input;
		assert.deepStrictEqual(second.map(item => item.type), ['message', 'function_call', 'function_call_output']);
		assert.deepStrictEqual(actionTypes(signals), [
			ActionType.ChatToolCallStart, ActionType.ChatToolCallReady, ActionType.ChatToolCallComplete,
			ActionType.ChatUsage, ActionType.ChatResponsePart, ActionType.ChatTurnComplete,
		]);
	});

	test('a model error fails the turn and keeps the history consistent', async () => {
		const { agent, registry } = createAgent();
		registry.window!.results = [{ output: [], error: 'Invalid API key' }, text('Back.')];
		const { session, chat } = newChat();
		const { signals } = watch(agent);
		await agent.chats.createChat(chat, session, { workingDirectories: [cwd] });

		await agent.chats.sendMessage(chat, 'Hi', [cwd], undefined, 'turn-1');
		assert.deepStrictEqual(actionTypes(signals), [ActionType.ChatError]);

		await agent.chats.sendMessage(chat, 'Again', [cwd], undefined, 'turn-2');
		assert.deepStrictEqual(registry.window!.requests[1].input.map(item => item.type === 'message' ? item.role : item.type), ['user', 'user']);
	});

	test('without a Kodia window a turn fails fast', async () => {
		const { agent, registry } = createAgent();
		registry.window = undefined;
		const { session, chat } = newChat();
		const { signals } = watch(agent);
		await agent.chats.createChat(chat, session, { workingDirectories: [cwd], model: { id: 'gemini/gemini-3-pro' } });

		await agent.chats.sendMessage(chat, 'Hi', [cwd], undefined, 'turn-1');

		assert.deepStrictEqual(actionTypes(signals), [ActionType.ChatError]);
	});

	test('abort cancels the model request in the Kodia window', async () => {
		const { agent, registry } = createAgent();
		let answer!: (result: IByokLmChatResult) => void;
		registry.window!.pending = new Promise(resolve => answer = resolve);
		const { session, chat } = newChat();
		const { signals } = watch(agent);
		await agent.chats.createChat(chat, session, { workingDirectories: [cwd] });

		const turn = agent.chats.sendMessage(chat, 'Hi', [cwd], undefined, 'turn-1');
		while (registry.window!.tokens.length === 0) {
			await new Promise(resolve => setTimeout(resolve, 0));
		}
		await agent.chats.abort(chat, session);
		assert.strictEqual(registry.window!.tokens[0].isCancellationRequested, true);
		answer({ output: [], error: 'Cancelled' });
		await turn;

		assert.deepStrictEqual(actionTypes(signals), [], 'the host records the cancellation itself');
	});
});
