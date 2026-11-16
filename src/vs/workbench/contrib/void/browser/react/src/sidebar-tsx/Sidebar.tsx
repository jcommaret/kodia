/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { useState } from 'react';
import { useIsDark } from '../util/services.js';

import '../styles.css'
import { SidebarChat } from './SidebarChat.js';
import { CodeIndexPanel } from './CodeIndexPanel.js';
import { TaskPlanPanel } from './TaskPlanPanel.js';
import ErrorBoundary from './ErrorBoundary.js';

export const Sidebar = ({ className }: { className: string }) => {

	const isDark = useIsDark()
	const [activePanel, setActivePanel] = useState<'chat' | 'code-index' | 'task-plan'>('chat')
	return <div
		className={`@@void-scope ${isDark ? 'dark' : ''}`}
		style={{ width: '100%', height: '100%' }}
	>
		<div
			className={`w-full h-full bg-void-bg-2 text-void-fg-1`}
		>

			<div className={`w-full h-full overflow-hidden`}>
				<ErrorBoundary>
					<div className='flex h-full'>
						{/* Chat sidebar */}
						{activePanel === 'chat' && (
							<div className='w-full h-full'>
								<ErrorBoundary>
									<SidebarChat />
								</ErrorBoundary>
							</div>
						)}
						{/* Code Index panel */}
						{activePanel === 'code-index' && (
							<div className='w-full h-full overflow-y-auto bg-void-bg-2 text-void-fg-1'>
								<div className='flex items-center justify-between p-2 border-b border-void-border-2'>
									<h3 className='text-xs font-semibold text-void-fg-1'>Code Index</h3>
									<button
										onClick={() => setActivePanel('chat')}
										className='px-2 py-1 text-[10px] rounded border border-void-border-2 bg-void-bg-3 text-void-fg-3 hover:bg-void-bg-4'
									>
										×
									</button>
								</div>
								<ErrorBoundary>
									<CodeIndexPanel />
								</ErrorBoundary>
							</div>
						)}
						{/* Task Plan panel */}
						{activePanel === 'task-plan' && (
							<div className='w-full h-full overflow-y-auto bg-void-bg-2 text-void-fg-1'>
								<div className='flex items-center justify-between p-2 border-b border-void-border-2'>
									<h3 className='text-xs font-semibold text-void-fg-1'>Task Plan</h3>
									<button
										onClick={() => setActivePanel('chat')}
										className='px-2 py-1 text-[10px] rounded border border-void-border-2 bg-void-bg-3 text-void-fg-3 hover:bg-void-bg-4'
									>
										×
									</button>
								</div>
								<ErrorBoundary>
									<TaskPlanPanel />
								</ErrorBoundary>
							</div>
						)}
					</div>
				</ErrorBoundary>

				{/* Panel toggle buttons at bottom */}
				<div className='absolute bottom-2 left-2 z-10 flex gap-1'>
					<button
						onClick={() => setActivePanel('chat')}
						className={`flex items-center gap-2 px-3 py-2 text-xs rounded border border-void-border-2 ${activePanel === 'chat' ? 'bg-void-bg-3 text-void-fg-1' : 'bg-void-bg-2 text-void-fg-3'} hover:bg-void-bg-3 shadow-md`}
					>
						💬 Chat
					</button>
					<button
						onClick={() => setActivePanel('code-index')}
						className={`flex items-center gap-2 px-3 py-2 text-xs rounded border border-void-border-2 ${activePanel === 'code-index' ? 'bg-void-bg-3 text-void-fg-1' : 'bg-void-bg-2 text-void-fg-3'} hover:bg-void-bg-3 shadow-md`}
					>
						🔍 Index
					</button>
					<button
						onClick={() => setActivePanel('task-plan')}
						className={`flex items-center gap-2 px-3 py-2 text-xs rounded border border-void-border-2 ${activePanel === 'task-plan' ? 'bg-void-bg-3 text-void-fg-1' : 'bg-void-bg-2 text-void-fg-3'} hover:bg-void-bg-3 shadow-md`}
					>
						📋 Plan
					</button>
				</div>
			</div>
		</div>
	</div>
}
