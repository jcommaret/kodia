/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { useRef, useState } from 'react';
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js'
import { useIsDark } from '../util/services.js'
import { VoidSimpleInputBox } from '../util/inputs.js'
import { displayInfoOfProviderName, nonlocalProviderNames } from '../../../../common/voidSettingsTypes.js'
import { ModelsSection } from './ModelsSettings.js'
import { FeaturesSection } from './FeaturesSettings.js'
import { AgentSection } from './AgentSettings.js'
import { InstructionsSection } from './InstructionsSettings.js'
import { GeneralSection } from './GeneralSettings.js'
import { SettingsSearchContext } from './SettingsControls.js'

type SectionId = 'models' | 'features' | 'agent' | 'instructions' | 'general'

// One page per goal: the models Kodia can use, what each feature uses, what the agent may do,
// what the AI is told, and the rest. The search finds a section's groups by their title and these words.
const sections: { id: SectionId, label: string, Section: React.ComponentType, keywordsOfGroup: { [groupTitle: string]: readonly string[] } }[] = [
	{
		id: 'models', label: 'Models', Section: ModelsSection, keywordsOfGroup: {
			'Available models': ['model', 'menu', 'show', 'hide', 'add a model', 'custom model', 'detect', 'refresh', 'override'],
			'Cloud providers': ['provider', 'api key', 'endpoint', 'prompt cache', 'claude', ...nonlocalProviderNames.map(p => displayInfoOfProviderName(p).title)],
			'Local servers': ['local', 'server', 'endpoint', 'ollama', 'mlx', 'vllm', 'lm studio', 'private', 'offline', 'running'],
		},
	},
	{
		id: 'features', label: 'Features', Section: FeaturesSection, keywordsOfGroup: {
			'Chat': ['model', 'agent', 'gather'],
			'Quick Edit': ['model', 'ctrl+k', 'cmd+k', '⌘k', 'inline edit'],
			'Apply': ['model', 'fast apply', 'slow apply', 'search/replace', 'rewrite'],
			'Autocomplete': ['model', 'completion', 'fim', 'suggest', 'tab'],
			'Commit messages': ['model', 'source control', 'scm', 'git'],
			'Selection buttons': ['selection', 'add to chat', 'edit inline', 'suggestions'],
		},
	},
	{
		id: 'agent', label: 'Agent', Section: AgentSection, keywordsOfGroup: {
			'Approvals': ['approve', 'auto-approve', 'ask', 'permission', 'edit files', 'terminal', 'command', 'web pages', 'fetch', 'mcp'],
			'Changes': ['accept', 'auto-accept', 'diff', 'review', 'lint', 'errors'],
			'MCP servers': ['mcp', 'model context protocol', 'tools', 'server'],
		},
	},
	{
		id: 'instructions', label: 'Instructions & Context', Section: InstructionsSection, keywordsOfGroup: {
			'Instructions': ['prompt', 'system prompt', 'rules', 'guidelines', 'custom instructions'],
			'Rules files': ['rules', '.voidrules', 'agents.md', 'claude.md', '.cursorrules', '.windsurfrules'],
			'Frameworks': ['guidelines', 'karpathy', 'clean code', 'books', 'download'],
			'Skills': ['skill.md', 'superpowers', 'bmad', '.claude/skills', '.agents/skills', '.kodia/skills'],
			'Project memory': ['memory', 'notes', '.kodia/memory.md', 'write_project_memory'],
			'Advanced': ['system message', 'disable system message'],
		},
	},
	{
		id: 'general', label: 'General', Section: GeneralSection, keywordsOfGroup: {
			'Transfer from another editor': ['transfer', 'import', 'vs code', 'cursor', 'windsurf', 'migrate'],
			'Import and export': ['import', 'export', 'backup', 'json', 'chats'],
			'Usage data': ['metrics', 'telemetry', 'analytics', 'privacy', 'opt-out', 'share'],
			'Editor settings': ['editor', 'keyboard', 'shortcuts', 'keybindings', 'theme', 'logs'],
			'Onboarding': ['welcome', 'setup', 'get started'],
			'Reset': ['delete', 'clear', 'reset settings', 'reset chats'],
		},
	},
]

// the groups of a section whose words contain every word of the query (the section's label counts for all its groups)
const matchingGroupsOfSection = (section: typeof sections[number], query: string): Set<string> => {
	const queryWords = query.toLowerCase().split(/\s+/).filter(w => !!w)
	const matching = new Set<string>()
	for (const [groupTitle, keywords] of Object.entries(section.keywordsOfGroup)) {
		const text = [section.label, groupTitle, ...keywords].join(' ').toLowerCase()
		if (queryWords.every(w => text.includes(w))) matching.add(groupTitle)
	}
	return matching
}

export const Settings = () => {
	const isDark = useIsDark()
	const [selectedId, setSelectedId] = useState<SectionId>('models')
	const [query, setQuery] = useState('')
	const scrollRef = useRef<HTMLDivElement>(null)

	const isSearching = !!query.trim()
	const results = isSearching
		? sections.map(section => ({ section, matchingGroups: matchingGroupsOfSection(section, query) })).filter(r => r.matchingGroups.size > 0)
		: []
	const { Section } = sections.find(s => s.id === selectedId) ?? sections[0]

	return (
		<div ref={scrollRef} className={`@@void-scope ${isDark ? 'dark' : ''}`} style={{ height: '100%', width: '100%', overflow: 'auto' }}>
			<div className="flex flex-col md:flex-row w-full gap-6 max-w-[900px] mx-auto mb-32" style={{ minHeight: '80vh' }}>

				<aside className="md:w-1/4 w-full p-6 shrink-0">
					<h1 className='text-3xl font-medium mt-6 mb-6'>{`Kodia's Settings`}</h1>
					<div className='mb-4'>
						<VoidSimpleInputBox
							value={query}
							onChangeValue={(newQuery) => {
								setQuery(newQuery)
								scrollRef.current?.scrollTo({ top: 0 })
							}}
							onKeyDown={(e) => { if (e.key === 'Escape') setQuery('') }}
							placeholder='Search settings'
							compact={true}
						/>
					</div>
					<nav className="flex flex-col gap-2">
						{sections.map(({ id, label }) => (
							<button
								key={id}
								onClick={() => {
									setQuery('')
									setSelectedId(id)
									scrollRef.current?.scrollTo({ top: 0 })
								}}
								className={`py-2 px-4 rounded-md text-left transition-all duration-200
									${!isSearching && selectedId === id
										? 'bg-[#0e70c0]/80 text-white font-medium shadow-sm'
										: 'bg-void-bg-2 hover:bg-void-bg-2/80 text-void-fg-1'}
								`}
							>
								{label}
							</button>
						))}
					</nav>
				</aside>

				<main className="flex-1 min-w-0 p-6 pt-[4.5rem] select-none">{/* min-w-0: long lines (a skill's path) get cut instead of widening the page */}
					<div className='max-w-3xl'>
						{!isSearching ?
							<ErrorBoundary key={selectedId}>
								<Section />
							</ErrorBoundary>
							: results.length === 0 ?
								<div className='text-root text-void-fg-3'>{`No settings match "${query.trim()}".`}</div>
								: <div className='flex flex-col gap-16'>
									{results.map(({ section: { id, Section }, matchingGroups }) =>
										<SettingsSearchContext.Provider key={id} value={matchingGroups}>
											<ErrorBoundary>
												<Section />
											</ErrorBoundary>
										</SettingsSearchContext.Provider>
									)}
								</div>
						}
					</div>
				</main>
			</div>
		</div>
	);
}
