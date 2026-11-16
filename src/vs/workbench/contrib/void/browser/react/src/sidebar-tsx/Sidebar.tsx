/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { useIsDark } from '../util/services.js';
import { useState } from 'react';
// import { SidebarThreadSelector } from './SidebarThreadSelector.js';
// import { SidebarChat } from './SidebarChat.js';

import '../styles.css'
import { SidebarChat } from './SidebarChat.js';
import { CodeIndexPanel } from './CodeIndexPanel.js';
import ErrorBoundary from './ErrorBoundary.js';

export const Sidebar = ({ className }: { className: string }) => {

	const isDark = useIsDark()
	const [showCodeIndex, setShowCodeIndex] = useState(false)
	return <div
		className={`@@void-scope ${isDark ? 'dark' : ''}`}
		style={{ width: '100%', height: '100%' }}
	>
		<div
			// default background + text styles for sidebar
			className={`w-full h-full bg-void-bg-2 text-void-fg-1`}
		>

			<div className={`w-full h-full`}>
				<ErrorBoundary>
					<div className='flex h-full'>
						{/* Chat sidebar */}
						<div className={showCodeIndex ? 'w-1/2 h-full border-r border-void-border-2' : 'w-full h-full'}>
							<ErrorBoundary>
								<SidebarChat />
							</ErrorBoundary>
						</div>
						{/* Code index panel */}
						{showCodeIndex && (
							<div className='w-1/2 h-full overflow-y-auto bg-void-bg-2 text-void-fg-1'>
								<div className='flex items-center justify-between p-2 border-b border-void-border-2'>
									<h3 className='text-xs font-semibold text-void-fg-1'>Code Index</h3>
									<button
										onClick={() => setShowCodeIndex(false)}
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
					</div>
				</ErrorBoundary>

				{/* Toggle button at bottom */}
				<div className='absolute bottom-2 left-2 z-10'>
					<button
						onClick={() => setShowCodeIndex(!showCodeIndex)}
						className='flex items-center gap-2 px-3 py-2 text-xs rounded border border-void-border-2 bg-void-bg-2 text-void-fg-1 hover:bg-void-bg-3 shadow-md'
					>
						{showCodeIndex ? 'Hide' : '🔍'}
						{showCodeIndex ? 'Code Index' : 'Index'}
					</button>
				</div>
			</div>
		</div>
	</div>
}
