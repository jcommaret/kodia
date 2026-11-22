/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ChatMode } from './voidSettingsTypes.js';

export interface KodiaWorkflowDefinition {
	readonly name: string;
	readonly description: string;
	readonly sourcePath: string;
	readonly mode: ChatMode;
	readonly body: string;
	readonly steps: string[];
	readonly defaultIntervalMinutes?: number;
}

export interface KodiaScheduledJob {
	readonly id: string;
	readonly name: string;
	readonly prompt: string;
	readonly workflowName?: string;
	readonly chatMode: ChatMode;
	readonly intervalMinutes: number;
	readonly enabled: boolean;
	readonly createdAt: string;
	readonly lastRunAt?: string;
	readonly nextRunAt?: string;
	readonly lastStatus?: 'idle' | 'running' | 'completed' | 'failed';
	readonly lastThreadId?: string;
	readonly lastError?: string;
	readonly runCount: number;
}

/**
 * Parse a `.kodia/workflows/*.md` or `.windsurf/workflows/*.md` workflow file.
 * Supports optional YAML frontmatter (`name`, `description`, `mode`, `interval-minutes`)
 * and numbered markdown steps.
 */
export function parseWorkflowMarkdown(fileName: string, sourcePath: string, raw: string): KodiaWorkflowDefinition | undefined {
	const trimmed = raw.trim();
	if (!trimmed) { return undefined; }

	let name = fileName.replace(/\.md$/i, '').replace(/\\/g, '/');
	let description = '';
	let mode: ChatMode = 'agent';
	let defaultIntervalMinutes: number | undefined;
	let body = trimmed;

	const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(trimmed);
	if (fm) {
		body = fm[2].trim();
		for (const line of fm[1].split(/\r?\n/)) {
			const idx = line.indexOf(':');
			if (idx === -1) { continue; }
			const key = line.slice(0, idx).trim().toLowerCase();
			const val = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
			if (key === 'name' && val) { name = val; }
			else if (key === 'description') { description = val; }
			else if (key === 'mode' && (val === 'agent' || val === 'plan' || val === 'debug' || val === 'gather' || val === 'normal')) {
				mode = val;
			} else if (key === 'interval-minutes' || key === 'intervalminutes') {
				const n = Number(val);
				if (Number.isFinite(n) && n >= 1) { defaultIntervalMinutes = Math.round(n); }
			}
		}
	}

	if (!body) { return undefined; }

	const steps: string[] = [];
	for (const line of body.split(/\r?\n/)) {
		const m = /^\s*(?:\d+[.)]|[-*])\s+(.+)$/.exec(line);
		if (m && m[1].trim()) {
			steps.push(m[1].trim());
		}
	}

	return {
		name,
		description: description || steps[0] || 'Reusable Kodia workflow',
		sourcePath,
		mode,
		body,
		steps,
		defaultIntervalMinutes,
	};
}

export function computeNextRunAt(fromMs: number, intervalMinutes: number): string {
	const safeMinutes = Math.max(1, Math.min(intervalMinutes, 43_200)); // 1 min .. 30 days
	return new Date(fromMs + safeMinutes * 60_000).toISOString();
}

export function isScheduledJobDue(job: KodiaScheduledJob, nowMs: number): boolean {
	if (!job.enabled || job.lastStatus === 'running') {
		return false;
	}
	if (!job.nextRunAt) {
		return true;
	}
	const nextMs = Date.parse(job.nextRunAt);
	if (!Number.isFinite(nextMs)) {
		return true;
	}
	return nowMs >= nextMs;
}
