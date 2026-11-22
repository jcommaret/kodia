/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useEffect, useState } from 'react';
import { ClipboardList, Circle, Check, X, AlertTriangle, RotateCcw, Plus, Trash2, Bot, Loader2 } from 'lucide-react';
import { useAccessor, useChatThreadsState } from '../util/services.js';
import { TaskPlan, TaskPriority, TaskStatus, getParallelReadyTasks, getPlanProgress } from '../../../../common/autonomousTask.js';

export const TaskPlanPanel = () => {
	const accessor = useAccessor();
	const chatThreadService = accessor.get('IChatThreadService');
	const taskPlanService = accessor.get('ITaskPlanService');
	const threadsState = useChatThreadsState();
	const threadId = threadsState.currentThreadId;

	const [taskPlan, setTaskPlan] = useState<TaskPlan | null>(null);
	const [adding, setAdding] = useState(false);
	const [newTitle, setNewTitle] = useState('');
	const [newDesc, setNewDesc] = useState('');
	const [newPriority, setNewPriority] = useState<TaskPriority>('medium');
	const [newAgent, setNewAgent] = useState('');

	useEffect(() => {
		const thread = chatThreadService.state.allThreads[threadId];
		const persisted = thread?.taskPlan ?? null;
		if (persisted) {
			taskPlanService.hydratePlan(threadId, persisted);
		}
		setTaskPlan(taskPlanService.getPlan(threadId) ?? persisted);

		const d = taskPlanService.onDidChangePlan(({ threadId: changedId, plan }) => {
			if (changedId === threadId) {
				setTaskPlan(plan);
			}
		});
		return () => d.dispose();
	}, [chatThreadService, taskPlanService, threadId, threadsState.allThreads[threadId]?.taskPlan]);

	const handleAddTask = () => {
		const title = newTitle.trim();
		if (!title) { return; }
		if (!taskPlan) {
			taskPlanService.createPlan(threadId, 'Execution Plan', 'Interactive engineering task plan', [{
				title,
				description: newDesc.trim() || title,
				dependencies: [],
				priority: newPriority,
				...(newAgent.trim() ? { assignedAgent: newAgent.trim() } : {}),
			}]);
		} else {
			taskPlanService.addTask(threadId, {
				title,
				description: newDesc.trim() || title,
				dependencies: [],
				priority: newPriority,
				...(newAgent.trim() ? { assignedAgent: newAgent.trim() } : {}),
			});
		}
		setNewTitle('');
		setNewDesc('');
		setNewAgent('');
		setAdding(false);
	};

	const { completed, total, percent } = taskPlan ? getPlanProgress(taskPlan) : { completed: 0, total: 0, percent: 0 };
	const readyIds = new Set(taskPlan ? getParallelReadyTasks(taskPlan).map(t => t.id) : []);

	const overallColors: Record<TaskPlan['overallStatus'], string> = {
		pending: 'text-void-fg-3 border-void-border-2 bg-void-bg-1',
		in_progress: 'text-blue-400 border-blue-500/30 bg-blue-500/10',
		completed: 'text-green-400 border-green-500/30 bg-green-500/10',
		failed: 'text-red-400 border-red-500/30 bg-red-500/10',
	};

	const statusIcons: Record<TaskStatus, React.ReactNode> = {
		pending: <Circle size={11} className='text-void-fg-3' />,
		running: <Loader2 size={11} className='text-blue-400 animate-spin' />,
		completed: <Check size={11} className='text-green-500' />,
		failed: <X size={11} className='text-red-500' />,
		blocked: <AlertTriangle size={11} className='text-orange-500' />,
	};

	const priorityBadge = (p?: TaskPriority) => {
		if (!p || p === 'medium') { return null; }
		return (
			<span className={`text-[9px] uppercase px-1 rounded border ${p === 'high'
				? 'border-red-500/30 bg-red-500/10 text-red-400'
				: 'border-void-border-2 bg-void-bg-3 text-void-fg-4'
				}`}>
				{p}
			</span>
		);
	};

	return (
		<div className='p-3 space-y-3 h-full overflow-y-auto text-void-fg-1'>
			<div className='flex items-center justify-between gap-2'>
				<div className='flex items-center gap-1.5 min-w-0'>
					<ClipboardList size={14} className='text-void-fg-2 flex-shrink-0' />
					<h2 className='text-xs font-semibold truncate'>Task Plan</h2>
					{taskPlan && (
						<span className={`text-[10px] px-1.5 py-0.2 rounded border ${overallColors[taskPlan.overallStatus]}`}>
							{taskPlan.overallStatus.replace('_', ' ')}
						</span>
					)}
				</div>
				<button
					type='button'
					onClick={() => setAdding(v => !v)}
					className='flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border border-void-border-2 bg-void-bg-1 text-void-fg-2 hover:bg-void-bg-3'
				>
					<Plus size={11} /> Add
				</button>
			</div>

			{adding && (
				<div className='bg-void-bg-1 border border-void-border-2 rounded p-2.5 space-y-2'>
					<input
						type='text'
						value={newTitle}
						onChange={e => setNewTitle(e.target.value)}
						placeholder='Task title...'
						className='w-full px-2 py-1 text-xs rounded bg-void-bg-2 border border-void-border-2 text-void-fg-1 focus:outline-none focus:border-void-border-1'
					/>
					<input
						type='text'
						value={newDesc}
						onChange={e => setNewDesc(e.target.value)}
						placeholder='Description / acceptance goal (optional)...'
						className='w-full px-2 py-1 text-xs rounded bg-void-bg-2 border border-void-border-2 text-void-fg-1 focus:outline-none focus:border-void-border-1'
					/>
					<div className='flex items-center gap-2'>
						<select
							value={newPriority}
							onChange={e => setNewPriority(e.target.value as TaskPriority)}
							className='px-1.5 py-1 text-[11px] rounded bg-void-bg-2 border border-void-border-2 text-void-fg-1'
						>
							<option value='high'>High priority</option>
							<option value='medium'>Medium priority</option>
							<option value='low'>Low priority</option>
						</select>
						<input
							type='text'
							value={newAgent}
							onChange={e => setNewAgent(e.target.value)}
							placeholder='Specialist (e.g. backend)'
							className='flex-1 px-2 py-1 text-[11px] rounded bg-void-bg-2 border border-void-border-2 text-void-fg-1'
						/>
					</div>
					<div className='flex justify-end gap-1.5'>
						<button type='button' onClick={() => setAdding(false)} className='px-2 py-0.5 text-[11px] rounded border border-void-border-2 text-void-fg-3'>
							Cancel
						</button>
						<button
							type='button'
							disabled={!newTitle.trim()}
							onClick={handleAddTask}
							className='px-2.5 py-0.5 text-[11px] rounded bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] disabled:opacity-40'
						>
							Save Task
						</button>
					</div>
				</div>
			)}

			{taskPlan ? (
				<div className='bg-void-bg-1 border border-void-border-2 rounded p-3 space-y-3'>
					<div>
						<h3 className='text-xs font-semibold text-void-fg-1'>{taskPlan.title}</h3>
						{taskPlan.description && (
							<div className='text-[11px] text-void-fg-3 mt-0.5'>{taskPlan.description}</div>
						)}
					</div>

					<div>
						<div className='flex items-center justify-between text-[11px] text-void-fg-3 mb-1'>
							<span>{completed} / {total} completed</span>
							<span>{percent}%</span>
						</div>
						<div className='w-full h-1.5 bg-void-bg-3 rounded-full overflow-hidden'>
							<div
								className='h-full bg-green-500/80 rounded-full transition-all duration-300'
								style={{ width: `${percent}%` }}
							/>
						</div>
					</div>

					<div className='space-y-1.5'>
						{taskPlan.tasks.length === 0 ? (
							<div className='p-2 text-xs text-void-fg-3 italic'>No tasks in this plan yet.</div>
						) : (
							taskPlan.tasks.map(t => (
								<div key={t.id} className='p-2 rounded border border-void-border-2 bg-void-bg-2/70 space-y-1'>
									<div className='flex items-start justify-between gap-2'>
										<div className='flex items-start gap-2 min-w-0'>
											<span className='mt-0.5 flex-shrink-0'>{statusIcons[t.status]}</span>
											<div className='min-w-0'>
												<div className='flex items-center flex-wrap gap-1.5'>
													<span className='text-xs font-medium text-void-fg-1'>{t.title}</span>
													{priorityBadge(t.priority)}
													{readyIds.has(t.id) && (
														<span className='text-[9px] px-1 rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-400'>
															ready
														</span>
													)}
													{t.assignedAgent && (
														<span className='flex items-center gap-0.5 text-[9px] px-1 rounded border border-void-border-2 bg-void-bg-3 text-void-fg-2'>
															<Bot size={9} /> {t.assignedAgent}
														</span>
													)}
												</div>
												{t.description && t.description !== t.title && (
													<div className='text-[11px] text-void-fg-3 mt-0.5 break-words'>{t.description}</div>
												)}
											</div>
										</div>
										<div className='flex items-center gap-1 flex-shrink-0'>
											{(t.status === 'failed' || t.status === 'blocked') && (
												<button
													type='button'
													title='Retry task'
													onClick={() => taskPlanService.retryTask(threadId, t.id)}
													className='p-1 rounded hover:bg-void-bg-3 text-blue-400'
												>
													<RotateCcw size={11} />
												</button>
											)}
											{t.status === 'pending' && (
												<button
													type='button'
													title='Mark completed'
													onClick={() => taskPlanService.updateTask(threadId, t.id, 'completed', 'Marked completed by user')}
													className='p-1 rounded hover:bg-void-bg-3 text-green-400'
												>
													<Check size={11} />
												</button>
											)}
											<button
												type='button'
												title='Remove task'
												onClick={() => taskPlanService.removeTask(threadId, t.id)}
												className='p-1 rounded hover:bg-void-bg-3 text-void-fg-4 hover:text-red-400'
											>
												<Trash2 size={11} />
											</button>
										</div>
									</div>

									{t.dependencies.length > 0 && (
										<div className='text-[10px] text-void-fg-4 pl-5'>
											Depends on: {t.dependencies.join(', ')}
										</div>
									)}
									{t.acceptanceCriteria && t.acceptanceCriteria.length > 0 && (
										<div className='text-[10px] text-void-fg-3 pl-5'>
											Criteria: {t.acceptanceCriteria.join(' • ')}
										</div>
									)}
									{t.result && (
										<div className='text-[10px] text-green-400/90 pl-5 break-words'>{t.result}</div>
									)}
									{t.evidence && (
										<div className='text-[10px] text-void-fg-3 pl-5 break-words'>Evidence: {t.evidence}</div>
									)}
									{t.error && (
										<div className='text-[10px] text-red-400 pl-5 break-words'>{t.error}</div>
									)}
								</div>
							))
						)}
					</div>
				</div>
			) : (
				<div className='bg-void-bg-1 border border-void-border-2 rounded p-4 text-center space-y-1'>
					<div className='text-xs text-void-fg-2'>No active task plan for this thread.</div>
					<div className='text-[11px] text-void-fg-3'>
						Plans appear automatically when Kodia calls <code className='px-1 bg-void-bg-3 rounded'>create_task_plan</code>, or click <strong>Add</strong> to create one.
					</div>
				</div>
			)}
		</div>
	);
};
