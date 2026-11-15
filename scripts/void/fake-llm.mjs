/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// A stand-in for a local model server (LM Studio's OpenAI-compatible API), to try Kodia's chat and agent by hand or
// from a script without a real model. It does what the prompt tells it, so a run is the same every time.
//
//   node scripts/void/fake-llm.mjs            # listens on 127.0.0.1:1234, LM Studio's port: Kodia finds it by itself
//   PORT=4321 node scripts/void/fake-llm.mjs  # another port: set it as LM Studio's endpoint in Kodia's settings
//
// The prompt is the plan. Each line `CALL <tool> <json arguments>` of the last message of the user that has one is a
// tool call, made one per request, in order. When the results are all in, the reply is `DONE` and the start of each
// result. A prompt with no CALL line is answered with `ECHO: <prompt>`.
//
//   CALL read_file {"uri": "package.json"}
//   CALL run_command {"command": "echo hello"}
//
// MODEL names the model it lists (default `devstral`, which Kodia knows calls tools natively: a name it doesn't know
// gets the tools as XML in the prompt, which this server doesn't read). CONTEXT is its context window, in tokens.
// DELAY is how long it takes to answer, in milliseconds (0): a slow model, to watch a turn as it goes.

import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 1234);
const model = process.env.MODEL ?? 'devstral';
const contextLength = Number(process.env.CONTEXT ?? 256_000);
const delay = Number(process.env.DELAY ?? 0);

/** The text of a message, whose content is a string or a list of parts. */
export const textOf = message => {
	const { content } = message ?? {};
	if (typeof content === 'string') { return content; }
	if (Array.isArray(content)) { return content.map(part => typeof part?.text === 'string' ? part.text : '').join('\n'); }
	return '';
};

/** The tool calls a prompt asks for: its `CALL <tool> <json>` lines. */
export const plannedCalls = prompt => prompt.split('\n').flatMap(line => {
	const match = /^\s*CALL\s+(\S+)\s*(.*)$/.exec(line);
	if (!match) { return []; }
	const [, name, json] = match;
	let args = '{}';
	try { args = JSON.stringify(JSON.parse(json || '{}')); } catch { /* arguments that aren't JSON are sent as they are: Kodia reports them */ args = json; }
	return [{ name, arguments: args }];
});

/** What to answer to a conversation: the next tool call of the plan, or the final text. */
export const nextReply = messages => {
	let planIdx = -1;
	messages.forEach((message, idx) => { if (message.role === 'user' && plannedCalls(textOf(message)).length) { planIdx = idx; } });
	if (planIdx === -1) {
		const lastUser = messages.findLast(message => message.role === 'user');
		return { text: `ECHO: ${textOf(lastUser).trim()}` };
	}
	const calls = plannedCalls(textOf(messages[planIdx]));
	const results = messages.slice(planIdx + 1).filter(message => message.role === 'tool');
	if (results.length < calls.length) {
		return { toolCall: { id: `call_${planIdx}_${results.length}`, ...calls[results.length] } };
	}
	const summary = results.map((result, idx) => `${idx + 1}. ${calls[idx]?.name ?? 'tool'}: ${textOf(result).trim().slice(0, 200)}`).join('\n');
	return { text: `DONE\n${summary}` };
};

const chunkOf = (delta, finishReason = null) => ({
	id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 0, model,
	choices: [{ index: 0, delta, finish_reason: finishReason }],
});

const readBody = request => new Promise((resolve, reject) => {
	let body = '';
	request.on('data', chunk => { body += chunk; });
	request.on('end', () => resolve(body));
	request.on('error', reject);
});

const sendJson = (response, status, value) => {
	response.writeHead(status, { 'content-type': 'application/json' });
	response.end(JSON.stringify(value));
};

const handleChat = async (request, response) => {
	let body;
	try { body = JSON.parse(await readBody(request)); }
	catch { return sendJson(response, 400, { error: { message: 'The body is not JSON.' } }); }

	const reply = nextReply(Array.isArray(body.messages) ? body.messages : []);
	if (delay > 0) { await new Promise(resolve => setTimeout(resolve, delay)); }
	const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
	const toolCalls = reply.toolCall ? [{ id: reply.toolCall.id, type: 'function', function: { name: reply.toolCall.name, arguments: reply.toolCall.arguments } }] : undefined;
	const finishReason = toolCalls ? 'tool_calls' : 'stop';
	console.log(`[fake-llm] ${toolCalls ? `CALL ${reply.toolCall.name} ${reply.toolCall.arguments}` : reply.text.split('\n')[0]}`);

	if (!body.stream) {
		return sendJson(response, 200, {
			id: 'chatcmpl-fake', object: 'chat.completion', created: 0, model, usage,
			choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content: reply.text ?? null, ...toolCalls ? { tool_calls: toolCalls } : {} } }],
		});
	}

	response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
	const send = value => response.write(`data: ${JSON.stringify(value)}\n\n`);
	send(chunkOf({ role: 'assistant', content: '' }));
	if (toolCalls) {
		send(chunkOf({ tool_calls: toolCalls.map((call, index) => ({ index, ...call })) }));
	} else {
		// in a few pieces, as a model streams
		for (const piece of reply.text.match(/[\s\S]{1,24}/g) ?? []) { send(chunkOf({ content: piece })); }
	}
	send(chunkOf({}, finishReason));
	send({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 0, model, choices: [], usage });
	response.write('data: [DONE]\n\n');
	response.end();
};

export const createFakeLlmServer = () => createServer((request, response) => {
	const path = new URL(request.url ?? '/', 'http://localhost').pathname;
	if (request.method === 'GET' && (path === '/v1/models' || path === '/api/v0/models')) {
		// `context_length` and `max_context_length`: without them Kodia takes the model for a small one and trims the conversation
		return sendJson(response, 200, { object: 'list', data: [{ id: model, object: 'model', owned_by: 'fake', type: 'llm', state: 'loaded', context_length: contextLength, max_context_length: contextLength, loaded_context_length: contextLength }] });
	}
	if (request.method === 'POST' && path === '/v1/chat/completions') {
		return void handleChat(request, response).catch(error => sendJson(response, 500, { error: { message: String(error) } }));
	}
	sendJson(response, 404, { error: { message: `The fake model server has no ${request.method} ${path}.` } });
});

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	createFakeLlmServer().listen(port, '127.0.0.1', () => console.log(`[fake-llm] "${model}" on http://127.0.0.1:${port}`));
}
