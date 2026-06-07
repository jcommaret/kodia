/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as os from 'os';
import { IReference } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { AgentHostMistralApiKeyEnvVar, AgentSession } from '../../common/agentService.js';
import { ISessionDatabase, ISessionDataService } from '../../common/sessionDataService.js';
import { MistralAgent } from '../../node/mistral/mistralAgent.js';
import { IMistralApiService, IMistralModel } from '../../node/mistral/mistralApiService.js';

/** Wrap a list of conversation-event payloads in an async-iterable stream. */
function makeStream(events: ReadonlyArray<unknown>): any {
	return {
		async *[Symbol.asyncIterator]() {
			for (const data of events) { yield { event: 'message', data }; }
		},
	};
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
	lastStartRequest: any;
	lastAppend: { conversationId: string; request: any } | undefined;

	constructor(private readonly _models: () => Promise<IMistralModel[]> = async () => []) { }
	models(): Promise<IMistralModel[]> { return this._models(); }
	async startConversationStream(_apiKey: string, request: any): Promise<any> {
		this.lastStartRequest = request;
		return makeStream(this.startEvents);
	}
	async appendConversationStream(_apiKey: string, conversationId: string, request: any): Promise<any> {
		this.lastAppend = { conversationId, request };
		return makeStream(this.appendEvents);
	}
	getConversationHistory(): never { throw new Error('not used'); }
}

/** In-memory {@link ISessionDataService} capturing per-session metadata writes. */
class FakeSessionDataService implements ISessionDataService {
	declare readonly _serviceBrand: undefined;
	/** `${sessionId}::${key}` -> value */
	readonly metadata = new Map<string, string>();
	idleCount = 0;

	getSessionDataDir(session: URI): URI { return session; }
	getSessionDataDirById(sessionId: string): URI { return URI.parse(`mistral:/${sessionId}`); }
	openDatabase(session: URI): IReference<ISessionDatabase> {
		const id = AgentSession.id(session);
		const db = {
			setMetadata: async (key: string, value: string) => { this.metadata.set(`${id}::${key}`, value); },
			getMetadata: async (key: string) => this.metadata.get(`${id}::${key}`),
		} as unknown as ISessionDatabase;
		return { object: db, dispose: () => { } };
	}
	tryOpenDatabase(): Promise<IReference<ISessionDatabase> | undefined> { return Promise.resolve(undefined); }
	deleteSessionData(): Promise<void> { return Promise.resolve(); }
	cleanupOrphanedData(): Promise<void> { return Promise.resolve(); }
	whenIdle(): Promise<void> { this.idleCount++; return Promise.resolve(); }
}

/** Exposes the protected materialize hook (driven by `sendMessage` from Phase 4). */
class TestMistralAgent extends MistralAgent {
	materialize(sessionId: string) { return this._materializeProvisional(sessionId); }
}

function model(id: string, supportsFunctionCalling: boolean, extra?: Partial<IMistralModel>): IMistralModel {
	return { id, name: id, maxContextWindow: 128_000, supportsFunctionCalling, supportsVision: false, ...extra };
}

suite('MistralAgent', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	// The agent reads the API key from the gate env var in its constructor.
	// Keep it unset so the constructor's fire-and-forget refresh no-ops and
	// each test drives the (awaitable) refresh through `authenticate`.
	let savedEnv: string | undefined;
	setup(() => { savedEnv = process.env[AgentHostMistralApiKeyEnvVar]; delete process.env[AgentHostMistralApiKeyEnvVar]; });
	teardown(() => { if (savedEnv === undefined) { delete process.env[AgentHostMistralApiKeyEnvVar]; } else { process.env[AgentHostMistralApiKeyEnvVar] = savedEnv; } });

	function createAgent(api: IMistralApiService, data: ISessionDataService = new FakeSessionDataService()): MistralAgent {
		return store.add(new MistralAgent(new NullLogService(), api, data));
	}

	function createTestAgent(data: ISessionDataService): TestMistralAgent {
		return store.add(new TestMistralAgent(new NullLogService(), new FakeMistralApiService(), data));
	}

	test('seeds a non-empty, tool-capable model list before any API call', () => {
		const agent = createAgent(new FakeMistralApiService(async () => []));
		const seeded = agent.models.get();
		assert.ok(seeded.length > 0, 'expected a non-empty seed list');
		assert.ok(seeded.every(m => m.provider === 'mistral'));
		assert.ok(seeded.some(m => m.id === 'devstral-latest'));
	});

	test('authenticate replaces seed with the real catalog, filtered to function calling', async () => {
		const agent = createAgent(new FakeMistralApiService(async () => [
			model('devstral-2512', true),
			model('mistral-embed', false), // no function calling -> filtered out
			model('mistral-large-2512', true, { supportsVision: true, maxContextWindow: 256_000 }),
		]));

		const ok = await agent.authenticate('', 'sk-test');
		assert.strictEqual(ok, true);

		const models = agent.models.get();
		assert.deepStrictEqual(models.map(m => m.id).sort(), ['devstral-2512', 'mistral-large-2512']);
		const large = models.find(m => m.id === 'mistral-large-2512')!;
		assert.strictEqual(large.supportsVision, true);
		assert.strictEqual(large.maxContextWindow, 256_000);
		assert.ok(models.every(m => m.provider === 'mistral'));
	});

	test('keeps the seed list when the catalog has no tool-capable models', async () => {
		const agent = createAgent(new FakeMistralApiService(async () => [model('mistral-embed', false)]));
		const seeded = agent.models.get();
		await agent.authenticate('', 'sk-test');
		assert.deepStrictEqual(agent.models.get(), seeded, 'expected the seed list to be retained');
	});

	test('keeps the seed list when the catalog fetch fails', async () => {
		const agent = createAgent(new FakeMistralApiService(async () => { throw new Error('network'); }));
		const seeded = agent.models.get();
		const ok = await agent.authenticate('', 'sk-test');
		assert.strictEqual(ok, true, 'authenticate should still succeed despite a model-fetch failure');
		assert.deepStrictEqual(agent.models.get(), seeded);
	});

	test('authenticate with an empty token clears the key and reports unauthenticated', async () => {
		const agent = createAgent(new FakeMistralApiService(async () => [model('devstral-2512', true)]));
		await agent.authenticate('', 'sk-test');
		const ok = await agent.authenticate('', '');
		assert.strictEqual(ok, false);
	});

	// ---- Session lifecycle (Phase 3) ----

	const cwd = URI.file('/work/project');

	test('createSession returns a provisional mistral-scheme session without persisting', async () => {
		const data = new FakeSessionDataService();
		const agent = createAgent(new FakeMistralApiService(), data);

		const result = await agent.createSession({ workingDirectory: cwd });
		assert.strictEqual(result.provisional, true);
		assert.strictEqual(result.session.scheme, 'mistral');
		assert.deepStrictEqual(result.workingDirectory, cwd);
		assert.strictEqual(result.project?.displayName, 'project');
		// Provisional sessions are invisible and untouched on disk.
		assert.deepStrictEqual(await agent.listSessions(), []);
		assert.strictEqual(data.metadata.size, 0);
	});

	test('createSession is idempotent for a given session id', async () => {
		const agent = createAgent(new FakeMistralApiService());
		const first = await agent.createSession({ workingDirectory: cwd });
		const second = await agent.createSession({ session: first.session, workingDirectory: cwd });
		assert.strictEqual(second.session.toString(), first.session.toString());
	});

	test('materialize promotes a provisional session, persists its mapping, and lists it', async () => {
		const data = new FakeSessionDataService();
		const agent = createTestAgent(data);

		const created = await agent.createSession({ workingDirectory: cwd, model: { id: 'devstral-latest' } });
		const sessionId = AgentSession.id(created.session);

		let materializedEvent: URI | undefined;
		store.add(agent.onDidMaterializeSession(e => { materializedEvent = e.session; }));

		await agent.materialize(sessionId);

		assert.strictEqual(materializedEvent?.toString(), created.session.toString(), 'onDidMaterializeSession should fire');

		const listed = await agent.listSessions();
		assert.strictEqual(listed.length, 1);
		assert.strictEqual(listed[0].session.toString(), created.session.toString());
		assert.deepStrictEqual(listed[0].workingDirectory, cwd);

		// Durable mapping persisted for Phase 6 restoration.
		assert.strictEqual(data.metadata.get(`${sessionId}::mistral.workingDirectory`), cwd.toString());
		assert.strictEqual(data.metadata.get(`${sessionId}::mistral.model`), JSON.stringify({ id: 'devstral-latest' }));
		assert.ok(data.metadata.has(`${sessionId}::mistral.createdAt`));
	});

	test('disposeSession removes a materialized session from the list', async () => {
		const agent = createTestAgent(new FakeSessionDataService());
		const created = await agent.createSession({ workingDirectory: cwd });
		const sessionId = AgentSession.id(created.session);
		await agent.materialize(sessionId);
		assert.strictEqual((await agent.listSessions()).length, 1);

		await agent.disposeSession(created.session);
		assert.deepStrictEqual(await agent.listSessions(), []);
	});

	test('shutdown drains live sessions and awaits persistence idle', async () => {
		const data = new FakeSessionDataService();
		const agent = createTestAgent(data);
		const created = await agent.createSession({ workingDirectory: cwd });
		await agent.materialize(AgentSession.id(created.session));

		await agent.shutdown();
		assert.deepStrictEqual(await agent.listSessions(), []);
		assert.ok(data.idleCount >= 1, 'shutdown should await whenIdle');
	});

	// ---- Turn loop over the Conversations API (Phase 4) ----

	async function authedAgent(api: FakeMistralApiService, data = new FakeSessionDataService()) {
		const agent = createAgent(api, data);
		await agent.authenticate('', 'sk-test');
		return agent;
	}

	test('sendMessage emits a turn of protocol actions and persists the conversation id', async () => {
		const api = new FakeMistralApiService(async () => [model('devstral-latest', true)]);
		api.startEvents = [
			{ type: 'conversation.response.started', conversationId: 'conv-1' },
			{ type: 'message.output.delta', content: 'Hello' },
			{ type: 'message.output.delta', content: ' world' },
			{ type: 'conversation.response.done', usage: {} },
		];
		const data = new FakeSessionDataService();
		const agent = await authedAgent(api, data);

		const signals: any[] = [];
		store.add(agent.onDidSessionProgress(s => signals.push(s)));

		const created = await agent.createSession({ workingDirectory: cwd, model: { id: 'devstral-latest' } });
		await agent.sendMessage(created.session, 'hi');

		assert.deepStrictEqual(signals.map(s => s.action.type), [
			'session/turnStarted',
			'session/responsePart',
			'session/delta',
			'session/delta',
			'session/turnComplete',
		]);
		// The signal's top-level session is the rich URI; the action carries the string form.
		assert.strictEqual(signals[0].session.toString(), created.session.toString());
		assert.strictEqual(api.lastStartRequest.model, 'devstral-latest');
		const text = signals.filter(s => s.action.type === 'session/delta').map(s => s.action.content).join('');
		assert.strictEqual(text, 'Hello world');
		assert.strictEqual(data.metadata.get(`${AgentSession.id(created.session)}::mistral.conversationId`), 'conv-1');
	});

	test('thinking chunks surface as reasoning before assistant text', async () => {
		const api = new FakeMistralApiService(async () => [model('magistral-medium-latest', true)]);
		api.startEvents = [
			{ type: 'conversation.response.started', conversationId: 'conv-2' },
			{ type: 'message.output.delta', content: { type: 'thinking', thinking: [{ type: 'text', text: 'pondering' }] } },
			{ type: 'message.output.delta', content: { type: 'text', text: 'answer' } },
			{ type: 'conversation.response.done', usage: {} },
		];
		const agent = await authedAgent(api);
		const signals: any[] = [];
		store.add(agent.onDidSessionProgress(s => signals.push(s)));

		const created = await agent.createSession({ workingDirectory: cwd, model: { id: 'magistral-medium-latest' } });
		await agent.sendMessage(created.session, 'hi');

		assert.deepStrictEqual(signals.map(s => s.action.type), [
			'session/turnStarted',
			'session/responsePart', // reasoning part
			'session/reasoning',
			'session/responsePart', // markdown part
			'session/delta',
			'session/turnComplete',
		]);
		const reasoning = signals.find(s => s.action.type === 'session/reasoning');
		assert.strictEqual(reasoning.action.content, 'pondering');
	});

	test('a second turn appends to the existing conversation instead of starting a new one', async () => {
		const api = new FakeMistralApiService(async () => [model('devstral-latest', true)]);
		api.startEvents = [
			{ type: 'conversation.response.started', conversationId: 'conv-9' },
			{ type: 'message.output.delta', content: 'one' },
			{ type: 'conversation.response.done', usage: {} },
		];
		api.appendEvents = [
			{ type: 'message.output.delta', content: 'two' },
			{ type: 'conversation.response.done', usage: {} },
		];
		const agent = await authedAgent(api);
		const created = await agent.createSession({ workingDirectory: cwd, model: { id: 'devstral-latest' } });

		await agent.sendMessage(created.session, 'first');
		await agent.sendMessage(created.session, 'second');

		assert.strictEqual(api.lastAppend?.conversationId, 'conv-9', 'second turn should append to conv-9');
	});

	test('a conversation error event surfaces as a session error action', async () => {
		const api = new FakeMistralApiService(async () => [model('devstral-latest', true)]);
		api.startEvents = [
			{ type: 'conversation.response.started', conversationId: 'conv-e' },
			{ type: 'conversation.response.error', code: 429, message: 'rate limited' },
		];
		const agent = await authedAgent(api);
		const signals: any[] = [];
		store.add(agent.onDidSessionProgress(s => signals.push(s)));

		const created = await agent.createSession({ workingDirectory: cwd, model: { id: 'devstral-latest' } });
		await agent.sendMessage(created.session, 'hi');

		const error = signals.find(s => s.action.type === 'session/error');
		assert.ok(error, 'expected a session/error action');
		assert.strictEqual(error.action.error.message, 'rate limited');
		assert.ok(!signals.some(s => s.action.type === 'session/turnComplete'), 'no turnComplete after an error');
	});

	// ---- Tool execution loop (Phase 5) ----

	test('a read-only tool runs without approval and its result is fed back to continue the turn', async () => {
		const api = new FakeMistralApiService(async () => [model('devstral-latest', true)]);
		// `list_dir` is read-only, so it auto-confirms and executes without an
		// approval round-trip (the mutating + approval path is covered below).
		api.startEvents = [
			{ type: 'conversation.response.started', conversationId: 'conv-t' },
			{ type: 'function.call.delta', toolCallId: 'tc1', name: 'list_dir', arguments: JSON.stringify({ path: '.' }) },
			{ type: 'conversation.response.done', usage: {} },
		];
		api.appendEvents = [
			{ type: 'message.output.delta', content: 'done' },
			{ type: 'conversation.response.done', usage: {} },
		];
		const agent = await authedAgent(api);
		const signals: any[] = [];
		store.add(agent.onDidSessionProgress(s => signals.push(s)));

		// A real working directory so `list_dir` resolves against a valid path.
		const created = await agent.createSession({ workingDirectory: URI.file(os.tmpdir()), model: { id: 'devstral-latest' } });
		await agent.sendMessage(created.session, 'list files');

		assert.deepStrictEqual(signals.map(s => s.action.type), [
			'session/turnStarted',
			'session/toolCallStart',
			'session/toolCallReady',
			'session/toolCallComplete',
			'session/responsePart',
			'session/delta',
			'session/turnComplete',
		]);
		assert.ok(!signals.some(s => s.kind === 'pending_confirmation'), 'read-only tools should not prompt');

		const complete = signals.find(s => s.action?.type === 'session/toolCallComplete');
		assert.strictEqual(complete.action.result.success, true);

		// The tool result was appended back into the conversation to continue it.
		assert.strictEqual(api.lastAppend?.conversationId, 'conv-t');
		assert.strictEqual(api.lastAppend?.request.inputs[0].toolCallId, 'tc1');
	});

	// ---- Interactive permissions + controls (Phase 6) ----

	/** Subscribe, collecting signals and exposing a promise for the first pending_confirmation. */
	function watch(agent: MistralAgent) {
		const signals: any[] = [];
		let onPending: (s: any) => void;
		const pending = new Promise<any>(res => { onPending = res; });
		store.add(agent.onDidSessionProgress(s => { signals.push(s); if (s.kind === 'pending_confirmation') { onPending(s); } }));
		return { signals, pending };
	}

	function bashCallScript() {
		const api = new FakeMistralApiService(async () => [model('devstral-latest', true)]);
		api.startEvents = [
			{ type: 'conversation.response.started', conversationId: 'conv-p' },
			{ type: 'function.call.delta', toolCallId: 'tcp', name: 'run_bash', arguments: JSON.stringify({ command: 'echo ok' }) },
			{ type: 'conversation.response.done', usage: {} },
		];
		api.appendEvents = [{ type: 'message.output.delta', content: 'fin' }, { type: 'conversation.response.done', usage: {} }];
		return api;
	}

	test('a mutating tool waits for approval and runs once approved', async () => {
		const api = bashCallScript();
		const agent = await authedAgent(api);
		const { signals, pending } = watch(agent);
		const created = await agent.createSession({ workingDirectory: URI.file(os.tmpdir()), model: { id: 'devstral-latest' } });

		const sendP = agent.sendMessage(created.session, 'run');
		const pc = await pending; // a pending_confirmation was emitted...
		assert.strictEqual(pc.state.toolCallId, 'tcp');
		assert.strictEqual(pc.permissionKind, 'shell');
		// ...and we should NOT have executed yet (no complete, no append).
		assert.ok(!signals.some(s => s.action?.type === 'session/toolCallComplete'));
		const appendBefore = api.lastAppend; // copy so the assertion doesn't narrow the field
		assert.strictEqual(appendBefore, undefined, 'no append before approval');

		agent.respondToPermissionRequest('tcp', true);
		await sendP;

		const complete = signals.find(s => s.action?.type === 'session/toolCallComplete');
		assert.strictEqual(complete.action.result.success, true);
		const fedBack = String(api.lastAppend?.request?.inputs?.[0]?.result ?? '');
		assert.match(fedBack, /ok/);
	});

	test('a denied mutating tool is not executed and the denial is fed back', async () => {
		const api = bashCallScript();
		const agent = await authedAgent(api);
		const { signals, pending } = watch(agent);
		const created = await agent.createSession({ workingDirectory: URI.file(os.tmpdir()), model: { id: 'devstral-latest' } });

		const sendP = agent.sendMessage(created.session, 'run');
		await pending;
		agent.respondToPermissionRequest('tcp', false);
		await sendP;

		const complete = signals.find(s => s.action?.type === 'session/toolCallComplete');
		assert.strictEqual(complete.action.result.success, false);
		const fedBack = String(api.lastAppend?.request?.inputs?.[0]?.result ?? '');
		assert.match(fedBack, /denied/i);
	});

	test('abortSession unblocks a pending tool approval', async () => {
		const api = bashCallScript();
		const agent = await authedAgent(api);
		const { pending } = watch(agent);
		const created = await agent.createSession({ workingDirectory: URI.file(os.tmpdir()), model: { id: 'devstral-latest' } });

		const sendP = agent.sendMessage(created.session, 'run');
		await pending;
		await agent.abortSession(created.session); // should resolve the approval wait as denied
		await sendP; // must not hang
		const fedBack = String(api.lastAppend?.request?.inputs?.[0]?.result ?? '');
		assert.match(fedBack, /denied/i);
	});

	test('changeModel updates and persists the session model', async () => {
		const data = new FakeSessionDataService();
		const agent = createTestAgent(data);
		const created = await agent.createSession({ workingDirectory: cwd, model: { id: 'devstral-latest' } });
		const sessionId = AgentSession.id(created.session);
		await agent.materialize(sessionId);

		await agent.changeModel(created.session, { id: 'codestral-latest' });
		assert.strictEqual(data.metadata.get(`${sessionId}::mistral.model`), JSON.stringify({ id: 'codestral-latest' }));
	});
});
