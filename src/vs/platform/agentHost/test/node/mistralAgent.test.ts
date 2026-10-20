/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as os from 'os';
import { Emitter } from '../../../../base/common/event.js';
import { isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { AgentSession, type AgentSignal, type IAgentActionSignal, type IAgentChatDataChange, type IAgentMaterializeChatEvent, type IAgentToolPendingConfirmationSignal } from '../../common/agent.js';
import { AgentHostShownModelsConfigKey } from '../../common/agentHostSchema.js';
import { AgentHostMistralApiKeyEnvVar } from '../../common/agentService.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { buildDefaultChatUri, ResponsePartKind, ToolCallStatus, type ResponsePart } from '../../common/state/sessionState.js';
import { IAgentConfigurationService } from '../../node/agentConfigurationService.js';
import { MistralAgent } from '../../node/mistral/mistralAgent.js';
import { IMistralApiService, IMistralModel } from '../../node/mistral/mistralApiService.js';
import { createNullSessionDataService, createSessionDataService, TestSessionDatabase } from '../common/sessionTestHelpers.js';

/** Wrap a list of conversation-event payloads in an async-iterable stream. */
function makeStream(events: ReadonlyArray<unknown>): any {
	return {
		async *[Symbol.asyncIterator]() {
			for (const data of events) { yield { event: 'message', data }; }
		},
	};
}

function done(promptTokens = 10, completionTokens = 5) {
	return { type: 'conversation.response.done', usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens } };
}

/**
 * Minimal {@link IMistralApiService}: `models()` is scripted via the ctor, and
 * the conversation streams replay `startEvents` / `appendEvents`. Records the
 * last request args so tests can assert start-vs-append routing.
 */
class FakeMistralApiService implements IMistralApiService {
	declare readonly _serviceBrand: undefined;
	startEvents: ReadonlyArray<unknown> = [];
	appendEvents: ReadonlyArray<unknown> = [];
	history: { entries: unknown[] } = { entries: [] };
	lastStartRequest: any;
	lastAppend: { conversationId: string; request: any } | undefined;

	constructor(private readonly _models: () => Promise<IMistralModel[]> = async () => []) { }
	setRateLimit(): void { /* no-op: the fake makes no real requests to throttle */ }
	models(): Promise<IMistralModel[]> { return this._models(); }
	async startConversationStream(_apiKey: string, request: any): Promise<any> {
		this.lastStartRequest = request;
		return makeStream(this.startEvents);
	}
	async appendConversationStream(_apiKey: string, conversationId: string, request: any): Promise<any> {
		this.lastAppend = { conversationId, request };
		return makeStream(this.appendEvents);
	}
	async getConversationHistory(_apiKey: string, conversationId: string): Promise<any> {
		return { object: 'conversation.history', conversationId, ...this.history };
	}
}

/** Root config holding the Mistral models Kodia forwards; unset until a test sets them. */
class TestRootConfigService extends mock<IAgentConfigurationService>() {
	private readonly _onDidRootConfigChange = new Emitter<void>();
	override readonly onDidRootConfigChange = this._onDidRootConfigChange.event;
	private _shownModels: string[] | undefined;

	override getRootValue(_schema: never, key: string) {
		return (key === AgentHostShownModelsConfigKey && this._shownModels ? { mistral: this._shownModels } : undefined) as never;
	}

	setShownModels(models: string[] | undefined): void {
		this._shownModels = models;
		this._onDidRootConfigChange.fire();
	}

	dispose(): void {
		this._onDidRootConfigChange.dispose();
	}
}

function model(id: string, supportsFunctionCalling: boolean, extra?: Partial<IMistralModel>): IMistralModel {
	return { id, name: id, maxContextWindow: 128_000, supportsFunctionCalling, supportsVision: false, ...extra };
}

function actionTypes(signals: readonly AgentSignal[]): string[] {
	return signals.filter((s): s is IAgentActionSignal => s.kind === 'action').map(s => s.action.type);
}

type ActionOfType<T extends ActionType> = Extract<IAgentActionSignal['action'], { type: T }>;

function isActionOfType<T extends ActionType>(action: IAgentActionSignal['action'], type: T): action is ActionOfType<T> {
	return action.type === type;
}

function actionsOf<T extends ActionType>(signals: readonly AgentSignal[], type: T): ActionOfType<T>[] {
	const result: ActionOfType<T>[] = [];
	for (const s of signals) {
		if (s.kind === 'action' && isActionOfType(s.action, type)) {
			result.push(s.action);
		}
	}
	return result;
}

suite('MistralAgent', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	// The agent reads the API key from the gate env var in its constructor.
	// Keep it unset so the constructor's fire-and-forget refresh no-ops and
	// each test drives the (awaitable) refresh through `authenticate`.
	let savedEnv: string | undefined;
	setup(() => { savedEnv = process.env[AgentHostMistralApiKeyEnvVar]; delete process.env[AgentHostMistralApiKeyEnvVar]; });
	teardown(() => { if (savedEnv === undefined) { delete process.env[AgentHostMistralApiKeyEnvVar]; } else { process.env[AgentHostMistralApiKeyEnvVar] = savedEnv; } });

	function createAgent(api: IMistralApiService, data = createNullSessionDataService(), config = store.add(new TestRootConfigService())): MistralAgent {
		return store.add(new MistralAgent(new NullLogService(), api, data, config));
	}

	async function authedAgent(api: FakeMistralApiService) {
		const agent = createAgent(api);
		await agent.authenticate('', 'sk-test');
		return agent;
	}

	let sessionCounter = 0;
	function newChat(): { session: URI; chat: URI } {
		const session = AgentSession.uri('mistral', `session-${++sessionCounter}`);
		return { session, chat: URI.parse(buildDefaultChatUri(session)) };
	}

	function watch(agent: MistralAgent) {
		const signals: AgentSignal[] = [];
		const data: IAgentChatDataChange[] = [];
		let onPending: (s: IAgentToolPendingConfirmationSignal) => void;
		const pending = new Promise<IAgentToolPendingConfirmationSignal>(res => { onPending = res; });
		store.add(agent.onDidChatProgress(s => { signals.push(s); if (s.kind === 'pending_confirmation') { onPending(s); } }));
		store.add(agent.onDidChangeChatData(e => data.push(e)));
		return { signals, data, pending };
	}

	const cwd = URI.file('/work/project');

	// ---- Models + auth ----

	test('advertises no models without an API key', () => {
		const agent = createAgent(new FakeMistralApiService(async () => [model('devstral-2512', true)]));
		assert.deepStrictEqual(agent.models.get(), []);
	});

	test('authenticate replaces seed with the real catalog, filtered to function calling', async () => {
		const agent = createAgent(new FakeMistralApiService(async () => [
			model('devstral-2512', true),
			model('mistral-embed', false), // no function calling -> filtered out
			model('mistral-large-2512', true, { supportsVision: true, maxContextWindow: 256_000 }),
		]));

		assert.strictEqual(await agent.authenticate('', 'sk-test'), true);

		const models = agent.models.get();
		assert.deepStrictEqual(models.map(m => m.id).sort(), ['devstral-2512', 'mistral-large-2512']);
		const large = models.find(m => m.id === 'mistral-large-2512')!;
		assert.strictEqual(large.supportsVision, true);
		assert.strictEqual(large.maxContextWindow, 256_000);
	});

	test('keeps a tool-capable seed list when the catalog has no tool-capable models or fails', async () => {
		const empty = createAgent(new FakeMistralApiService(async () => [model('mistral-embed', false)]));
		await empty.authenticate('', 'sk-test');
		const seeded = empty.models.get();
		assert.ok(seeded.length > 0, 'expected a non-empty seed list');
		assert.ok(seeded.every(m => m.provider === 'mistral'));
		assert.ok(seeded.some(m => m.id === 'devstral-latest'));

		const failing = createAgent(new FakeMistralApiService(async () => { throw new Error('network'); }));
		assert.strictEqual(await failing.authenticate('', 'sk-test'), true, 'authenticate should still succeed despite a model-fetch failure');
		assert.deepStrictEqual(failing.models.get(), seeded);
	});

	test('offers only the models shown in Kodia\'s dropdown, in their order', async () => {
		const config = store.add(new TestRootConfigService());
		config.setShownModels(['mistral-large-latest', 'zai-glm-5-3', 'mistral-embed', 'my-custom-model']);
		const agent = createAgent(new FakeMistralApiService(async () => [
			model('devstral-2512', true), // not shown -> filtered out
			model('mistral-embed', false), // shown but no function calling -> filtered out
			model('mistral-large-2512', true, { aliases: ['mistral-large-latest'], supportsVision: true, maxContextWindow: 256_000 }),
			model('zai-glm-5-3', true, { maxContextWindow: 1_000_000 }),
		]), undefined, config);

		await agent.authenticate('', 'sk-test');

		const models = agent.models.get();
		assert.deepStrictEqual(models.map(m => m.id), ['mistral-large-latest', 'zai-glm-5-3', 'my-custom-model']);
		const large = models[0];
		assert.strictEqual(large.supportsVision, true, 'metadata comes from the catalog entry the alias points to');
		assert.strictEqual(large.maxContextWindow, 256_000);
		assert.strictEqual(models[1].name, 'Z.ai GLM 5.3');
	});

	test('follows changes to the models shown in Kodia\'s dropdown', async () => {
		const config = store.add(new TestRootConfigService());
		const agent = createAgent(new FakeMistralApiService(async () => [model('devstral-2512', true), model('codestral-2508', true, { aliases: ['codestral-latest'] })]), undefined, config);
		await agent.authenticate('', 'sk-test');
		assert.deepStrictEqual(agent.models.get().map(m => m.id), ['devstral-2512', 'codestral-2508'], 'the whole catalog until Kodia forwards its models');

		config.setShownModels(['codestral-latest']);
		assert.deepStrictEqual(agent.models.get().map(m => m.id), ['codestral-latest']);

		config.setShownModels([]);
		assert.deepStrictEqual(agent.models.get(), []);
	});

	test('offers no shown model without an API key', () => {
		const config = store.add(new TestRootConfigService());
		config.setShownModels(['mistral-large-latest']);
		const agent = createAgent(new FakeMistralApiService(), undefined, config);
		assert.deepStrictEqual(agent.models.get(), []);
	});

	test('authenticate with an empty token clears the key, reports unauthenticated and drops the models', async () => {
		const agent = createAgent(new FakeMistralApiService(async () => [model('devstral-2512', true)]));
		await agent.authenticate('', 'sk-test');
		assert.strictEqual(await agent.authenticate('', ''), false);
		assert.deepStrictEqual(agent.models.get(), []);
	});

	// ---- Chat lifecycle ----

	test('createChat is provisional, idempotent, and reports its project and metadata', async () => {
		const agent = createAgent(new FakeMistralApiService());
		const { session, chat } = newChat();

		const first = await agent.chats.createChat(chat, session, { workingDirectories: [cwd], model: { id: 'devstral-latest' } });
		assert.strictEqual(first?.provisional, true);
		assert.strictEqual(first?.project?.displayName, 'project');
		assert.deepStrictEqual(first?.resolvedWorkingDirectory, cwd);
		assert.ok(first?.providerData);

		const again = await agent.chats.createChat(chat, session, { workingDirectories: [URI.file('/elsewhere')] });
		assert.deepStrictEqual(again?.resolvedWorkingDirectory, cwd, 'a re-create keeps the existing chat');

		const metadata = await agent.getChatMetadata(chat, session);
		assert.deepStrictEqual(metadata?.workingDirectories, [cwd]);
		assert.deepStrictEqual(metadata?.model, { id: 'devstral-latest' });
		assert.strictEqual(agent.chats.getModel?.(chat, session)?.id, 'devstral-latest');
	});

	test('disposeChat forgets the chat', async () => {
		const agent = createAgent(new FakeMistralApiService());
		const { session, chat } = newChat();
		await agent.chats.createChat(chat, session, { workingDirectories: [cwd] });
		await agent.chats.disposeChat(chat, session);
		assert.strictEqual(await agent.getChatMetadata(chat, session), undefined);
	});

	// ---- Turn loop over the Conversations API ----

	test('the first send materializes the chat, streams the reply and persists the conversation id', async () => {
		const api = new FakeMistralApiService(async () => [model('devstral-latest', true)]);
		api.startEvents = [
			{ type: 'conversation.response.started', conversationId: 'conv-1' },
			{ type: 'message.output.delta', content: 'Hello', model: 'devstral-latest' },
			{ type: 'message.output.delta', content: ' world' },
			done(12, 3),
		];
		const agent = await authedAgent(api);
		const { signals, data } = watch(agent);
		const materialized: IAgentMaterializeChatEvent[] = [];
		store.add(agent.onDidMaterializeChat(e => materialized.push(e)));
		const { session, chat } = newChat();
		await agent.chats.createChat(chat, session, { workingDirectories: [cwd], model: { id: 'devstral-latest' } });

		await agent.chats.sendMessage(chat, 'hi', [cwd], undefined, 'turn-1');

		assert.strictEqual(materialized.length, 1);
		assert.strictEqual(materialized[0].chat.toString(), chat.toString());
		assert.deepStrictEqual(actionTypes(signals), [
			ActionType.ChatResponsePart,
			ActionType.ChatDelta,
			ActionType.ChatDelta,
			ActionType.ChatUsage,
			ActionType.ChatTurnComplete,
		]);
		assert.ok(signals.every(s => s.kind === 'action' && s.resource.toString() === chat.toString()), 'actions target the chat');
		assert.strictEqual(api.lastStartRequest.model, 'devstral-latest');
		assert.strictEqual(actionsOf(signals, ActionType.ChatDelta).map(a => a.content).join(''), 'Hello world');
		assert.deepStrictEqual(actionsOf(signals, ActionType.ChatUsage)[0].usage, { inputTokens: 12, outputTokens: 3, model: 'devstral-latest' });
		assert.ok(data.some(d => JSON.parse(d.providerData).conversationId === 'conv-1'), 'the conversation id is persisted');
	});

	test('thinking chunks surface as reasoning before assistant text', async () => {
		const api = new FakeMistralApiService(async () => [model('magistral-medium-latest', true)]);
		api.startEvents = [
			{ type: 'conversation.response.started', conversationId: 'conv-2' },
			{ type: 'message.output.delta', content: { type: 'thinking', thinking: [{ type: 'text', text: 'pondering' }] } },
			{ type: 'message.output.delta', content: { type: 'text', text: 'answer' } },
			done(),
		];
		const agent = await authedAgent(api);
		const { signals } = watch(agent);
		const { session, chat } = newChat();
		await agent.chats.createChat(chat, session, { workingDirectories: [cwd], model: { id: 'magistral-medium-latest' } });

		await agent.chats.sendMessage(chat, 'hi', [cwd], undefined, 'turn-1');

		assert.deepStrictEqual(actionTypes(signals), [
			ActionType.ChatResponsePart, // reasoning part
			ActionType.ChatReasoning,
			ActionType.ChatResponsePart, // markdown part
			ActionType.ChatDelta,
			ActionType.ChatUsage,
			ActionType.ChatTurnComplete,
		]);
		assert.strictEqual(actionsOf(signals, ActionType.ChatReasoning)[0].content, 'pondering');
	});

	test('a second turn appends to the conversation; a model change continues in a new one seeded with the history', async () => {
		const api = new FakeMistralApiService(async () => [model('devstral-latest', true), model('codestral-latest', true)]);
		api.startEvents = [{ type: 'conversation.response.started', conversationId: 'conv-9' }, { type: 'message.output.delta', content: 'one' }, done()];
		api.appendEvents = [{ type: 'conversation.response.started', conversationId: 'conv-9' }, { type: 'message.output.delta', content: 'two' }, done()];
		const agent = await authedAgent(api);
		const { session, chat } = newChat();
		await agent.chats.createChat(chat, session, { workingDirectories: [cwd], model: { id: 'devstral-latest' } });

		await agent.chats.sendMessage(chat, 'first', [cwd], undefined, 'turn-1');
		await agent.chats.sendMessage(chat, 'second', [cwd], undefined, 'turn-2');
		assert.strictEqual(api.lastAppend?.conversationId, 'conv-9', 'the second turn appends to conv-9');
		assert.strictEqual(api.lastAppend?.request.inputs, 'second');

		api.history = {
			entries: [
				{ type: 'message.input', id: 'e1', role: 'user', content: 'first' },
				{ type: 'message.output', id: 'e2', role: 'assistant', content: 'one', model: 'devstral-latest' },
			]
		};
		api.startEvents = [{ type: 'conversation.response.started', conversationId: 'conv-10' }, { type: 'message.output.delta', content: 'three' }, done()];
		await agent.chats.changeModel(chat, { id: 'codestral-latest' }, session);
		await agent.chats.sendMessage(chat, 'third', [cwd], undefined, 'turn-3');

		assert.strictEqual(api.lastStartRequest.model, 'codestral-latest');
		assert.deepStrictEqual(api.lastStartRequest.inputs, [
			{ type: 'message.input', role: 'user', content: 'first' },
			{ type: 'message.output', role: 'assistant', content: 'one' },
			{ type: 'message.input', role: 'user', content: 'third' },
		]);
		const metadata = await agent.getChatMetadata(chat, session);
		assert.deepStrictEqual(metadata?.model, { id: 'codestral-latest' });
	});

	test('a conversation error event surfaces as a chat error without completing the turn', async () => {
		const api = new FakeMistralApiService(async () => [model('devstral-latest', true)]);
		api.startEvents = [
			{ type: 'conversation.response.started', conversationId: 'conv-e' },
			{ type: 'conversation.response.error', code: 400, message: 'bad request' },
		];
		const agent = await authedAgent(api);
		const { signals } = watch(agent);
		const { session, chat } = newChat();
		await agent.chats.createChat(chat, session, { workingDirectories: [cwd], model: { id: 'devstral-latest' } });

		await agent.chats.sendMessage(chat, 'hi', [cwd], undefined, 'turn-1');

		const [error] = actionsOf(signals, ActionType.ChatError);
		assert.strictEqual(error?.part.error.message, 'bad request');
		assert.ok(!actionTypes(signals).includes(ActionType.ChatTurnComplete), 'no turnComplete after an error');
	});

	test('without an API key a turn fails fast with an error', async () => {
		const agent = createAgent(new FakeMistralApiService());
		const { signals } = watch(agent);
		const { session, chat } = newChat();
		await agent.chats.createChat(chat, session, { workingDirectories: [cwd] });

		await agent.chats.sendMessage(chat, 'hi', [cwd], undefined, 'turn-1');

		assert.strictEqual(actionsOf(signals, ActionType.ChatError)[0]?.part.error.errorType, 'AuthError');
	});

	// ---- Tools ----

	test('a read-only tool runs without approval and its result is fed back to continue the turn', async () => {
		const api = new FakeMistralApiService(async () => [model('devstral-latest', true)]);
		api.startEvents = [
			{ type: 'conversation.response.started', conversationId: 'conv-t' },
			{ type: 'function.call.delta', toolCallId: 'tc1', name: 'list_dir', arguments: '{"path":' },
			{ type: 'function.call.delta', toolCallId: 'tc1', name: 'list_dir', arguments: '"."}' },
			done(),
		];
		api.appendEvents = [{ type: 'message.output.delta', content: 'done' }, done()];
		const agent = await authedAgent(api);
		const { signals } = watch(agent);
		const { session, chat } = newChat();
		const tmp = URI.file(os.tmpdir());
		await agent.chats.createChat(chat, session, { workingDirectories: [tmp], model: { id: 'devstral-latest' } });

		await agent.chats.sendMessage(chat, 'list files', [tmp], undefined, 'turn-1');

		assert.deepStrictEqual(actionTypes(signals), [
			ActionType.ChatToolCallStart,
			ActionType.ChatUsage,
			ActionType.ChatToolCallReady,
			ActionType.ChatToolCallComplete,
			ActionType.ChatResponsePart,
			ActionType.ChatDelta,
			ActionType.ChatUsage,
			ActionType.ChatTurnComplete,
		]);
		assert.ok(!signals.some(s => s.kind === 'pending_confirmation'), 'read-only tools should not prompt');
		assert.strictEqual(actionsOf(signals, ActionType.ChatToolCallComplete)[0].result.success, true);
		assert.strictEqual(actionsOf(signals, ActionType.ChatToolCallReady)[0].toolInput, '{"path":"."}', 'streamed arguments are joined');
		assert.strictEqual(api.lastAppend?.conversationId, 'conv-t');
		assert.strictEqual(api.lastAppend?.request.inputs[0].toolCallId, 'tc1');
	});

	function bashCallScript() {
		const api = new FakeMistralApiService(async () => [model('devstral-latest', true)]);
		api.startEvents = [
			{ type: 'conversation.response.started', conversationId: 'conv-p' },
			{ type: 'function.call.delta', toolCallId: 'tcp', name: 'run_bash', arguments: JSON.stringify({ command: 'echo ok' }) },
			done(),
		];
		api.appendEvents = [{ type: 'message.output.delta', content: 'fin' }, done()];
		return api;
	}

	async function bashChat(api: FakeMistralApiService) {
		const agent = await authedAgent(api);
		const watched = watch(agent);
		const { session, chat } = newChat();
		const tmp = URI.file(os.tmpdir());
		await agent.chats.createChat(chat, session, { workingDirectories: [tmp], model: { id: 'devstral-latest' } });
		const send = agent.chats.sendMessage(chat, 'run', [tmp], undefined, 'turn-1');
		return { agent, ...watched, session, chat, send };
	}

	test('a mutating tool asks the host for approval and runs once approved', async () => {
		const api = bashCallScript();
		const { agent, signals, pending, chat, send } = await bashChat(api);

		const pc = await pending;
		assert.strictEqual(pc.chat.toString(), chat.toString());
		assert.strictEqual(pc.state.toolCallId, 'tcp');
		assert.strictEqual(pc.state.status, ToolCallStatus.PendingConfirmation);
		assert.strictEqual(pc.state.toolInput, 'echo ok', 'the bare command, for terminal approval rules');
		assert.strictEqual(pc.permissionKind, 'shell');
		assert.strictEqual(pc.shellLanguage, isWindows ? undefined : 'bash');
		assert.ok(!actionTypes(signals).includes(ActionType.ChatToolCallComplete), 'not executed before approval');
		const appendBefore = api.lastAppend; // copy so the assertion doesn't narrow the field
		assert.strictEqual(appendBefore, undefined, 'no append before approval');

		agent.respondToPermissionRequest('tcp', true);
		await send;

		assert.strictEqual(actionsOf(signals, ActionType.ChatToolCallComplete)[0].result.success, true);
		assert.match(String(api.lastAppend?.request?.inputs?.[0]?.result ?? ''), /ok/);
		assert.ok(actionTypes(signals).includes(ActionType.ChatTurnComplete));
	});

	test('a denied mutating tool is not executed and the denial is fed back', async () => {
		const api = bashCallScript();
		const { agent, signals, pending, send } = await bashChat(api);

		await pending;
		agent.respondToPermissionRequest('tcp', false);
		await send;

		assert.strictEqual(actionsOf(signals, ActionType.ChatToolCallComplete)[0].result.success, false);
		assert.match(String(api.lastAppend?.request?.inputs?.[0]?.result ?? ''), /denied/i);
	});

	test('abort unblocks a pending approval and ends the turn without further actions', async () => {
		const api = bashCallScript();
		const { agent, signals, pending, session, chat, send } = await bashChat(api);

		await pending;
		await agent.chats.abort(chat, session);
		await send; // must not hang

		assert.strictEqual(api.lastAppend, undefined, 'nothing is sent after an abort');
		assert.ok(!actionTypes(signals).includes(ActionType.ChatTurnComplete), 'the host records the cancellation');
	});

	// ---- Restore ----

	test('materializeChat restores a chat whose history is rebuilt from the conversation', async () => {
		const api = new FakeMistralApiService(async () => [model('devstral-latest', true)]);
		api.history = {
			entries: [
				{ type: 'message.input', id: 'u1', role: 'user', content: 'list files' },
				{ type: 'function.call', toolCallId: 'tc1', name: 'list_dir', arguments: '{"path":"."}' },
				{ type: 'function.result', toolCallId: 'tc1', result: 'a.ts\nb.ts' },
				{ type: 'message.output', role: 'assistant', content: 'Two files.' },
				{ type: 'message.input', id: 'u2', role: 'user', content: 'thanks' },
				{ type: 'message.output', role: 'assistant', content: [{ type: 'text', text: 'You are welcome.' }] },
			]
		};
		const agent = await authedAgent(api);
		const { session, chat } = newChat();
		const providerData = JSON.stringify({ conversationId: 'conv-r', conversationModel: 'devstral-latest', model: { id: 'devstral-latest' }, workingDirectory: cwd.toString(), createdAt: 1000, modifiedAt: 2000 });

		const restored = await agent.materializeChat(chat, session, providerData);
		assert.ok(restored && !restored.provisional);

		const turns = await agent.chats.getMessages(chat, session);
		assert.deepStrictEqual(turns.map(t => [t.id, t.message.text]), [['u1', 'list files'], ['u2', 'thanks']]);
		const partKinds = (parts: readonly ResponsePart[]) => parts.map(p => p.kind);
		assert.deepStrictEqual(partKinds(turns[0].responseParts), [ResponsePartKind.ToolCall, ResponsePartKind.Markdown]);
		const toolPart = turns[0].responseParts[0];
		assert.ok(toolPart.kind === ResponsePartKind.ToolCall && toolPart.toolCall.status === ToolCallStatus.Completed && toolPart.toolCall.success);

		const metadata = await agent.getChatMetadata(chat, session);
		assert.strictEqual(metadata?.startTime, 1000);
		assert.strictEqual(metadata?.modifiedTime, 2000);

		// The restored chat continues its conversation.
		api.appendEvents = [{ type: 'message.output.delta', content: 'again' }, done()];
		await agent.chats.sendMessage(chat, 'more', [cwd], undefined, 'turn-3');
		assert.strictEqual(api.lastAppend?.conversationId, 'conv-r');
	});

	test('recoverLegacyChat reads a pre-1.141 chat from the session database', async () => {
		const database = store.add(new TestSessionDatabase());
		await database.setMetadata('mistral.conversationId', 'conv-legacy');
		await database.setMetadata('mistral.model', JSON.stringify({ id: 'devstral-latest' }));
		await database.setMetadata('mistral.workingDirectory', cwd.toString());
		await database.setMetadata('mistral.createdAt', '1234');
		const api = new FakeMistralApiService(async () => [model('devstral-latest', true)]);
		const agent = createAgent(api, createSessionDataService(database));
		await agent.authenticate('', 'sk-test');
		const { session, chat } = newChat();

		const recovered = await agent.recoverLegacyChat(chat, session);
		assert.strictEqual(recovered && JSON.parse(recovered.providerData!).conversationId, 'conv-legacy');

		api.appendEvents = [{ type: 'message.output.delta', content: 'hi' }, done()];
		await agent.chats.sendMessage(chat, 'hello', [cwd], undefined, 'turn-1');
		assert.strictEqual(api.lastAppend?.conversationId, 'conv-legacy');
		assert.strictEqual((await agent.getChatMetadata(chat, session))?.startTime, 1234);
	});
});
