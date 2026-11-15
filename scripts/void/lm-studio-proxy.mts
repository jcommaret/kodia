/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Stands between Kodia and a real LM Studio server, to try the agent with a real model from a script
// (scripts/void/agent-real-model.sh). It listens where Kodia looks for LM Studio and forwards to the real server:
//
//   UPSTREAM=1235 ONLY=qwen3.5-4b-mlx node scripts/void/lm-studio-proxy.mts
//
// - ONLY: the one model it lists, so Kodia picks it and LM Studio loads no other
// - PORT (1234) is where it listens, UPSTREAM the port of LM Studio
// - DUMP: a folder where it writes the system prompt of the agent and of a sub-agent, as the model got them
//
// Each chat request is a line `[request] agent|subagent system=<characters> messages=<count>`, and each reply a line
// `[reply] agent|subagent <the text and the tool calls, as JSON>`.

import { createServer, request as httpRequest } from 'node:http';
import type { Buffer } from 'node:buffer';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.env.PORT ?? 1234);
const upstream = Number(process.env.UPSTREAM ?? 1235);
const only = process.env.ONLY;
const dump = process.env.DUMP;

/** The text of a message, whose content is a string or a list of parts. */
type Message = { role?: string; content?: string | { text?: unknown }[] };
type Delta = { content?: string; tool_calls?: { function?: { name?: string; arguments?: string } }[] };

const textOf = (message: Message | undefined): string => {
	const { content } = message ?? {};
	if (typeof content === 'string') { return content; }
	if (Array.isArray(content)) { return content.map(part => typeof part?.text === 'string' ? part.text : '').join('\n'); }
	return '';
};

/** What a streamed (or whole) reply says: its text, and its tool calls as `<<name>>arguments`. */
const replyOf = (body: string): string => {
	const ofDelta = (delta: Delta | undefined): string => (delta?.content ?? '') + (delta?.tool_calls ?? []).map(call => (call.function?.name ? `<<${call.function.name}>>` : '') + (call.function?.arguments ?? '')).join('');
	const events = body.split('\n').filter(line => line.startsWith('data: {'));
	try {
		return events.length
			? events.map(line => ofDelta(JSON.parse(line.slice(6)).choices?.[0]?.delta)).join('')
			: ofDelta(JSON.parse(body).choices?.[0]?.message);
	} catch {
		return '';
	}
};

createServer((request, response) => {
	const chunks: Buffer[] = [];
	request.on('data', (chunk: Buffer) => chunks.push(chunk));
	request.on('end', () => {
		const body = Buffer.concat(chunks);
		const isChat = request.method === 'POST' && (request.url ?? '').includes('/chat/completions');
		let who = 'agent';
		if (isChat) {
			try {
				const messages: Message[] = JSON.parse(body.toString()).messages ?? [];
				const system = textOf(messages.find(message => message.role === 'system'));
				who = system.includes('research sub-agent') ? 'subagent' : 'agent';
				console.log(`[request] ${who} system=${system.length} messages=${messages.length}`);
				if (dump) { writeFileSync(join(dump, `system-${who}.txt`), system); }
			} catch (error) {
				console.log(`[request] unreadable: ${error}`);
			}
		}
		const forwarded = httpRequest({ host: '127.0.0.1', port: upstream, path: request.url, method: request.method, headers: { ...request.headers, host: `127.0.0.1:${upstream}` } }, answer => {
			const isModels = request.method === 'GET' && /\/models$/.test(new URL(request.url ?? '/', 'http://localhost').pathname);
			if (isModels && only) {
				const parts: Buffer[] = [];
				answer.on('data', (part: Buffer) => parts.push(part));
				answer.on('end', () => {
					let text = Buffer.concat(parts).toString();
					try { const list = JSON.parse(text); list.data = list.data.filter((model: { id: string }) => model.id === only); text = JSON.stringify(list); } catch { /* sent as it is */ }
					response.writeHead(answer.statusCode ?? 200, { 'content-type': 'application/json' });
					response.end(text);
				});
				return;
			}
			response.writeHead(answer.statusCode ?? 200, answer.headers);
			let text = '';
			answer.on('data', (part: Buffer) => { text += part; response.write(part); });
			answer.on('end', () => {
				response.end();
				if (isChat) { console.log(`[reply] ${who} ${JSON.stringify(replyOf(text))}`); }
			});
		});
		forwarded.on('error', error => { response.writeHead(502); response.end(String(error)); });
		forwarded.end(body);
	});
}).listen(port, '127.0.0.1', () => console.log(`[lm-studio-proxy] http://127.0.0.1:${port} -> ${upstream}${only ? `, only ${only}` : ''}`));
