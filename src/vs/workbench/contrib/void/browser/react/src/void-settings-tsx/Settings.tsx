/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useRef, useState } from 'react';
import {
	BookOpen,
	Bot,
	Brain,
	Cpu,
	Home,
	Palette,
	Search,
	Settings as SettingsIcon,
	Sliders,
	Sparkles,
	Wand2,
	X,
} from 'lucide-react';
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js';
import { useIsDark } from '../util/services.js';
import { displayInfoOfProviderName, nonlocalProviderNames } from '../../../../common/voidSettingsTypes.js';
import { ModelsSection } from './ModelsSettings.js';
import { FeaturesSection } from './FeaturesSettings.js';
import { AgentSection } from './AgentSettings.js';
import { InstructionsSection } from './InstructionsSettings.js';
import { GeneralSection } from './GeneralSettings.js';
import { SettingsHomeSection, SettingsNavigateTarget } from './SettingsHomeSection.js';
import { AppearanceSection, EditorWorkbenchSection } from './AppearanceEditorSettings.js';
import { OperationsDiagnosticsSection } from './OperationsDiagnosticsSettings.js';
import { DesignIntelligenceSection } from './DesignIntelligenceSettings.js';
import { AIEngineSettingsSection } from './AIEngineSettings.js';
import { SettingsSearchContext } from './SettingsControls.js';

type SectionId = SettingsNavigateTarget;

interface NavSectionDef {
	id: SectionId;
	group: 'Workspace' | 'AI Engine' | 'Intelligence & Ops' | 'System';
	label: string;
	icon: React.ReactNode;
	keywordsOfGroup: { [groupTitle: string]: readonly string[] };
}

const SECTIONS: readonly NavSectionDef[] = [
	{
		id: 'home',
		group: 'Workspace',
		label: 'Home',
		icon: <Home size={14} />,
		keywordsOfGroup: {
			'Current configuration': ['overview', 'summary', 'home', 'status', 'dashboard'],
			'Recommended profiles': ['preset', 'profile', 'balanced', 'autopilot', 'strict', 'recommended'],
			'Quick navigation': ['quick', 'shortcuts', 'jump'],
			'Recently changed settings': ['recent', 'history', 'changed'],
		},
	},
	{
		id: 'appearance',
		group: 'Workspace',
		label: 'Appearance & Themes',
		icon: <Palette size={14} />,
		keywordsOfGroup: {
			'Kodia signature themes': ['theme', 'dark', 'light', 'obsidian', 'midnight', 'daylight', 'color', 'appearance', 'icon'],
			'Accent color': ['accent', 'color', 'cobalt', 'emerald', 'violet', 'cyan', 'amber', 'rose', 'brand', 'highlight'],
			'Interface scale & accessibility': ['zoom', 'scale', 'accessibility', 'motion', 'reduced motion', 'animations'],
		},
	},
	{
		id: 'editor',
		group: 'Workspace',
		label: 'Editor & Workbench',
		icon: <Sliders size={14} />,
		keywordsOfGroup: {
			'Typography & font rendering': ['font', 'family', 'size', 'weight', 'line height', 'letter spacing', 'ligatures', 'typography', 'editor'],
			'Indentation, wrapping & whitespace': ['tab', 'spaces', 'indent', 'word wrap', 'whitespace', 'format'],
			'Navigation, minimap & visual aids': ['minimap', 'sticky scroll', 'breadcrumbs', 'folding', 'line numbers', 'brackets', 'guides', 'workbench'],
			'Cursor & diff visualization': ['cursor', 'caret', 'blinking', 'diff', 'side by side', 'inline diff', 'shortcuts', 'keybindings'],
		},
	},
	{
		id: 'models',
		group: 'AI Engine',
		label: 'Models & Routing',
		icon: <Sparkles size={14} />,
		keywordsOfGroup: {
			'Available models': ['model', 'menu', 'show', 'hide', 'add a model', 'custom model', 'detect', 'refresh', 'override', 'byok'],
			'Model routing & fallbacks': ['fallback', 'routing', 'failover', 'specialist', 'rate limit', '429', 'planner', 'explore', 'council'],
			'Cloud providers': ['provider', 'api key', 'endpoint', 'prompt cache', 'claude', 'nvidia', 'openai', 'gemini', ...nonlocalProviderNames.map(p => displayInfoOfProviderName(p).title)],
			'Web Search Providers': ['web', 'search', 'brave', 'tavily', 'exa', 'you', 'duckduckgo', 'reranker', 'cache', 'research'],
			'Local servers': ['local', 'server', 'endpoint', 'ollama', 'mlx', 'vllm', 'lm studio', 'private', 'offline', 'running'],
		},
	},
	{
		id: 'features',
		group: 'AI Engine',
		label: 'AI Features & Chat',
		icon: <Wand2 size={14} />,
		keywordsOfGroup: {
			'Chat': ['chat', 'model', 'agent', 'plan', 'debug', 'gather', 'ask'],
			'Quick Edit': ['model', 'ctrl+k', 'cmd+k', 'inline edit', 'quick edit'],
			'Apply': ['model', 'fast apply', 'slow apply', 'search/replace', 'rewrite'],
			'Autocomplete': ['model', 'completion', 'fim', 'suggest', 'tab', 'next edit', 'prediction'],
			'Commit messages': ['model', 'source control', 'scm', 'git'],
			'Selection buttons': ['selection', 'add to chat', 'edit inline', 'suggestions', 'floating bar'],
		},
	},
	{
		id: 'agent',
		group: 'AI Engine',
		label: 'Agent, Autonomy & Tools',
		icon: <Bot size={14} />,
		keywordsOfGroup: {
			'Autonomy mode': ['autonomy', 'assist', 'agent', 'autonomous', 'autopilot', 'mode', 'permission', 'behavior'],
			'Task Plan': ['task', 'plan', 'todo', 'roadmap', 'steps', 'decomposition', 'subagents', 'teams', 'background'],
			'Approvals': ['approve', 'auto-approve', 'ask', 'permission', 'edit files', 'filesystem', 'terminal', 'command', 'web pages', 'fetch', 'mcp', 'git', 'test', 'testing', 'debug', 'debugging', 'browser', 'computer use'],
			'Changes': ['accept', 'auto-accept', 'diff', 'review', 'lint', 'errors', 'verify', 'verification', 'checkpoints', 'recovery'],
			'Lifecycle hooks': ['hooks', 'pretooluse', 'posttooluse', 'guard', 'automation', 'workflows', '.kodia/hooks.json', 'claude'],
			'Tool policy': ['tool', 'tools', 'disable', 'enable', 'allow', 'deny', 'block', 'policy', 'permissions'],
			'MCP servers': ['mcp', 'model context protocol', 'plugins', 'extensions', 'integrations', 'tools', 'server'],
		},
	},
	{
		id: 'ai_engine',
		group: 'AI Engine',
		label: 'AI Engineering Engine',
		icon: <Brain size={14} />,
		keywordsOfGroup: {
			'Two-Engine Unified Orchestrator': ['ai', 'orchestrator', 'dual engine', 'factory', 'ml', 'deep learning', 'compute', 'gpu', 'local', 'cloud'],
			'RAG & knowledge indexing defaults': ['rag', 'chunk', 'overlap', 'top-k', 'vector', 'bm25', 'knowledge', 'retrieval'],
			'AI security, governance & budget guardrails': ['prompt injection', 'pii', 'pickle', 'security', 'governance', 'hitl', 'budget', 'spending', 'future', 'capabilities'],
		},
	},
	{
		id: 'design',
		group: 'Intelligence & Ops',
		label: 'Design Intelligence & Brand',
		icon: <Palette size={14} />,
		keywordsOfGroup: {
			'Autonomous design defaults': ['design', 'ui', 'ux', 'visual direction', 'creative', 'tokens', 'palette', 'typography', 'animation', 'motion'],
			'Visual asset discovery & licensing': ['images', 'assets', 'unsplash', 'pexels', 'pixabay', 'openverse', 'wikimedia', 'svg', 'licensing', 'download'],
			'Visual quality QA, responsive & accessibility checks': ['qa', 'responsive', 'mobile', 'screenshots', 'visual regression', 'wcag', 'accessibility', 'contrast', 'playwright'],
			'Project brand system & guidelines': ['brand', 'guidelines', 'logo', 'colors', 'fonts', 'design-system.json', 'restrictions'],
		},
	},
	{
		id: 'instructions',
		group: 'Intelligence & Ops',
		label: 'Instructions, Skills & Memory',
		icon: <BookOpen size={14} />,
		keywordsOfGroup: {
			'Instructions': ['prompt', 'system prompt', 'rules', 'guidelines', 'custom instructions'],
			'Rules files': ['rules', '.voidrules', 'agents.md', 'claude.md', '.cursorrules', '.windsurfrules'],
			'Frameworks': ['guidelines', 'karpathy', 'clean code', 'books', 'download'],
			'Skills': ['skill', 'skills', 'skill.md', 'superpowers', 'bmad', '.claude/skills', '.agents/skills', '.kodia/skills'],
			'Custom slash commands': ['slash', 'command', 'commands', '/review', '.kodia/commands', '.claude/commands', 'workflow', 'workflows'],
			'Project memory': ['memory', 'context', 'knowledge', 'graph', 'digital twin', 'indexing', 'retrieval', 'notes', '.kodia/memory.md'],
			'Advanced': ['system message', 'disable system message'],
		},
	},
	{
		id: 'operations',
		group: 'Intelligence & Ops',
		label: 'Operations, Security & About',
		icon: <Cpu size={14} />,
		keywordsOfGroup: {
			'Environment & runtimes': ['environment', 'toolchain', 'docker', 'container', 'database', 'sqlite', 'infrastructure', 'deployment', 'devops', 'production', 'operations'],
			'Security & safety posture': ['security', 'secret', 'redaction', 'sql', 'injection', 'guard', 'safety', 'audit'],
			'Execution diagnostics & telemetry': ['diagnostics', 'telemetry', 'observability', 'latency', 'performance', 'logs', 'developer tools'],
			'About Kodia': ['about', 'version', 'cli', 'updates', 'kodia', 'platform'],
		},
	},
	{
		id: 'general',
		group: 'System',
		label: 'General, Data & Shortcuts',
		icon: <SettingsIcon size={14} />,
		keywordsOfGroup: {
			'Transfer from another editor': ['transfer', 'import', 'vs code', 'cursor', 'windsurf', 'migrate'],
			'Import and export': ['import', 'export', 'backup', 'storage', 'data', 'json', 'chats'],
			'Usage data': ['metrics', 'telemetry', 'analytics', 'privacy', 'opt-out', 'share', 'network'],
			'Editor settings': ['editor', 'keyboard', 'shortcuts', 'keybindings', 'theme', 'logs', 'notifications'],
			'Onboarding': ['welcome', 'setup', 'get started'],
			'Reset': ['delete', 'clear', 'reset settings', 'reset chats', 'restore'],
		},
	},
];

const NAV_GROUPS: readonly NavSectionDef['group'][] = ['Workspace', 'AI Engine', 'Intelligence & Ops', 'System'];

const matchingGroupsOfSection = (section: NavSectionDef, query: string): Set<string> => {
	const queryWords = query.toLowerCase().split(/\s+/).filter(w => !!w);
	const matching = new Set<string>();
	for (const [groupTitle, keywords] of Object.entries(section.keywordsOfGroup)) {
		const text = [section.label, section.group, groupTitle, ...keywords].join(' ').toLowerCase();
		if (queryWords.every(w => text.includes(w))) matching.add(groupTitle);
	}
	return matching;
};

export const Settings = () => {
	const isDark = useIsDark();
	const [selectedId, setSelectedId] = useState<SectionId>('home');
	const [query, setQuery] = useState('');
	const [recentChanges, setRecentChanges] = useState<{ label: string; timestamp: number }[]>([]);
	const scrollRef = useRef<HTMLDivElement>(null);

	const recordChange = useCallback((label: string) => {
		setRecentChanges(prev => [{ label, timestamp: Date.now() }, ...prev].slice(0, 12));
	}, []);

	const navigateTo = useCallback((id: SectionId) => {
		setQuery('');
		setSelectedId(id);
		scrollRef.current?.scrollTo({ top: 0 });
	}, []);

	const renderSection = (id: SectionId) => {
		switch (id) {
			case 'home': return <SettingsHomeSection onNavigate={navigateTo} recentChanges={recentChanges} onRecordChange={recordChange} />;
			case 'appearance': return <AppearanceSection onRecordChange={recordChange} />;
			case 'editor': return <EditorWorkbenchSection onRecordChange={recordChange} />;
			case 'models': return <ModelsSection />;
			case 'features': return <FeaturesSection />;
			case 'agent': return <AgentSection />;
			case 'ai_engine': return <AIEngineSettingsSection onRecordChange={recordChange} />;
			case 'design': return <DesignIntelligenceSection onRecordChange={recordChange} />;
			case 'instructions': return <InstructionsSection />;
			case 'operations': return <OperationsDiagnosticsSection />;
			case 'general': return <GeneralSection />;
		}
	};

	const isSearching = !!query.trim();
	const results = isSearching
		? SECTIONS.map(section => ({ section, matchingGroups: matchingGroupsOfSection(section, query) })).filter(r => r.matchingGroups.size > 0)
		: [];

	return (
		<div ref={scrollRef} className={`@@void-scope ${isDark ? 'dark' : ''} bg-void-bg-2 text-void-fg-1`} style={{ height: '100%', width: '100%', overflow: 'auto' }}>
			<div className='flex flex-col md:flex-row w-full max-w-[1160px] mx-auto mb-28 px-4 md:px-6' style={{ minHeight: '90vh' }}>

				{/* Navigation Sidebar */}
				<aside className='md:w-64 w-full py-6 md:pr-6 md:border-r border-void-border-2 shrink-0'>
					<div className='md:sticky md:top-6 flex flex-col gap-5'>
						<div>
							<div className='flex items-center gap-2'>
								<span
									style={{ backgroundColor: 'var(--kodia-accent)', color: 'var(--kodia-accent-fg)' }}
									className='w-6 h-6 rounded-md flex items-center justify-center text-xs font-bold shadow-xs'
								>
									K
								</span>
								<h1 className='text-lg font-semibold tracking-tight text-void-fg-1'>Kodia Settings</h1>
							</div>
							<p className='text-[11px] text-void-fg-3 mt-1'>Workbench, AI Engine & Operations</p>
						</div>

						{/* Search Box */}
						<div className='relative'>
							<Search size={13} className='absolute left-2.5 top-1/2 -translate-y-1/2 text-void-fg-3 pointer-events-none' />
							<input
								type='text'
								value={query}
								onChange={e => {
									setQuery(e.target.value);
									scrollRef.current?.scrollTo({ top: 0 });
								}}
								onKeyDown={e => { if (e.key === 'Escape') setQuery(''); }}
								placeholder='Search all settings…'
								aria-label='Search Kodia settings'
								className='w-full pl-8 pr-7 py-1.5 text-xs rounded-md bg-void-bg-1 border border-void-border-2 text-void-fg-1 placeholder:text-void-fg-3 focus:border-[var(--kodia-accent)]'
							/>
							{query && (
								<button
									type='button'
									onClick={() => setQuery('')}
									aria-label='Clear search'
									className='absolute right-2 top-1/2 -translate-y-1/2 text-void-fg-3 hover:text-void-fg-1 cursor-pointer'
								>
									<X size={12} />
								</button>
							)}
						</div>

						{/* Grouped Navigation */}
						<nav aria-label='Kodia Settings Categories' className='flex flex-col gap-4'>
							{NAV_GROUPS.map(groupName => (
								<div key={groupName} className='flex flex-col gap-1'>
									<div className='px-2.5 text-[10px] font-semibold uppercase tracking-wider text-void-fg-3'>
										{groupName}
									</div>
									{SECTIONS.filter(s => s.group === groupName).map(sec => {
										const active = !isSearching && selectedId === sec.id;
										return (
											<button
												key={sec.id}
												type='button'
												onClick={() => navigateTo(sec.id)}
												style={active ? { backgroundColor: 'var(--kodia-accent)', color: 'var(--kodia-accent-fg)' } : undefined}
												className={`flex items-center gap-2.5 py-1.5 px-2.5 rounded-md text-xs text-left transition-all cursor-pointer ${active
													? 'font-medium shadow-xs'
													: 'text-void-fg-2 hover:bg-void-bg-3 hover:text-void-fg-1'
													}`}
											>
												<span className='opacity-85 shrink-0'>{sec.icon}</span>
												<span className='truncate'>{sec.label}</span>
											</button>
										);
									})}
								</div>
							))}
						</nav>
					</div>
				</aside>

				{/* Main Content Area */}
				<main className='flex-1 min-w-0 py-6 md:pl-8 select-none'>
					<div className='max-w-3xl'>
						{!isSearching ? (
							<ErrorBoundary key={selectedId}>
								{renderSection(selectedId)}
							</ErrorBoundary>
						) : results.length === 0 ? (
							<div className='rounded-lg border border-dashed border-void-border-2 p-8 text-center'>
								<div className='text-sm font-medium text-void-fg-1'>{`No settings match "${query.trim()}"`}</div>
								<div className='text-xs text-void-fg-3 mt-1'>Try searching for theme, font, minimap, fallback, hooks, docker, sqlite, memory, or shortcuts.</div>
							</div>
						) : (
							<div className='flex flex-col gap-12'>
								<div className='text-xs text-void-fg-3'>
									Found matching groups across <span className='text-void-fg-1 font-medium'>{results.length}</span> section(s) for &ldquo;{query.trim()}&rdquo;
								</div>
								{results.map(({ section: { id }, matchingGroups }) => (
									<SettingsSearchContext.Provider key={id} value={matchingGroups}>
										<ErrorBoundary>
											{renderSection(id)}
										</ErrorBoundary>
									</SettingsSearchContext.Provider>
								))}
							</div>
						)}
					</div>
				</main>
			</div>
		</div>
	);
};
