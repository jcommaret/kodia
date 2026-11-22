/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ChatMessage } from './chatThreadServiceTypes.js';
import { TaskPlan, getPlanProgress } from './autonomousTask.js';

export interface ExportableThread {
	readonly id: string;
	readonly createdAt: string;
	readonly lastModified: string;
	readonly messages: readonly ChatMessage[];
	readonly taskPlan?: TaskPlan;
	readonly subagentOf?: { readonly parentThreadId: string; readonly agent?: string; readonly role?: string; readonly description: string };
}

/**
 * Filter threads by case-insensitive multi-word search query across user prompts,
 * assistant responses, tool names, and task plan title.
 */
export function filterThreadsByQuery<T extends ExportableThread>(threads: readonly T[], query: string): T[] {
	const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return [...threads];
	}
	return threads.filter(thread => {
		const parts: string[] = [thread.id];
		if (thread.taskPlan) {
			parts.push(thread.taskPlan.title, thread.taskPlan.description);
		}
		for (const msg of thread.messages) {
			if (msg.role === 'user' || msg.role === 'assistant') {
				parts.push(msg.displayContent || '');
			} else if (msg.role === 'tool') {
				parts.push(msg.name || '');
			}
		}
		const haystack = parts.join('\n').toLowerCase();
		return words.every(w => haystack.includes(w));
	});
}

/**
 * Export a Kodia conversation thread to clean, portable Markdown including user messages,
 * assistant responses, tool execution summary, and task plan progress (if any).
 */
export function exportThreadToMarkdown(thread: ExportableThread): string {
	const firstUser = thread.messages.find(m => m.role === 'user');
	const rawTitle = firstUser && firstUser.role === 'user' ? firstUser.displayContent.trim().split('\n')[0] : '';
	const title = rawTitle ? rawTitle.slice(0, 80) : `Kodia Session ${thread.id.slice(0, 8)}`;

	const lines: string[] = [
		`# ${title}`,
		'',
		`- **Thread ID**: \`${thread.id}\``,
		`- **Created**: ${thread.createdAt}`,
		`- **Last Modified**: ${thread.lastModified}`,
		'',
	];

	if (thread.taskPlan) {
		const prog = getPlanProgress(thread.taskPlan);
		lines.push(`## Task Plan: ${thread.taskPlan.title} (${prog.completed}/${prog.total}, ${prog.percent}%)`, '');
		for (const t of thread.taskPlan.tasks) {
			const box = t.status === 'completed' ? 'x' : ' ';
			const agentTag = t.assignedAgent ? ` _(${t.assignedAgent})_` : '';
			lines.push(`- [${box}] **${t.title}**${agentTag} — \`${t.status}\``);
		}
		lines.push('');
	}

	lines.push('## Conversation', '');

	for (const msg of thread.messages) {
		if (msg.role === 'user') {
			lines.push('### User', '', msg.displayContent.trim() || '_(empty)_', '');
		} else if (msg.role === 'assistant') {
			const body = msg.displayContent.trim();
			if (body) {
				lines.push('### Kodia', '', body, '');
			}
		} else if (msg.role === 'tool') {
			const status = msg.type === 'success' ? 'ok' : msg.type === 'tool_error' ? 'error' : msg.type;
			lines.push(`> **Tool** \`${msg.name}\` (${status})`, '');
		}
	}

	return lines.join('\n').trimEnd() + '\n';
}
