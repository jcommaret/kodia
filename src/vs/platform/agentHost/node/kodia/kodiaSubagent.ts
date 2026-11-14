/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import type { IByokLmChatResult, IByokLmFunctionCallItem, IByokLmFunctionTool, IByokLmInputItem } from '../../common/agentHostByokLm.js';
import { sharedToolNames, sharedTools, SharedTool } from '../../../kodia/common/toolCatalog.js';
import { GIT_FUNCTION_TOOLS, gitToolNames } from './kodiaGitTools.js';
import { KODIA_TOOLS } from './kodiaTools.js';

// The sub-agent of the Kodia agent: a research task the agent hands over, which runs with the same model in a
// conversation of its own and comes back as a report. What the sub-agent reads to answer (whole files, search
// results) stays in its conversation, so the agent's own keeps its room: this is what makes a long task fit in the
// context window of a small model. A sub-agent only reads: it has the tools that need no approval, so it never asks
// the user anything, and it can't hand a task over in turn.

export const SUBAGENT_TOOL_NAME = 'run_subagent';

/** How many requests a sub-agent makes before it has to report. */
export const MAX_SUBAGENT_ROUNDS = 15;
/** What a sub-agent keeps of a tool result: it reads more with another call. */
export const MAX_SUBAGENT_TOOL_OUTPUT_CHARS = 30_000;
/** What comes back of a report. */
export const MAX_SUBAGENT_REPORT_CHARS = 20_000;

export const SUBAGENT_FUNCTION_TOOL: IByokLmFunctionTool = {
	type: 'function',
	name: SUBAGENT_TOOL_NAME,
	description: 'Hands a research task to a sub-agent, which works in a conversation of its own with read-only tools (read files, list folders, search, git status and history) and returns a report. Use it for a question that takes many file reads or searches (where is something handled, how does a part work, what would a change touch): what the sub-agent reads does not fill this conversation, only its report does. The sub-agent sees nothing of this conversation, so the task must say everything it needs: what to find out, where to look if you know, and what the report should contain. It cannot change files or run commands.',
	parametersSchema: {
		type: 'object',
		properties: {
			task: { type: 'string', description: 'The task, complete in itself: what to find out and what to report.' },
		},
		required: ['task'],
	},
};

/** The tools of a sub-agent: the agent's own that only read (no approval), and the read-only git tools. */
const readOnlySharedToolNames: readonly string[] = sharedToolNames.filter(name => (sharedTools[name] as SharedTool).approval === undefined);
export const SUBAGENT_TOOLS: readonly IByokLmFunctionTool[] = [...KODIA_TOOLS.filter(tool => readOnlySharedToolNames.includes(tool.name)), ...GIT_FUNCTION_TOOLS];
const subagentToolNames = new Set<string>([...readOnlySharedToolNames, ...gitToolNames]);

export function subagentInstructions(workingDirectory: string | undefined): string {
	const lines = ['You are a research sub-agent of a coding agent. You are given one task: look at the project with your tools until you can answer it, then reply with your report.'];
	if (workingDirectory) {
		lines.push(`The project is at ${workingDirectory}; relative paths resolve against it.`);
	}
	lines.push('Your tools only read: you cannot change files or run commands, and you should not say you did.');
	lines.push('Find where something is with search_codebase, then read just the lines you need with read_file.');
	lines.push('Your report is all the agent gets of your work: say what you found, with the file paths and line numbers, and what you could not find. Keep it short and exact; do not paste whole files.');
	return lines.join('\n');
}

/** The task of a `run_subagent` call, or what is wrong with its arguments. */
export function parseSubagentTask(argumentsJson: string): { readonly task: string } | { readonly error: string } {
	try {
		const task = (JSON.parse(argumentsJson || '{}') as { task?: unknown }).task;
		return typeof task === 'string' && task.trim() ? { task: task.trim() } : { error: 'Missing "task": say what the sub-agent should find out.' };
	} catch {
		return { error: `Invalid JSON arguments for tool "${SUBAGENT_TOOL_NAME}".` };
	}
}

export interface ISubagentHost {
	/** Sends the sub-agent's conversation to the model, with the sub-agent's instructions and tools. */
	chat(input: readonly IByokLmInputItem[]): Promise<IByokLmChatResult>;
	/** Runs one of the sub-agent's tools, and returns what the model is told of it. */
	runTool(call: IByokLmFunctionCallItem): Promise<string>;
	readonly signal: AbortSignal;
}

const textOf = (result: IByokLmChatResult): string =>
	result.output.flatMap(item => item.type === 'message' ? item.content.map(part => part.type === 'text' ? part.text : '') : []).join('').trim();

const cut = (text: string, maxChars: number, what: string): string =>
	text.length > maxChars ? `${text.slice(0, maxChars)}\n\n(${what} cut here: it was ${text.length} characters long.)` : text;

/**
 * Runs a sub-agent on `task` until it reports, and returns its report. It fails when the model does, and when the
 * sub-agent is still calling tools after {@link MAX_SUBAGENT_ROUNDS} requests: what it wrote last is then returned
 * as what it had found so far.
 */
export async function runSubagent(task: string, host: ISubagentHost): Promise<{ readonly success: boolean; readonly output: string; readonly rounds: number }> {
	const history: IByokLmInputItem[] = [{ type: 'message', role: 'user', content: [{ type: 'text', text: task }] }];
	let lastText = '';
	for (let round = 1; round <= MAX_SUBAGENT_ROUNDS; round++) {
		const result = await host.chat(history);
		if (host.signal.aborted) {
			return { success: false, output: 'The sub-agent was stopped.', rounds: round };
		}
		if (result.error) {
			return { success: false, output: `The sub-agent's model request failed: ${result.error}`, rounds: round };
		}
		const calls: IByokLmFunctionCallItem[] = [];
		for (const item of result.output) {
			if (item.type === 'message') {
				history.push({ type: 'message', role: 'assistant', content: item.content });
			} else {
				history.push(item);
				if (item.type === 'function_call') {
					calls.push(item);
				}
			}
		}
		lastText = textOf(result) || lastText;
		if (calls.length === 0) {
			return lastText
				? { success: true, output: cut(lastText, MAX_SUBAGENT_REPORT_CHARS, 'The report is'), rounds: round }
				: { success: false, output: 'The sub-agent ended without a report.', rounds: round };
		}
		for (const call of calls) {
			const output = subagentToolNames.has(call.name)
				? cut(await host.runTool(call), MAX_SUBAGENT_TOOL_OUTPUT_CHARS, 'The result is')
				: `A sub-agent has no "${call.name}" tool: it only reads. Its tools are ${[...subagentToolNames].join(', ')}.`;
			if (host.signal.aborted) {
				return { success: false, output: 'The sub-agent was stopped.', rounds: round };
			}
			history.push({ type: 'function_call_output', callId: call.callId, output });
		}
	}
	return { success: false, output: `The sub-agent did not finish within ${MAX_SUBAGENT_ROUNDS} requests.${lastText ? ` What it had written last:\n\n${cut(lastText, MAX_SUBAGENT_REPORT_CHARS, 'This is')}` : ''}`, rounds: MAX_SUBAGENT_ROUNDS };
}
