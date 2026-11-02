/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { useRef, useState } from 'react';
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js'
import { useIsDark } from '../util/services.js'
import { ModelsSection } from './ModelsSettings.js'
import { FeaturesSection } from './FeaturesSettings.js'
import { AgentSection } from './AgentSettings.js'
import { InstructionsSection } from './InstructionsSettings.js'
import { GeneralSection } from './GeneralSettings.js'

// One page per goal: the models Kodia can use, what each feature uses, what the agent may do,
// what the AI is told, and the rest
const sections = [
	{ id: 'models', label: 'Models', Section: ModelsSection },
	{ id: 'features', label: 'Features', Section: FeaturesSection },
	{ id: 'agent', label: 'Agent', Section: AgentSection },
	{ id: 'instructions', label: 'Instructions & Context', Section: InstructionsSection },
	{ id: 'general', label: 'General', Section: GeneralSection },
] as const

type SectionId = typeof sections[number]['id']

export const Settings = () => {
	const isDark = useIsDark()
	const [selectedId, setSelectedId] = useState<SectionId>('models')
	const scrollRef = useRef<HTMLDivElement>(null)

	const { Section } = sections.find(s => s.id === selectedId) ?? sections[0]

	return (
		<div ref={scrollRef} className={`@@void-scope ${isDark ? 'dark' : ''}`} style={{ height: '100%', width: '100%', overflow: 'auto' }}>
			<div className="flex flex-col md:flex-row w-full gap-6 max-w-[900px] mx-auto mb-32" style={{ minHeight: '80vh' }}>

				<aside className="md:w-1/4 w-full p-6 shrink-0">
					<h1 className='text-3xl font-medium mt-6 mb-6'>{`Kodia's Settings`}</h1>
					<nav className="flex flex-col gap-2">
						{sections.map(({ id, label }) => (
							<button
								key={id}
								onClick={() => {
									setSelectedId(id)
									scrollRef.current?.scrollTo({ top: 0 })
								}}
								className={`py-2 px-4 rounded-md text-left transition-all duration-200
									${selectedId === id
										? 'bg-[#0e70c0]/80 text-white font-medium shadow-sm'
										: 'bg-void-bg-2 hover:bg-void-bg-2/80 text-void-fg-1'}
								`}
							>
								{label}
							</button>
						))}
					</nav>
				</aside>

				<main className="flex-1 p-6 pt-[4.5rem] select-none">
					<div className='max-w-3xl'>
						<ErrorBoundary key={selectedId}>
							<Section />
						</ErrorBoundary>
					</div>
				</main>
			</div>
		</div>
	);
}
