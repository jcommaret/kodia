/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccessor, useChatThreadsState, useIsDark } from '../util/services.js';
import { Activity, BookOpen, Brain, ClipboardList, Factory, History, MessageCircle, Palette, Server, Settings, ShieldCheck, Users, Workflow } from 'lucide-react';

import '../styles.css';
import { SidebarChat } from './SidebarChat.js';
import { TaskPlanPanel } from './TaskPlanPanel.js';
import { AgentActivityPanel } from './AgentActivityPanel.js';
import { AgentTeamPanel } from './AgentTeamPanel.js';
import { ContextMemoryPanel } from './ContextMemoryPanel.js';
import { ProjectHealthPanel } from './ProjectHealthPanel.js';
import { ChangesCheckpointsPanel } from './ChangesCheckpointsPanel.js';
import { WorkflowsPanel } from './WorkflowsPanel.js';
import { OpsInspectorPanel } from './OpsInspectorPanel.js';
import { FactoryPanel } from './FactoryPanel.js';
import { DesignStudioPanel } from './DesignStudioPanel.js';
import { AIEngineControlCenter } from './AIEngineControlCenter.js';
import ErrorBoundary from './ErrorBoundary.js';
import { getPlanProgress } from '../../../../common/autonomousTask.js';
import { VOID_OPEN_SETTINGS_ACTION_ID } from '../../../voidSettingsPane.js';

type SidebarTab = 'chat' | 'ai-engine' | 'design' | 'factory' | 'health' | 'task-plan' | 'agents' | 'changes' | 'ops' | 'workflows' | 'activity' | 'context';

const MemoSidebarChat = React.memo(SidebarChat);

/**
 * Isolated Command Center tab bar that tracks coarse running indicators without
 * re-rendering the chat transcript on every streamed LLM token.
 */
const SidebarTabBar = React.memo(({ activePanel, setActivePanel }: { activePanel: SidebarTab; setActivePanel: (tab: SidebarTab) => void }) => {
	const accessor = useAccessor();
	const chatThreadService = accessor.get('IChatThreadService');
	const commandService = accessor.get('ICommandService');
	const threadsState = useChatThreadsState();

	const currentThread = threadsState.allThreads[threadsState.currentThreadId];
	const planBadge = useMemo(() => {
		const plan = currentThread?.taskPlan;
		if (!plan || plan.tasks.length === 0) { return undefined; }
		const { completed, total } = getPlanProgress(plan);
		return `${completed}/${total}`;
	}, [currentThread?.taskPlan]);

	const rootParentId = currentThread?.subagentOf?.parentThreadId ?? threadsState.currentThreadId;
	const subagentIds = useMemo(() => {
		const ids: string[] = [];
		for (const id of Object.keys(threadsState.allThreads)) {
			const t = threadsState.allThreads[id];
			if (t?.subagentOf && t.subagentOf.parentThreadId === rootParentId) {
				ids.push(id);
			}
		}
		return ids;
	}, [threadsState.allThreads, rootParentId]);

	const computeStatus = useCallback(() => {
		const ss = chatThreadService.streamState;
		const isCurrentRunning = !!ss[threadsState.currentThreadId]?.isRunning;
		let activeSubagents = 0;
		for (const id of subagentIds) {
			if (ss[id]?.isRunning) { activeSubagents++; }
		}
		return { isCurrentRunning, activeSubagents };
	}, [chatThreadService, threadsState.currentThreadId, subagentIds]);

	const [runStatus, setRunStatus] = useState(computeStatus);

	useEffect(() => {
		const sync = () => {
			const next = computeStatus();
			setRunStatus(prev => (prev.isCurrentRunning === next.isCurrentRunning && prev.activeSubagents === next.activeSubagents ? prev : next));
		};
		sync();
		const d = chatThreadService.onDidChangeStreamState(sync);
		return () => d.dispose();
	}, [chatThreadService, computeStatus]);

	const changedFileCount = useMemo(() => {
		if (!currentThread) { return 0; }
		return chatThreadService.getThreadChangedFiles(threadsState.currentThreadId).length;
	}, [chatThreadService, threadsState.currentThreadId, currentThread?.messages.length]);

	const tabs: { id: SidebarTab; label: string; title: string; icon: React.ReactNode; badge?: string; pulse?: boolean }[] = [
		{ id: 'chat', label: 'Chat', title: 'AI Engineering Chat & Agent Workspace', icon: <MessageCircle size={12} /> },
		{ id: 'ai-engine', label: 'AI Engine', title: 'Universal AI Engineering Engine: Dual-Engine Factory, Hardware, Hybrid RAG, Models, Evals & Security', icon: <Brain size={12} /> },
		{ id: 'design', label: 'Design', title: 'Autonomous UI/UX Design Studio, Brand System, Assets & Visual QA', icon: <Palette size={12} /> },
		{ id: 'factory', label: 'Factory', title: 'Autonomous Software Factory, Requirements, Autopilot & Architecture Council', icon: <Factory size={12} /> },
		{ id: 'health', label: 'Intel', title: 'Project Health, Digital Twin, Change Impact, Proof Gates & Tech Debt', icon: <ShieldCheck size={12} /> },
		{ id: 'task-plan', label: 'Plan', title: 'Task Plan & Decomposition Board', icon: <ClipboardList size={12} />, badge: planBadge },
		{ id: 'agents', label: 'Agents', title: 'Multi-Agent Workforce & Specialists', icon: <Users size={12} />, badge: subagentIds.length > 0 ? String(subagentIds.length) : undefined, pulse: runStatus.activeSubagents > 0 },
		{ id: 'changes', label: 'Changes', title: 'Unified Inline Diffs, Revert & Named Checkpoints', icon: <History size={12} />, badge: changedFileCount > 0 ? String(changedFileCount) : undefined },
		{ id: 'ops', label: 'Ops', title: 'Environment, Docker Containers & SQLite Database Console', icon: <Server size={12} /> },
		{ id: 'workflows', label: 'Auto', title: 'Reusable Workflows & Scheduled Background Jobs', icon: <Workflow size={12} /> },
		{ id: 'activity', label: 'Activity', title: 'Live Execution Timeline, Spans & Debugger Feed', icon: <Activity size={12} />, pulse: runStatus.isCurrentRunning },
		{ id: 'context', label: 'Context', title: 'Project Memory (.kodia/memory.md) & Context', icon: <BookOpen size={12} /> },
	];

	return (
		<div className='flex items-center gap-1 px-2 py-1.5 border-b border-void-border-2 bg-void-bg-1/90 flex-shrink-0 select-none'>
			<div role='tablist' aria-label='Kodia Command Center Views' className='flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto'>
				{tabs.map(tab => {
					const active = activePanel === tab.id;
					return (
						<button
							key={tab.id}
							role='tab'
							aria-selected={active}
							title={tab.title}
							type='button'
							onClick={() => setActivePanel(tab.id)}
							style={active ? { borderColor: 'var(--kodia-accent)' } : undefined}
							className={`flex items-center gap-1 px-2 py-1 text-[11px] rounded-md transition-all whitespace-nowrap cursor-pointer ${active
								? 'bg-void-bg-3 text-void-fg-1 font-medium border shadow-xs'
								: 'text-void-fg-3 hover:text-void-fg-1 hover:bg-void-bg-2 border border-transparent'
								}`}
						>
							<span className='relative flex items-center'>
								{tab.icon}
								{tab.pulse && (
									<span
										style={{ backgroundColor: 'var(--kodia-accent)' }}
										className='absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full animate-pulse'
									/>
								)}
							</span>
							<span>{tab.label}</span>
							{tab.badge && (
								<span className='text-[9px] px-1 rounded-full bg-void-bg-2 text-void-fg-3 border border-void-border-2'>
									{tab.badge}
								</span>
							)}
						</button>
					);
				})}
			</div>
			<button
				type='button'
				title='Open Kodia Settings'
				aria-label='Open Kodia Settings'
				onClick={() => void commandService.executeCommand(VOID_OPEN_SETTINGS_ACTION_ID)}
				className='p-1 rounded-md text-void-fg-3 hover:text-void-fg-1 hover:bg-void-bg-2 transition-colors flex-shrink-0 cursor-pointer'
			>
				<Settings size={13} />
			</button>
		</div>
	);
});

export const Sidebar = ({ className }: { className: string }) => {
	const isDark = useIsDark();
	const accessor = useAccessor();
	const chatThreadService = accessor.get('IChatThreadService');
	const [activePanel, setActivePanel] = useState<SidebarTab>('chat');

	const sendPromptFromCommandCenter = useCallback((prompt: string) => {
		const tid = chatThreadService.state.currentThreadId;
		setActivePanel('chat');
		if (chatThreadService.streamState[tid]?.isRunning) {
			chatThreadService.enqueueUserMessage(tid, prompt);
		} else {
			void chatThreadService.addUserMessageAndStreamResponse({ userMessage: prompt, threadId: tid });
		}
	}, [chatThreadService]);

	const openChat = useCallback(() => setActivePanel('chat'), []);

	return (
		<div
			className={`@@void-scope ${isDark ? 'dark' : ''}`}
			style={{ width: '100%', height: '100%' }}
		>
			<div className='w-full h-full bg-void-bg-2 text-void-fg-1 flex flex-col overflow-hidden'>
				<SidebarTabBar activePanel={activePanel} setActivePanel={setActivePanel} />

				{/* Active Panel Body */}
				<div className='flex-1 min-h-0 overflow-hidden'>
					<ErrorBoundary>
						{activePanel === 'chat' && (
							<div className='w-full h-full'>
								<ErrorBoundary>
									<MemoSidebarChat />
								</ErrorBoundary>
							</div>
						)}
						{activePanel === 'ai-engine' && (
							<ErrorBoundary>
								<AIEngineControlCenter onOpenChat={openChat} onSendPrompt={sendPromptFromCommandCenter} />
							</ErrorBoundary>
						)}
						{activePanel === 'design' && (
							<ErrorBoundary>
								<DesignStudioPanel onSendPrompt={sendPromptFromCommandCenter} />
							</ErrorBoundary>
						)}
						{activePanel === 'factory' && (
							<ErrorBoundary>
								<FactoryPanel onOpenChat={openChat} />
							</ErrorBoundary>
						)}
						{activePanel === 'health' && (
							<ErrorBoundary>
								<ProjectHealthPanel onSendPrompt={sendPromptFromCommandCenter} />
							</ErrorBoundary>
						)}
						{activePanel === 'activity' && (
							<ErrorBoundary>
								<AgentActivityPanel />
							</ErrorBoundary>
						)}
						{activePanel === 'task-plan' && (
							<ErrorBoundary>
								<TaskPlanPanel />
							</ErrorBoundary>
						)}
						{activePanel === 'agents' && (
							<ErrorBoundary>
								<AgentTeamPanel onOpenThread={openChat} />
							</ErrorBoundary>
						)}
						{activePanel === 'changes' && (
							<ErrorBoundary>
								<ChangesCheckpointsPanel />
							</ErrorBoundary>
						)}
						{activePanel === 'ops' && (
							<ErrorBoundary>
								<OpsInspectorPanel onSendPrompt={sendPromptFromCommandCenter} />
							</ErrorBoundary>
						)}
						{activePanel === 'workflows' && (
							<ErrorBoundary>
								<WorkflowsPanel onOpenThread={openChat} />
							</ErrorBoundary>
						)}
						{activePanel === 'context' && (
							<ErrorBoundary>
								<ContextMemoryPanel />
							</ErrorBoundary>
						)}
					</ErrorBoundary>
				</div>
			</div>
		</div>
	);
};
