/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useEffect, useState } from 'react';
import { Activity, Bug, CheckCircle2, Clock, Loader2, ShieldAlert, XCircle, Ban, Trash2 } from 'lucide-react';
import { useAccessor, useChatThreadsState, useChatThreadsStreamState } from '../util/services.js';
import { ExecutionSpan } from '../../../../common/executionObservability.js';
import { DebuggerActivity } from '../../../../common/debuggerActivityServiceTypes.js';

function formatDuration(ms: number | undefined, startedAt?: number): string {
	const value = ms ?? (startedAt ? Math.max(0, Date.now() - startedAt) : 0);
	if (value < 1000) { return `${value}ms`; }
	if (value < 60_000) { return `${(value / 1000).toFixed(1)}s`; }
	const mins = Math.floor(value / 60_000);
	const secs = Math.round((value % 60_000) / 1000);
	return `${mins}m ${secs}s`;
}

export const AgentActivityPanel = () => {
	const accessor = useAccessor();
	const observability = accessor.get('IExecutionObservabilityService');
	const debuggerActivityService = accessor.get('IDebuggerActivityService');
	const chatThreadsState = useChatThreadsState();
	const threadId = chatThreadsState.currentThreadId;
	const streamState = useChatThreadsStreamState(threadId);

	const [spans, setSpans] = useState<readonly ExecutionSpan[]>(() => observability.getSpansForThread(threadId));
	const [debugActivities, setDebugActivities] = useState<DebuggerActivity[]>(() => debuggerActivityService?.getActivities() ?? []);
	const [filter, setFilter] = useState<'all' | 'active' | 'errors' | 'debug'>('all');

	useEffect(() => {
		setSpans([...observability.getSpansForThread(threadId)]);
		const d = observability.onDidChangeActivity(({ threadId: changedId }) => {
			if (changedId === threadId) {
				setSpans([...observability.getSpansForThread(threadId)]);
			}
		});
		return () => d.dispose();
	}, [observability, threadId]);

	useEffect(() => {
		if (!debuggerActivityService) { return; }
		setDebugActivities(debuggerActivityService.getActivities());
		const d = debuggerActivityService.onDidChangeDebuggerActivity(() => {
			setDebugActivities(debuggerActivityService.getActivities());
		});
		return () => d.dispose();
	}, [debuggerActivityService]);

	const metrics = observability.getMetrics(threadId);
	const orderedSpans = [...spans].reverse();
	const filteredSpans = orderedSpans.filter(s => {
		if (filter === 'active') { return s.status === 'running' || s.status === 'awaiting_approval'; }
		if (filter === 'errors') { return s.status === 'failed' || s.status === 'blocked'; }
		return true;
	});

	const statusIcon = (status: ExecutionSpan['status']) => {
		switch (status) {
			case 'running': return <Loader2 size={12} className='animate-spin text-[#0e70c0] flex-shrink-0' />;
			case 'awaiting_approval': return <ShieldAlert size={12} className='text-yellow-500 flex-shrink-0' />;
			case 'completed': return <CheckCircle2 size={12} className='text-green-500 flex-shrink-0' />;
			case 'failed': return <XCircle size={12} className='text-red-500 flex-shrink-0' />;
			case 'blocked': return <Ban size={12} className='text-orange-500 flex-shrink-0' />;
			case 'cancelled': return <Clock size={12} className='text-void-fg-4 flex-shrink-0' />;
		}
	};

	const kindBadgeColor = (kind: ExecutionSpan['kind']) => {
		switch (kind) {
			case 'llm_request': return 'bg-purple-500/15 text-purple-300 border-purple-500/30';
			case 'tool_call': return 'bg-blue-500/15 text-blue-300 border-blue-500/30';
			case 'subagent': return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
			case 'hook': return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
			case 'approval': return 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30';
			default: return 'bg-void-bg-3 text-void-fg-3 border-void-border-2';
		}
	};

	return (
		<div className='p-3 space-y-3 h-full overflow-y-auto text-void-fg-1'>
			{/* Live Status Header */}
			<div className='flex items-center justify-between'>
				<div className='flex items-center gap-1.5'>
					<Activity size={14} className='text-void-fg-2' />
					<h2 className='text-xs font-semibold'>Live Execution Activity</h2>
				</div>
				<div className='flex items-center gap-2'>
					<span className={`text-[10px] px-1.5 py-0.5 rounded border ${streamState?.isRunning === 'awaiting_user'
						? 'border-yellow-500/40 bg-yellow-500/10 text-yellow-400'
						: streamState?.isRunning
							? 'border-blue-500/40 bg-blue-500/10 text-blue-400'
							: 'border-void-border-2 bg-void-bg-1 text-void-fg-3'
						}`}>
						{streamState?.isRunning === 'awaiting_user' ? 'Awaiting Approval' : streamState?.isRunning ? `Running (${streamState.isRunning})` : 'Idle'}
					</span>
					{spans.length > 0 && (
						<button
							type='button'
							onClick={() => { observability.clearThread(threadId); setSpans([]); }}
							title='Clear thread activity log'
							className='p-1 rounded hover:bg-void-bg-3 text-void-fg-3 hover:text-void-fg-1'
						>
							<Trash2 size={12} />
						</button>
					)}
				</div>
			</div>

			{/* Real Metrics Strip */}
			<div className='grid grid-cols-3 gap-1.5 text-center'>
				<div className='bg-void-bg-1 border border-void-border-2 rounded p-1.5'>
					<div className='text-[10px] text-void-fg-3'>Tool Calls</div>
					<div className='text-xs font-semibold'>{metrics.toolCalls}{metrics.toolFailures > 0 ? <span className='text-red-400 ml-1'>({metrics.toolFailures} err)</span> : null}</div>
				</div>
				<div className='bg-void-bg-1 border border-void-border-2 rounded p-1.5'>
					<div className='text-[10px] text-void-fg-3'>LLM Turns</div>
					<div className='text-xs font-semibold'>{metrics.llmRequests}</div>
				</div>
				<div className='bg-void-bg-1 border border-void-border-2 rounded p-1.5'>
					<div className='text-[10px] text-void-fg-3'>Avg Tool / LLM</div>
					<div className='text-xs font-semibold'>{formatDuration(metrics.avgToolMs)} / {formatDuration(metrics.avgLlmMs)}</div>
				</div>
			</div>

			{/* Filter Tabs */}
			<div className='flex gap-1 text-[11px]'>
				{(['all', 'active', 'errors', 'debug'] as const).map(tab => (
					<button
						key={tab}
						type='button'
						onClick={() => setFilter(tab)}
						className={`px-2 py-0.5 rounded border transition-colors ${filter === tab
							? 'bg-void-bg-3 border-void-border-1 text-void-fg-1 font-medium'
							: 'bg-void-bg-1 border-void-border-2 text-void-fg-3 hover:text-void-fg-1'
							}`}
					>
						{tab === 'all' ? `All (${spans.length})`
							: tab === 'active' ? `Active (${metrics.activeCount})`
								: tab === 'errors' ? `Issues (${metrics.toolFailures})`
									: `Debugger (${debugActivities.length})`}
					</button>
				))}
			</div>

			{/* Live Debugger Feed */}
			{filter === 'debug' ? (
				<div className='space-y-1.5'>
					{debugActivities.length === 0 ? (
						<div className='bg-void-bg-1 border border-void-border-2 rounded p-3 text-center text-xs text-void-fg-3'>
							No debugger activity recorded yet. Start a debug session or run <code className='px-1 bg-void-bg-3 rounded'>test_debug</code>.
						</div>
					) : (
						debugActivities.slice(0, 50).map(act => (
							<div key={act.id} className='bg-void-bg-1 border border-void-border-2 rounded p-2 space-y-0.5'>
								<div className='flex items-center justify-between gap-2'>
									<div className='flex items-center gap-1.5 min-w-0'>
										<Bug size={12} className='text-amber-400 flex-shrink-0' />
										<span className='text-xs font-medium truncate'>{act.title}</span>
									</div>
									<span className={`text-[10px] px-1 rounded ${act.status === 'failed' ? 'text-red-400' : act.status === 'running' ? 'text-blue-400' : 'text-void-fg-3'}`}>
										{act.status}{act.duration !== undefined ? ` · ${formatDuration(act.duration)}` : ''}
									</span>
								</div>
								<div className='text-[11px] text-void-fg-3 break-words'>{act.description}</div>
								{act.sourceLocation && (
									<div className='text-[10px] font-mono text-void-fg-4 truncate'>
										{act.sourceLocation.uri}:{act.sourceLocation.line}
									</div>
								)}
								{act.error && (
									<div className='text-[10px] text-red-400 break-words'>{act.error}</div>
								)}
							</div>
						))
					)}
				</div>
			) : (
				/* Execution Timeline */
				<div className='space-y-1.5'>
					{filteredSpans.length === 0 ? (
						<div className='bg-void-bg-1 border border-void-border-2 rounded p-3 text-center text-xs text-void-fg-3'>
							{filter === 'all' ? 'No execution events yet for this thread. Send a message to see live LLM requests, tools, hooks, and subagents.' : 'No matching events.'}
						</div>
					) : (
						filteredSpans.slice(0, 100).map(span => (
							<div key={span.id} className='bg-void-bg-1 border border-void-border-2 rounded p-2 space-y-1'>
								<div className='flex items-center justify-between gap-1.5'>
									<div className='flex items-center gap-1.5 min-w-0'>
										{statusIcon(span.status)}
										<span className={`text-[9px] uppercase tracking-wide px-1 py-0.2 rounded border flex-shrink-0 ${kindBadgeColor(span.kind)}`}>
											{span.kind.replace('_', ' ')}
										</span>
										<span className='text-xs font-medium truncate'>{span.name}</span>
									</div>
									<span className='text-[10px] text-void-fg-4 flex-shrink-0 font-mono'>
										{formatDuration(span.durationMs, span.status === 'running' ? span.startedAt : undefined)}
									</span>
								</div>
								{span.detail && (
									<div className='text-[11px] text-void-fg-3 truncate' title={span.detail}>{span.detail}</div>
								)}
								{span.tokens && (span.tokens.input || span.tokens.output) && (
									<div className='text-[10px] text-void-fg-4 font-mono'>
										in: {span.tokens.input ?? 0} · out: {span.tokens.output ?? 0}{span.tokens.cacheRead ? ` · cache: ${span.tokens.cacheRead}` : ''}
									</div>
								)}
								{span.errorMessage && (
									<div className='text-[10px] text-red-400 break-words'>
										{span.errorCategory ? `[${span.errorCategory}] ` : ''}{span.errorMessage}
									</div>
								)}
							</div>
						))
					)}
				</div>
			)}
		</div>
	);
};
