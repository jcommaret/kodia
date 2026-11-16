/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useState } from 'react';

import { useAccessor } from '../util/services.js';
import { TaskPlan, TaskStatus, getPlanProgress } from '../../../../common/autonomousTask.js';
import { ClipboardList, Circle, Check, X, AlertTriangle } from 'lucide-react';

export const TaskPlanPanel = () => {
	const accessor = useAccessor()
	const chatThreadService = accessor.get('IChatThreadService')
	const taskPlanService = accessor.get('ITaskPlanService')

	const [taskPlan, setTaskPlan] = useState<TaskPlan | null>(null)

	const refreshPlan = useCallback(() => {
		try {
			const thread = chatThreadService?.getCurrentThread()
			if (thread) {
				setTaskPlan(thread.taskPlan ?? null)
			}
		} catch (e) {
			console.error('TaskPlanPanel refresh error:', e)
		}
	}, [chatThreadService])

	const subscribeToPlan = useCallback(() => {
		try {
			if (taskPlanService && taskPlanService.onDidChangePlan) {
				const disposable = taskPlanService.onDidChangePlan(({ threadId, plan }) => {
					const currentThread = chatThreadService?.getCurrentThread()
					if (currentThread && currentThread.id === threadId) {
						setTaskPlan(plan)
					}
				})
				return disposable
			}
		} catch (e) {
			console.error('TaskPlanPanel subscribe error:', e)
		}
		return { dispose: () => {} }
	}, [taskPlanService, chatThreadService])

	useEffect(() => {
		refreshPlan()
		const disposable = subscribeToPlan()
		return () => disposable.dispose()
	}, [refreshPlan, subscribeToPlan])

	const { completed, total, percent } = taskPlan ? getPlanProgress(taskPlan) : { completed: 0, total: 0, percent: 0 }

	const statusColors: { [key in TaskPlan['overallStatus']]: string } = {
		pending: 'text-void-fg-3',
		'in_progress': 'text-[#0e70c0]',
		completed: 'text-green-500',
		failed: 'text-red-500',
	}

	const statusIcons: { [key in TaskStatus]: React.ReactNode } = {
		pending: <Circle size={10} className="text-void-fg-3" />,
		running: <Circle size={10} className="text-[#0e70c0] fill-current" />,
		completed: <Check size={10} className="text-green-500" />,
		failed: <X size={10} className="text-red-500" />,
		blocked: <AlertTriangle size={10} className="text-orange-500" />,
	}

	return (
		<div className='p-3 space-y-3 min-w-0'>
			<div className='flex items-center gap-2 mb-2'>
				<h2 className='text-sm font-semibold text-void-fg-1'><ClipboardList size={14} className="mr-1" /> Task Plan</h2>
				{taskPlan && (
					<span className={`text-xs font-medium ${statusColors[taskPlan.overallStatus]}`}>
						{statusIcons[taskPlan.overallStatus]} {taskPlan.overallStatus}
					</span>
				)}
			</div>

			{taskPlan ? (
				<>
					<div className='bg-void-bg-2 border border-void-border-2 rounded p-3'>
						<h3 className='text-sm font-medium text-void-fg-1 mb-1'>{taskPlan.title}</h3>
						<div className='text-[10px] text-void-fg-3 mb-3'>{taskPlan.description}</div>

						<div className='mb-3'>
							<div className='flex items-center justify-between text-xs text-void-fg-3 mb-1'>
								<span>Progress</span>
								<span>{percent}%</span>
							</div>
							<div className='w-full h-2 bg-void-bg-1 rounded-full overflow-hidden'>
								<div
									className='h-full bg-void-fg-3 rounded-full transition-all duration-300'
									style={{ width: `${percent}%` }}
								/>
							</div>
							<div className='flex justify-between text-[10px] text-void-fg-3 mt-1'>
								<span>{completed} / {total} tasks</span>
								<span>{percent}% complete</span>
							</div>
						</div>

						<div className='max-h-[300px] overflow-y-auto space-y-1'>
							{taskPlan.tasks.length === 0 ? (
								<div className='p-2 text-xs text-void-fg-3 italic'>No tasks yet.</div>
							) : (
								taskPlan.tasks.map((t, i) => (
									<div key={i} className='flex items-start gap-2 p-1.5 rounded border border-void-border-2 bg-void-bg-1/50'>
										<span className={`text-xs mt-0.5 flex-shrink-0 ${t.status === 'completed' ? 'text-green-500' : t.status === 'failed' ? 'text-red-500' : t.status === 'running' ? 'text-[#0e70c0]' : t.status === 'blocked' ? 'text-orange-500' : 'text-void-fg-3'}`}>
											{statusIcons[t.status]}
										</span>
										<div className='flex-1 min-w-0'>
											<div className='text-xs font-medium text-void-fg-2 truncate'>{t.title}</div>
											<div className='text-[10px] text-void-fg-3 truncate'>{t.description}</div>
											{t.dependencies && t.dependencies.length > 0 && (
												<div className='text-[9px] text-void-fg-4 mt-0.5'>
													Depends on: {t.dependencies.join(', ')}
												</div>
											)}
											{t.error && (
												<div className='text-[10px] text-red-500 mt-0.5 break-words'>{t.error}</div>
											)}
										</div>
									</div>
								))
							)}
						</div>
					</div>
				</>
			) : (
				<div className='bg-void-bg-2 border border-void-border-2 rounded p-3 text-center'>
					<div className='text-xs text-void-fg-3'>
						No task plan active.
						<br />
						<span className='text-[10px] text-void-fg-4'>Plans appear when the agent works on large projects with many steps.</span>
					</div>
				</div>
			)}
		</div>
	)
}