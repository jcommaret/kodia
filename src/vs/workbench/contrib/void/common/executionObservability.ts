/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Structured execution observability for Kodia's agent engine:
 * correlation IDs (session/thread, turn, agent, tool-call, task), real operation timing,
 * deterministic error classification, live active spans, and bounded per-thread audit logs.
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export type ExecutionSpanKind =
	| 'llm_request'
	| 'tool_call'
	| 'subagent'
	| 'hook'
	| 'approval'
	| 'checkpoint'
	| 'task_update';

export type ExecutionSpanStatus =
	| 'running'
	| 'completed'
	| 'failed'
	| 'awaiting_approval'
	| 'cancelled'
	| 'blocked';

export type ExecutionErrorCategory =
	| 'validation'
	| 'permission'
	| 'timeout'
	| 'network'
	| 'rate_limit'
	| 'context_overflow'
	| 'hook_blocked'
	| 'tool_error'
	| 'cancelled'
	| 'unknown';

export interface ExecutionSpan {
	readonly id: string;
	readonly kind: ExecutionSpanKind;
	readonly threadId: string;
	readonly turnId?: string;
	readonly toolCallId?: string;
	readonly agentId?: string;
	readonly taskId?: string;
	readonly name: string;
	detail?: string;
	readonly modelName?: string;
	readonly startedAt: number;
	endedAt?: number;
	durationMs?: number;
	status: ExecutionSpanStatus;
	errorCategory?: ExecutionErrorCategory;
	errorMessage?: string;
	tokens?: { input?: number; output?: number; cacheRead?: number };
}

export interface ExecutionMetricsSummary {
	totalSpans: number;
	activeCount: number;
	toolCalls: number;
	toolFailures: number;
	llmRequests: number;
	avgToolMs: number;
	avgLlmMs: number;
	errorsByCategory: Partial<Record<ExecutionErrorCategory, number>>;
}

export function classifyExecutionError(message: string | undefined): ExecutionErrorCategory {
	if (!message) { return 'unknown'; }
	const lower = message.toLowerCase();
	if (/hook\s+blocked|blocked\s+by\s+(?:[a-z]+\s+)?hook|denied\s+by\s+hook/.test(lower)) { return 'hook_blocked'; }
	if (/blocked\s+by\s+autonomy|permission|denied|rejected\s+by\s+the\s+user/.test(lower)) { return 'permission'; }
	if (/interrupted|abort|cancel/.test(lower)) { return 'cancelled'; }
	if (/invalid\s+param|missing\s+required|must\s+be\s+a|cannot\s+be\s+empty|validation/.test(lower)) { return 'validation'; }
	if (/timed?\s*out|timeout|inactivity/.test(lower)) { return 'timeout'; }
	if (/429|rate\s*limit|too\s+many\s+requests/.test(lower)) { return 'rate_limit'; }
	if (/context\s*(length|window)|maximum\s+context|too\s+many\s+tokens/.test(lower)) { return 'context_overflow'; }
	if (/econnrefused|enotfound|etimedout|fetch\s+failed|network|socket|connection\s+error|http\s+5\d\d/.test(lower)) { return 'network'; }
	return 'tool_error';
}

export const MAX_SPANS_PER_THREAD = 500;

export const IExecutionObservabilityService = createDecorator<IExecutionObservabilityService>('kodiaExecutionObservabilityService');

export interface IExecutionObservabilityService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeActivity: Event<{ threadId: string; span: ExecutionSpan }>;

	startSpan(opts: {
		kind: ExecutionSpanKind;
		threadId: string;
		turnId?: string;
		toolCallId?: string;
		agentId?: string;
		taskId?: string;
		name: string;
		detail?: string;
		modelName?: string;
		status?: ExecutionSpanStatus;
	}): string;

	updateSpan(spanId: string, patch: Partial<Pick<ExecutionSpan, 'status' | 'detail' | 'errorMessage' | 'errorCategory' | 'tokens'>>): void;

	endSpan(spanId: string, opts: {
		status: Exclude<ExecutionSpanStatus, 'running'>;
		detail?: string;
		errorMessage?: string;
		errorCategory?: ExecutionErrorCategory;
		tokens?: { input?: number; output?: number; cacheRead?: number };
	}): void;

	getSpansForThread(threadId: string): readonly ExecutionSpan[];
	getActiveSpans(threadId?: string): readonly ExecutionSpan[];
	getMetrics(threadId: string): ExecutionMetricsSummary;
	clearThread(threadId: string): void;
}

export class ExecutionObservabilityService extends Disposable implements IExecutionObservabilityService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeActivity = this._register(new Emitter<{ threadId: string; span: ExecutionSpan }>());
	readonly onDidChangeActivity: Event<{ threadId: string; span: ExecutionSpan }> = this._onDidChangeActivity.event;

	private readonly _spansByThread = new Map<string, ExecutionSpan[]>();
	private readonly _spanById = new Map<string, ExecutionSpan>();
	private _seq = 0;

	startSpan(opts: {
		kind: ExecutionSpanKind;
		threadId: string;
		turnId?: string;
		toolCallId?: string;
		agentId?: string;
		taskId?: string;
		name: string;
		detail?: string;
		modelName?: string;
		status?: ExecutionSpanStatus;
	}): string {
		const id = `span-${Date.now()}-${++this._seq}`;
		const span: ExecutionSpan = {
			id,
			kind: opts.kind,
			threadId: opts.threadId,
			turnId: opts.turnId,
			toolCallId: opts.toolCallId,
			agentId: opts.agentId,
			taskId: opts.taskId,
			name: opts.name,
			detail: opts.detail,
			modelName: opts.modelName,
			startedAt: Date.now(),
			status: opts.status ?? 'running',
		};
		let list = this._spansByThread.get(opts.threadId);
		if (!list) {
			list = [];
			this._spansByThread.set(opts.threadId, list);
		}
		list.push(span);
		this._spanById.set(id, span);
		while (list.length > MAX_SPANS_PER_THREAD) {
			const dropped = list.shift();
			if (dropped) { this._spanById.delete(dropped.id); }
		}
		this._onDidChangeActivity.fire({ threadId: opts.threadId, span });
		return id;
	}

	updateSpan(spanId: string, patch: Partial<Pick<ExecutionSpan, 'status' | 'detail' | 'errorMessage' | 'errorCategory' | 'tokens'>>): void {
		const span = this._spanById.get(spanId);
		if (!span) { return; }
		if (patch.status !== undefined) { span.status = patch.status; }
		if (patch.detail !== undefined) { span.detail = patch.detail; }
		if (patch.errorMessage !== undefined) { span.errorMessage = patch.errorMessage; }
		if (patch.errorCategory !== undefined) { span.errorCategory = patch.errorCategory; }
		if (patch.tokens !== undefined) { span.tokens = patch.tokens; }
		this._onDidChangeActivity.fire({ threadId: span.threadId, span });
	}

	endSpan(spanId: string, opts: {
		status: Exclude<ExecutionSpanStatus, 'running'>;
		detail?: string;
		errorMessage?: string;
		errorCategory?: ExecutionErrorCategory;
		tokens?: { input?: number; output?: number; cacheRead?: number };
	}): void {
		const span = this._spanById.get(spanId);
		if (!span) { return; }
		span.status = opts.status;
		span.endedAt = Date.now();
		span.durationMs = Math.max(0, span.endedAt - span.startedAt);
		if (opts.detail !== undefined) { span.detail = opts.detail; }
		if (opts.errorMessage !== undefined) { span.errorMessage = opts.errorMessage; }
		if (opts.errorCategory !== undefined) {
			span.errorCategory = opts.errorCategory;
		} else if (opts.status === 'failed' || opts.status === 'blocked') {
			span.errorCategory = classifyExecutionError(opts.errorMessage);
		}
		if (opts.tokens !== undefined) { span.tokens = opts.tokens; }
		this._onDidChangeActivity.fire({ threadId: span.threadId, span });
	}

	getSpansForThread(threadId: string): readonly ExecutionSpan[] {
		return this._spansByThread.get(threadId) ?? [];
	}

	getActiveSpans(threadId?: string): readonly ExecutionSpan[] {
		if (threadId !== undefined) {
			return (this._spansByThread.get(threadId) ?? []).filter(s => s.status === 'running' || s.status === 'awaiting_approval');
		}
		const active: ExecutionSpan[] = [];
		for (const list of this._spansByThread.values()) {
			for (const s of list) {
				if (s.status === 'running' || s.status === 'awaiting_approval') {
					active.push(s);
				}
			}
		}
		return active;
	}

	getMetrics(threadId: string): ExecutionMetricsSummary {
		const spans = this._spansByThread.get(threadId) ?? [];
		let activeCount = 0;
		let toolCalls = 0;
		let toolFailures = 0;
		let toolDurationSum = 0;
		let toolDurationCount = 0;
		let llmRequests = 0;
		let llmDurationSum = 0;
		let llmDurationCount = 0;
		const errorsByCategory: Partial<Record<ExecutionErrorCategory, number>> = {};

		for (const s of spans) {
			if (s.status === 'running' || s.status === 'awaiting_approval') { activeCount++; }
			if (s.kind === 'tool_call') {
				toolCalls++;
				if (s.status === 'failed' || s.status === 'blocked') { toolFailures++; }
				if (s.durationMs !== undefined) { toolDurationSum += s.durationMs; toolDurationCount++; }
			} else if (s.kind === 'llm_request') {
				llmRequests++;
				if (s.durationMs !== undefined) { llmDurationSum += s.durationMs; llmDurationCount++; }
			}
			if (s.errorCategory) {
				errorsByCategory[s.errorCategory] = (errorsByCategory[s.errorCategory] ?? 0) + 1;
			}
		}

		return {
			totalSpans: spans.length,
			activeCount,
			toolCalls,
			toolFailures,
			llmRequests,
			avgToolMs: toolDurationCount ? Math.round(toolDurationSum / toolDurationCount) : 0,
			avgLlmMs: llmDurationCount ? Math.round(llmDurationSum / llmDurationCount) : 0,
			errorsByCategory,
		};
	}

	clearThread(threadId: string): void {
		const list = this._spansByThread.get(threadId);
		if (list) {
			for (const s of list) { this._spanById.delete(s.id); }
			this._spansByThread.delete(threadId);
		}
	}
}

registerSingleton(IExecutionObservabilityService, ExecutionObservabilityService, InstantiationType.Delayed);
