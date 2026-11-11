/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { join } from '../../../../base/common/path.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import type { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { FileService } from '../../../files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../log/common/log.js';
import { AgentSession, type AgentSignal, type IAgentActionSignal, type IAgentChatDataChange, type IAgentToolPendingConfirmationSignal } from '../../common/agent.js';
import type { IByokLmBridgeConnection, IByokLmChatRequest, IByokLmChatResult, IByokLmModelInfo, IKodiaMcpTool, IKodiaMcpToolResult } from '../../common/agentHostByokLm.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { buildDefaultChatUri, ResponsePartKind } from '../../common/state/sessionState.js';
import type { IByokLmBridgeRegistry } from '../../node/byokLmBridgeRegistry.js';
import { KodiaAgent } from '../../node/kodia/kodiaAgent.js';
import { CLEARED_TOOL_RESULT, summarizedThreadMessage, summarizeThread_systemMessage } from '../../../kodia/common/threadSummary.js';

/** A Kodia window: replays scripted results and records each request and its token. */
class FakeKodiaWindow implements IByokLmBridgeConnection {
	readonly onDidChangeModels: Event<IByokLmModelInfo[]> = Event.None;
	readonly requests: IByokLmChatRequest[] = [];
	readonly tokens: CancellationToken[] = [];
	results: IByokLmChatResult[] = [];
	/** When set, the next request waits for it instead of answering. */
	pending: Promise<IByokLmChatResult> | undefined;
	/** The window's MCP servers; undefined for a window that doesn't offer MCP tools. */
	mcp: { tools: IKodiaMcpTool[]; result: IKodiaMcpToolResult; calls: { name: string; argsJson: string }[]; listError?: Error } | undefined;

	get listMcpTools() {
		const mcp = this.mcp;
		return mcp && (async () => { if (mcp.listError) { throw mcp.listError; } return mcp.tools; });
	}

	get callMcpTool() {
		const mcp = this.mcp;
		return mcp && (async (name: string, argsJson: string) => { mcp.calls.push({ name, argsJson }); return mcp.result; });
	}

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

	const userHome = URI.file('/home/me');

	function createAgent(registry = new FakeBridgeRegistry()): { agent: KodiaAgent; registry: FakeBridgeRegistry; write: (path: string, content: string) => Promise<void> } {
		registry.models = [gemini, openRouter];
		// the agent reads the project's rules and skills through the file service, here an in-memory disk
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider('file', store.add(new InMemoryFileSystemProvider())));
		const environmentService = { userHome } as INativeEnvironmentService;
		const write = async (path: string, content: string) => { await fileService.writeFile(URI.file(path), VSBuffer.fromString(content)); };
		return { agent: store.add(new KodiaAgent(new NullLogService(), registry, fileService, environmentService)), registry, write };
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
		assert.deepStrictEqual(request.tools?.map(t => t.name), ['read_file', 'ls_dir', 'get_dir_tree', 'search_pathnames_only', 'search_for_files', 'search_in_file', 'create_file_or_folder', 'delete_file_or_folder', 'edit_file', 'rewrite_file', 'run_command', 'fetch_url', 'write_project_memory']);
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

	test('tells the model the project\'s rules and skills, as Kodia\'s chat does', async () => {
		const { agent, registry, write } = createAgent();
		registry.window!.results = [text('Done.')];
		const project = URI.file('/project');
		await write('/project/AGENTS.md', 'Answer in French.');
		await write('/project/CLAUDE.md', 'Answer in French.');
		await write('/project/.cursorrules', 'Use tabs.');
		await write('/project/.agents/skills/tdd/SKILL.md', '---\nname: tdd\ndescription: Use when writing tests first.\n---\nRed, green, refactor.');
		await write('/project/.claude/skills/tdd/SKILL.md', '---\nname: tdd\ndescription: A copy of the same skill.\n---\n');
		await write('/project/.claude/skills/release/SKILL.md', '---\nname: release\ndescription: Only for the user to run.\ndisable-model-invocation: true\n---\n');
		await write('/home/me/.claude/skills/review/SKILL.md', '---\nname: review\ndescription: Use when reviewing a diff.\n---\n');
		await write('/project/.kodia/memory.md', '<!-- notes -->\n\n## Commands\nnpm run test-void');
		const { chat, session } = newChat();
		await agent.chats.createChat(chat, session, { workingDirectories: [project] });

		await agent.chats.sendMessage(chat, 'Hi', [project], undefined, 'turn-1');

		const instructions = registry.window!.requests[0].instructions ?? '';
		assert.ok(instructions.startsWith('You are a coding agent.'), 'the agent\'s own instructions come first');
		assert.ok(instructions.includes('PROJECT RULES (from the project\'s rules files):\nFrom AGENTS.md:\nAnswer in French.\n\nFrom .cursorrules:\nUse tabs.'), instructions);
		assert.ok(!instructions.includes('From CLAUDE.md'), 'a copy of an earlier rules file is left out');
		assert.ok(instructions.indexOf('PROJECT RULES') < instructions.indexOf('SKILLS ('), 'the rules come before the skills');
		const skillNames = [...instructions.matchAll(/<name>(.*)<\/name>/g)].map(m => m[1]);
		assert.deepStrictEqual(skillNames, ['tdd', 'review'], 'the project\'s skills, then the user\'s, each once, without the one only the user may run');
		assert.ok(instructions.includes('<description>Use when writing tests first.</description>'), 'the first folder\'s copy is the one listed');
		assert.ok(instructions.includes('<file>/project/.agents/skills/tdd/SKILL.md</file>'), instructions);
		// the project's memory comes last, as in the chat, and the model isn't told to read it with a tool
		assert.ok(instructions.includes('PROJECT MEMORY (.kodia/memory.md: notes kept across sessions; rewrite a section with write_project_memory when something here is outdated or worth adding):\n<!-- notes -->\n\n## Commands\nnpm run test-void'), instructions);
		assert.ok(instructions.indexOf('SKILLS (') < instructions.indexOf('PROJECT MEMORY'), 'the skills come before the memory');
		assert.ok(!instructions.includes('read_project_memory'));
	});

	test('a project without rules or skills adds nothing to the agent\'s instructions', async () => {
		const { agent, registry } = createAgent();
		registry.window!.results = [text('Done.')];
		const project = URI.file('/empty');
		const { chat, session } = newChat();
		await agent.chats.createChat(chat, session, { workingDirectories: [project] });

		await agent.chats.sendMessage(chat, 'Hi', [project], undefined, 'turn-1');

		const instructions = registry.window!.requests[0].instructions ?? '';
		assert.ok(!instructions.includes('PROJECT RULES') && !instructions.includes('SKILLS (') && !instructions.includes('PROJECT MEMORY'), instructions);
	});

	test('reads the rules and skills once a turn, not at each round of tool calls', async () => {
		const { agent, registry, write } = createAgent();
		registry.window!.results = [
			{ output: [{ type: 'function_call', callId: 'call-1', name: 'ls_dir', argumentsJson: '{}' }] },
			text('Done.'),
		];
		const project = URI.file('/project');
		await write('/project/AGENTS.md', 'Be brief.');
		const { chat, session } = newChat();
		await agent.chats.createChat(chat, session, { workingDirectories: [project] });

		await agent.chats.sendMessage(chat, 'What is here?', [project], undefined, 'turn-1');

		const [first, second] = registry.window!.requests.map(r => r.instructions ?? '');
		assert.ok(first.includes('From AGENTS.md:\nBe brief.'));
		assert.strictEqual(second, first);
	});

	const issueSearch: IKodiaMcpTool = { name: 'a1b2_search', displayName: 'search', serverName: 'github', description: 'Search issues.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } };

	/** Waits for the agent to ask for the approval of a tool call. */
	async function nextApproval(signals: AgentSignal[]): Promise<IAgentToolPendingConfirmationSignal> {
		for (let i = 0; i < 200 && !signals.some(s => s.kind === 'pending_confirmation'); i++) {
			await new Promise(resolve => setTimeout(resolve, 1));
		}
		const request = signals.find((s): s is IAgentToolPendingConfirmationSignal => s.kind === 'pending_confirmation');
		assert.ok(request, 'the agent asks for approval');
		return request;
	}

	/** Waits for the agent to ask for the approval of a tool call, and answers it. */
	async function answerApproval(agent: KodiaAgent, signals: AgentSignal[], approved: boolean): Promise<IAgentToolPendingConfirmationSignal> {
		const request = await nextApproval(signals);
		agent.respondToPermissionRequest(request.state.toolCallId, approved);
		return request;
	}

	test('offers the Kodia window\'s MCP tools after its own, and runs one the user allows', async () => {
		const { agent, registry } = createAgent();
		const window = registry.window!;
		window.mcp = { tools: [issueSearch], result: { isError: false, output: '3 issues' }, calls: [] };
		window.results = [
			{ output: [{ type: 'function_call', callId: 'call-1', name: 'a1b2_search', argumentsJson: '{"query":"bug"}' }] },
			text('Found them.'),
		];
		const { session, chat } = newChat();
		const { signals } = watch(agent);
		await agent.chats.createChat(chat, session, { workingDirectories: [cwd] });

		const turn = agent.chats.sendMessage(chat, 'Look for bugs', [cwd], undefined, 'turn-1');
		const request = await answerApproval(agent, signals, true);
		await turn;

		const tools = window.requests[0].tools!;
		assert.strictEqual(tools[0].name, 'read_file', 'the agent\'s own tools come first');
		assert.deepStrictEqual(tools[tools.length - 1], { type: 'function', name: 'a1b2_search', description: 'Search issues. (MCP server: github)', parametersSchema: issueSearch.inputSchema });
		assert.strictEqual(request.permissionKind, 'mcp');
		assert.strictEqual(request.state.displayName, 'search (github)');
		assert.strictEqual(request.state.toolInput, '{"query":"bug"}');
		assert.deepStrictEqual(window.mcp.calls, [{ name: 'a1b2_search', argsJson: '{"query":"bug"}' }]);
		const output = window.requests[1].input.at(-1);
		assert.deepStrictEqual(output, { type: 'function_call_output', callId: 'call-1', output: '3 issues' });
	});

	test('does not run an MCP tool the user denies, and tells the model', async () => {
		const { agent, registry } = createAgent();
		const window = registry.window!;
		window.mcp = { tools: [issueSearch], result: { isError: false, output: 'should not run' }, calls: [] };
		window.results = [
			{ output: [{ type: 'function_call', callId: 'call-1', name: 'a1b2_search', argumentsJson: '{}' }] },
			text('Understood.'),
		];
		const { session, chat } = newChat();
		const { signals } = watch(agent);
		await agent.chats.createChat(chat, session, { workingDirectories: [cwd] });

		const turn = agent.chats.sendMessage(chat, 'Look for bugs', [cwd], undefined, 'turn-1');
		await answerApproval(agent, signals, false);
		await turn;

		assert.deepStrictEqual(window.mcp.calls, []);
		assert.deepStrictEqual(window.requests[1].input.at(-1), { type: 'function_call_output', callId: 'call-1', output: 'The user denied this tool call.' });
	});

	test('an MCP tool that fails tells the model why, and a long result is cut', async () => {
		const { agent, registry } = createAgent();
		const window = registry.window!;
		window.mcp = { tools: [issueSearch], result: { isError: true, output: 'Rate limited.' }, calls: [] };
		window.results = [
			{ output: [{ type: 'function_call', callId: 'call-1', name: 'a1b2_search', argumentsJson: '{}' }] },
			{ output: [{ type: 'function_call', callId: 'call-2', name: 'a1b2_search', argumentsJson: '{}' }] },
			text('Done.'),
		];
		const { session, chat } = newChat();
		const { signals } = watch(agent);
		await agent.chats.createChat(chat, session, { workingDirectories: [cwd] });

		const turn = agent.chats.sendMessage(chat, 'Look for bugs', [cwd], undefined, 'turn-1');
		await answerApproval(agent, signals, true);
		// the second call is asked for once the first one's failure went back to the model
		signals.length = 0;
		const second = await nextApproval(signals);
		window.mcp.result = { isError: false, output: 'x'.repeat(150_000) };
		agent.respondToPermissionRequest(second.state.toolCallId, true);
		await turn;

		assert.deepStrictEqual(window.requests[1].input.at(-1), { type: 'function_call_output', callId: 'call-1', output: 'Rate limited.' });
		const long = window.requests[2].input.at(-1) as { output: string };
		assert.ok(long.output.startsWith('x'.repeat(100_000) + '\n(The output is cut here.)'), long.output.slice(99_990, 100_040));
		assert.ok(long.output.length < 100_100);
		assert.ok(actionTypes(signals).includes(ActionType.ChatToolCallComplete), 'the second call completes');
	});

	test('has only its own tools when the window offers no MCP tools, or can\'t list them', async () => {
		const ownTools = ['read_file', 'ls_dir', 'get_dir_tree', 'search_pathnames_only', 'search_for_files', 'search_in_file', 'create_file_or_folder', 'delete_file_or_folder', 'edit_file', 'rewrite_file', 'run_command', 'fetch_url', 'write_project_memory'];
		for (const mcp of [undefined, { tools: [issueSearch], result: { isError: false, output: '' }, calls: [], listError: new Error('MCP is not ready.') }]) {
			const { agent, registry } = createAgent();
			registry.window!.mcp = mcp;
			registry.window!.results = [text('Done.')];
			const { session, chat } = newChat();
			await agent.chats.createChat(chat, session, { workingDirectories: [cwd] });

			await agent.chats.sendMessage(chat, 'Hi', [cwd], undefined, 'turn-1');

			assert.deepStrictEqual(registry.window!.requests[0].tools?.map(t => t.name), ownTools);
		}
	});

	test('an MCP tool never takes the name of one of the agent\'s own', async () => {
		const { agent, registry } = createAgent();
		registry.window!.mcp = { tools: [{ ...issueSearch, name: 'read_file' }, issueSearch], result: { isError: false, output: '' }, calls: [] };
		registry.window!.results = [text('Done.')];
		const { session, chat } = newChat();
		await agent.chats.createChat(chat, session, { workingDirectories: [cwd] });

		await agent.chats.sendMessage(chat, 'Hi', [cwd], undefined, 'turn-1');

		const names = registry.window!.requests[0].tools!.map(t => t.name);
		assert.strictEqual(names.filter(n => n === 'read_file').length, 1);
		assert.strictEqual(names.at(-1), 'a1b2_search');
	});

	test('runs a read-only tool the model calls and sends its result back', async () => {
		const { agent, registry } = createAgent();
		registry.window!.results = [
			{ output: [{ type: 'function_call', callId: 'call-1', name: 'ls_dir', argumentsJson: '{}' }] },
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

	suite('a conversation that outgrows the model\'s context window', () => {
		// a model with a window of 1,000 tokens: the history may take 800 before it is made smaller
		const tiny: IByokLmModelInfo = { vendor: 'tiny', id: 'tiny-1', name: 'tiny-1', maxContextWindowTokens: 1_000 };
		// a response that says the conversation takes 900 tokens
		const full = (value: string): IByokLmChatResult => ({ ...text(value), usage: { inputTokens: 900, outputTokens: 5 } });
		const userMessage = (value: string) => ({ type: 'message', role: 'user', content: [{ type: 'text', text: value }] });

		async function tinyChat() {
			const { agent, registry } = createAgent();
			registry.setModels([gemini, openRouter, tiny]);
			const { session, chat } = newChat();
			const watched = watch(agent);
			await agent.chats.createChat(chat, session, { workingDirectories: [cwd], model: { id: 'tiny/tiny-1' } });
			return { agent, registry, window: registry.window!, session, chat, ...watched };
		}

		const backing = (data: IAgentChatDataChange[]) => JSON.parse(data[data.length - 1].providerData as string);

		test('clears the results of old tool calls first: the model gets a stub, the Agents window keeps the result', async () => {
			const dir = fs.mkdtempSync(join(os.tmpdir(), 'kodia-context-'));
			try {
				fs.writeFileSync(join(dir, 'file.txt'), 'a line of the file\n'.repeat(40));
				const { agent, window, session, chat, data } = await tinyChat();
				window.results = [
					{ output: [{ type: 'function_call', callId: 'call-1', name: 'read_file', argumentsJson: JSON.stringify({ uri: join(dir, 'file.txt') }) }] },
					full('I read it.'),
					text('Sure.'),
				];

				await agent.chats.sendMessage(chat, 'Read file.txt', [cwd], undefined, 'turn-1');
				await agent.chats.sendMessage(chat, 'And now?', [cwd], undefined, 'turn-2');

				assert.strictEqual(window.requests.length, 3, 'clearing was enough: the model was not asked for a summary');
				const sent = window.requests[2].input;
				assert.deepStrictEqual(sent.map(item => item.type === 'function_call_output' ? item.output : item.type), ['message', 'function_call', CLEARED_TOOL_RESULT, 'message', 'message']);
				assert.strictEqual(window.requests[1].input[2].type === 'function_call_output' && window.requests[1].input[2].output.includes('a line of the file'), true, 'the result was sent as it was while it was recent');

				const kept = backing(data);
				assert.ok(kept.history[2].output.includes('a line of the file'), 'what the Agents window shows is not changed');
				assert.deepStrictEqual(kept.compaction, { clearedBefore: 4 });
				const turns = await agent.chats.getMessages(chat, session);
				assert.deepStrictEqual(turns.map(t => t.message.text), ['Read file.txt', 'And now?']);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		test('then the model summarizes the older messages, and is sent the summary in their place, also after a restart', async () => {
			const { agent, window, session, chat, data } = await tinyChat();
			window.results = [full('First answer.'), text('- The user said one.'), full('Second answer.')];

			await agent.chats.sendMessage(chat, 'one', [cwd], undefined, 'turn-1');
			await agent.chats.sendMessage(chat, 'two', [cwd], undefined, 'turn-2');

			const [, summaryRequest, request] = window.requests;
			assert.strictEqual(summaryRequest.instructions, summarizeThread_systemMessage);
			assert.deepStrictEqual(summaryRequest.tools, []);
			const transcript = (summaryRequest.input[0] as { content: { text: string }[] }).content[0].text;
			assert.ok(transcript.includes('USER:\none') && transcript.includes('ASSISTANT:\nFirst answer.'), transcript);
			assert.ok(!transcript.includes('two'), 'the latest request is kept as it is');
			assert.deepStrictEqual(request.input, [userMessage(summarizedThreadMessage('- The user said one.', undefined)), userMessage('two')]);

			const kept = backing(data);
			assert.strictEqual(kept.history.length, 4, 'the Agents window keeps the whole conversation');
			assert.deepStrictEqual(kept.compaction, { clearedBefore: 0, summary: { text: '- The user said one.', keepFromIdx: 2 } });
			assert.deepStrictEqual((await agent.chats.getMessages(chat, session)).map(t => t.message.text), ['one', 'two']);

			// the summary is kept with the chat: a restored one goes on from it, with no new summary
			const restored = createAgent();
			restored.registry.window!.results = [text('Third answer.')];
			await restored.agent.materializeChat(chat, session, data[data.length - 1].providerData);
			await restored.agent.chats.sendMessage(chat, 'three', [cwd], undefined, 'turn-3');
			assert.strictEqual(restored.registry.window!.requests.length, 1);
			assert.deepStrictEqual(restored.registry.window!.requests[0].input.map(item => item.type === 'message' ? item.content[0].type === 'text' ? item.content[0].text : '' : item.type), [
				summarizedThreadMessage('- The user said one.', undefined), 'two', 'Second answer.', 'three',
			]);
		});

		test('a summary that fails is not asked for again until the conversation has grown, and the conversation goes on as it is', async () => {
			const { agent, window, chat } = await tinyChat();
			window.results = [full('First answer.'), { output: [], error: 'Rate limited.' }, full('Second answer.'), text('Third answer.')];

			await agent.chats.sendMessage(chat, 'one', [cwd], undefined, 'turn-1');
			await agent.chats.sendMessage(chat, 'two', [cwd], undefined, 'turn-2');
			assert.strictEqual(window.requests[1].instructions, summarizeThread_systemMessage, 'it was tried');
			assert.deepStrictEqual(window.requests[2].input.length, 3, 'and the conversation was sent whole');

			await agent.chats.sendMessage(chat, 'three', [cwd], undefined, 'turn-3');
			assert.strictEqual(window.requests.length, 4, 'not tried again');
			assert.deepStrictEqual(window.requests[3].input.length, 5);
		});

		test('a conversation that fits is sent as it is, and so is one whose model has no known window', async () => {
			const { agent, window, chat } = await tinyChat();
			window.results = [text('First answer.'), text('Second answer.')];
			await agent.chats.sendMessage(chat, 'one', [cwd], undefined, 'turn-1');
			await agent.chats.sendMessage(chat, 'two', [cwd], undefined, 'turn-2');
			assert.strictEqual(window.requests.length, 2);
			assert.strictEqual(window.requests[1].input.length, 3);

			// openRouter's model has no known window, so there is nothing to fit it to
			const other = createAgent();
			other.registry.window!.results = [full('First answer.'), full('Second answer.')];
			const { session, chat: otherChat } = newChat();
			await other.agent.chats.createChat(otherChat, session, { workingDirectories: [cwd], model: { id: 'openRouter/qwen/qwen3-coder' } });
			await other.agent.chats.sendMessage(otherChat, 'one', [cwd], undefined, 'turn-1');
			await other.agent.chats.sendMessage(otherChat, 'two', [cwd], undefined, 'turn-2');
			assert.strictEqual(other.registry.window!.requests.length, 2);
			assert.strictEqual(other.registry.window!.requests[1].input.length, 3);
		});
	});
});
