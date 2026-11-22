/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useMemo, useState } from 'react';
import { Bot, CheckCircle2, ExternalLink, Loader2, ShieldAlert, Square, Users, XCircle, Check, X } from 'lucide-react';
import { useAccessor, useChatThreadsState, useFullChatThreadsStreamState } from '../util/services.js';
import { BuiltinSubagentType, SUBAGENT_TYPES } from '../../../../common/subagents.js';
import { ThreadType } from '../../../chatThreadService.js';

export const AgentTeamPanel = ({ onOpenThread }: { onOpenThread?: () => void }) => {
	const accessor = useAccessor();
	const chatThreadService = accessor.get('IChatThreadService');
	const threadsState = useChatThreadsState();
	const streamStates = useFullChatThreadsStreamState();
	const [showRoster, setShowRoster] = useState(false);

	const currentThread = threadsState.allThreads[threadsState.currentThreadId];
	const rootParentId = currentThread?.subagentOf?.parentThreadId ?? threadsState.currentThreadId;

	const subagentThreads = useMemo(() => {
		const list: ThreadType[] = [];
		for (const id of Object.keys(threadsState.allThreads)) {
			const t = threadsState.allThreads[id];
			if (!t?.subagentOf) { continue; }
			if (t.subagentOf.parentThreadId === rootParentId || t.id === threadsState.currentThreadId) {
				list.push(t);
			}
		}
		return list.sort((a, b) => (b.lastModified > a.lastModified ? 1 : -1));
	}, [threadsState.allThreads, rootParentId, threadsState.currentThreadId]);

	const allSubagentsCount = useMemo(() => {
		return Object.values(threadsState.allThreads).filter(t => !!t?.subagentOf).length;
	}, [threadsState.allThreads]);

	const openThread = (threadId: string) => {
		chatThreadService.switchToThread(threadId);
		onOpenThread?.();
	};

	const renderSubagentCard = (t: ThreadType) => {
		const info = t.subagentOf!;
		const stream = streamStates[t.id];
		const isRunning = stream?.isRunning;
		const toolMsgs = t.messages.filter(m => m.role === 'tool');
		const failedCount = toolMsgs.filter(m => m.type === 'tool_error' || m.type === 'rejected').length;
		const pendingApproval = toolMsgs.find(m => m.type === 'tool_request');

		return (
			<div key={t.id} className='bg-void-bg-1 border border-void-border-2 rounded p-2.5 space-y-1.5'>
				<div className='flex items-start justify-between gap-2'>
					<div className='min-w-0'>
						<div className='flex items-center gap-1.5'>
							<Bot size={13} className='text-emerald-400 flex-shrink-0' />
							<span className='text-xs font-medium text-void-fg-1 truncate'>{info.description}</span>
						</div>
						<div className='flex items-center gap-1.5 mt-0.5'>
							<span className='text-[10px] px-1.5 py-0.2 rounded bg-void-bg-3 border border-void-border-2 text-void-fg-2'>
								{info.agent}
							</span>
							<span className='text-[10px] text-void-fg-4'>
								{toolMsgs.length} tool{toolMsgs.length === 1 ? '' : 's'}
								{failedCount > 0 ? ` (${failedCount} failed)` : ''}
							</span>
						</div>
					</div>
					<div className='flex items-center gap-1 flex-shrink-0'>
						{isRunning === 'awaiting_user' ? (
							<span className='flex items-center gap-1 text-[10px] text-yellow-400'>
								<ShieldAlert size={11} /> Needs approval
							</span>
						) : isRunning ? (
							<span className='flex items-center gap-1 text-[10px] text-blue-400'>
								<Loader2 size={11} className='animate-spin' /> Running
							</span>
						) : stream?.error ? (
							<span className='flex items-center gap-1 text-[10px] text-red-400'>
								<XCircle size={11} /> Error
							</span>
						) : (
							<span className='flex items-center gap-1 text-[10px] text-green-400'>
								<CheckCircle2 size={11} /> Done
							</span>
						)}
					</div>
				</div>

				{pendingApproval && pendingApproval.role === 'tool' && (
					<div className='bg-yellow-500/10 border border-yellow-500/30 rounded p-1.5 text-[11px] space-y-1.5'>
						<div className='text-yellow-300 truncate'>
							Waiting approval: <code className='font-mono'>{pendingApproval.name}</code>
						</div>
						<div className='flex items-center gap-1.5'>
							<button
								type='button'
								onClick={() => chatThreadService.approveLatestToolRequest(t.id)}
								className='flex items-center gap-1 px-2 py-0.5 text-[10px] rounded bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)]'
							>
								<Check size={10} /> Approve
							</button>
							<button
								type='button'
								onClick={() => chatThreadService.rejectLatestToolRequest(t.id)}
								className='flex items-center gap-1 px-2 py-0.5 text-[10px] rounded bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)]'
							>
								<X size={10} /> Deny
							</button>
						</div>
					</div>
				)}

				<div className='flex items-center justify-between pt-1 border-t border-void-border-2/60'>
					<button
						type='button'
						onClick={() => openThread(t.id)}
						className='flex items-center gap-1 text-[11px] text-void-fg-2 hover:text-void-fg-1'
					>
						<ExternalLink size={11} /> Inspect transcript
					</button>
					{isRunning && (
						<button
							type='button'
							onClick={() => chatThreadService.abortRunning(t.id)}
							className='flex items-center gap-1 text-[11px] text-red-400 hover:text-red-300'
						>
							<Square size={10} /> Stop
						</button>
					)}
				</div>
			</div>
		);
	};

	const specialistRoles = Object.keys(SUBAGENT_TYPES) as BuiltinSubagentType[];

	return (
		<div className='p-3 space-y-3 h-full overflow-y-auto text-void-fg-1'>
			<div className='flex items-center justify-between'>
				<div className='flex items-center gap-1.5'>
					<Users size={14} className='text-void-fg-2' />
					<h2 className='text-xs font-semibold'>Agent Team ({subagentThreads.length})</h2>
				</div>
				<button
					type='button'
					onClick={() => setShowRoster(v => !v)}
					className='text-[11px] px-2 py-0.5 rounded border border-void-border-2 bg-void-bg-1 text-void-fg-2 hover:bg-void-bg-3'
				>
					{showRoster ? 'Show Sessions' : `Specialists (${specialistRoles.length})`}
				</button>
			</div>

			{currentThread?.subagentOf && (
				<button
					type='button'
					onClick={() => openThread(currentThread.subagentOf!.parentThreadId)}
					className='w-full text-left text-[11px] px-2 py-1.5 rounded border border-blue-500/30 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20'
				>
					← Back to parent orchestrator thread
				</button>
			)}

			{showRoster ? (
				<div className='space-y-1.5'>
					<div className='text-[11px] text-void-fg-3'>
						Built-in specialist roles available via <code className='px-1 bg-void-bg-3 rounded'>subagent</code> (plus custom agents in <code className='px-1 bg-void-bg-3 rounded'>.kodia/agents/*.md</code>):
					</div>
					{specialistRoles.map(role => {
						const p = SUBAGENT_TYPES[role];
						return (
							<div key={role} className='bg-void-bg-1 border border-void-border-2 rounded p-2'>
								<div className='flex items-center justify-between'>
									<span className='text-xs font-medium font-mono'>{role}</span>
									<span className={`text-[9px] px-1.5 py-0.2 rounded border ${p.canChangeFiles
										? 'border-blue-500/30 bg-blue-500/10 text-blue-300'
										: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
										}`}>
										{p.canChangeFiles ? 'read/write' : 'read-only'}
									</span>
								</div>
								<div className='text-[11px] text-void-fg-3 mt-0.5'>{p.description}</div>
							</div>
						);
					})}
				</div>
			) : subagentThreads.length === 0 ? (
				<div className='bg-void-bg-1 border border-void-border-2 rounded p-3 text-center space-y-1'>
					<div className='text-xs text-void-fg-2'>No subagents delegated in this thread yet.</div>
					<div className='text-[11px] text-void-fg-3'>
						When Kodia delegates parallel or specialist work, live subagent status, tool counts, file ownership, and approvals appear here.
					</div>
					{allSubagentsCount > 0 && (
						<div className='text-[10px] text-void-fg-4 pt-1'>
							({allSubagentsCount} subagent session{allSubagentsCount === 1 ? '' : 's'} in other threads)
						</div>
					)}
				</div>
			) : (
				<div className='space-y-2'>
					{subagentThreads.map(renderSubagentCard)}
				</div>
			)}
		</div>
	);
};
