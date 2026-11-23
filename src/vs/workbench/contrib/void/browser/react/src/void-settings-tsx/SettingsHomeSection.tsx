/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useMemo } from 'react';
import { ArrowRight, Bot, Cpu, Palette, Shield, Sliders, Sparkles, Terminal } from 'lucide-react';
import { useAccessor, useMCPServiceState, useSettingsState } from '../util/services.js';
import { SettingsSection, SettingGroup } from './SettingsControls.js';
import { KodiaBadge, KodiaCard, KodiaStatTile } from '../util/KodiaDesignSystem.js';
import {
	detectActiveKodiaAccent,
	KODIA_ACCENT_PRESETS,
	KODIA_RECOMMENDED_PRESETS,
	KodiaRecommendedPreset,
} from '../../../../common/kodiaAppearance.js';

export type SettingsNavigateTarget =
	| 'home'
	| 'appearance'
	| 'editor'
	| 'models'
	| 'features'
	| 'agent'
	| 'design'
	| 'instructions'
	| 'operations'
	| 'general';

export const SettingsHomeSection = ({
	onNavigate,
	recentChanges,
	onRecordChange,
}: {
	onNavigate: (id: SettingsNavigateTarget) => void;
	recentChanges: readonly { label: string; timestamp: number }[];
	onRecordChange: (label: string) => void;
}) => {
	const accessor = useAccessor();
	const voidSettingsService = accessor.get('IVoidSettingsService');
	const configService = accessor.get('IConfigurationService');
	const commandService = accessor.get('ICommandService');
	const notificationService = accessor.get('INotificationService');

	const settings = useSettingsState();
	const mcpState = useMCPServiceState();

	const chatModel = settings.modelSelectionOfFeature.Chat;
	const autonomyMode = settings.globalSettings.agentAutonomyMode ?? 'agent';
	const fallbackCount = settings.globalSettings.fallbackModels?.length ?? 0;
	const disabledToolCount = settings.globalSettings.disabledTools?.length ?? 0;
	const mcpServerCount = Object.keys(mcpState.mcpServerOfName ?? {}).length;

	const activeTheme = String(configService.getValue('workbench.colorTheme') ?? 'Default');
	const colorCustomizations = configService.getValue<Record<string, unknown>>('workbench.colorCustomizations');
	const activeAccentId = detectActiveKodiaAccent(colorCustomizations);
	const activeAccentLabel = KODIA_ACCENT_PRESETS.find(a => a.id === activeAccentId)?.label ?? 'Theme Default';

	const applyPreset = (preset: KodiaRecommendedPreset) => {
		voidSettingsService.setGlobalSetting('agentAutonomyMode', preset.autonomyMode);
		voidSettingsService.setGlobalSetting('autoAcceptLLMChanges', preset.autoAcceptLLMChanges);
		onRecordChange(`Applied preset: ${preset.title}`);
		notificationService.info(`Kodia preset applied: ${preset.title}`);
	};

	const quickLinks = useMemo(() => ([
		{ id: 'appearance' as const, title: 'Themes & Accent', desc: 'Kodia Obsidian, Midnight, Daylight & accent colors', icon: <Palette size={15} /> },
		{ id: 'editor' as const, title: 'Editor & Typography', desc: 'Fonts, line height, minimap, sticky scroll, cursor & diff', icon: <Sliders size={15} /> },
		{ id: 'models' as const, title: 'Models & Fallbacks', desc: 'BYOK API keys, local servers, auto-failover & role routing', icon: <Sparkles size={15} /> },
		{ id: 'agent' as const, title: 'Agent, Hooks & Policy', desc: 'Autonomy, approvals, lifecycle hooks, tool allow/deny & MCP', icon: <Bot size={15} /> },
		{ id: 'design' as const, title: 'Design Intelligence & Brand', desc: 'Autonomous UI/UX, imagery providers, visual QA & brand systems', icon: <Palette size={15} /> },
		{ id: 'operations' as const, title: 'Ops, Security & Diagnostics', desc: 'Toolchains, Docker, SQLite safety, spans & About Kodia', icon: <Cpu size={15} /> },
	]), []);

	return (
		<SettingsSection
			title='Kodia Settings Home'
			description='Configure your AI engineering workstation, editor appearance, model routing, autonomy policy, and local developer operations.'
			badge={<KodiaBadge tone='accent'>Live Synchronized</KodiaBadge>}
		>
			<SettingGroup title='Current configuration' description='Live overview of your active Kodia environment. Click any card to configure.'>
				<div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3'>
					<KodiaStatTile
						label='Primary Chat Model'
						value={chatModel ? (chatModel.modelName.split('/').pop() ?? chatModel.modelName) : 'Not configured'}
						detail={chatModel ? `${chatModel.providerName} · ${fallbackCount} fallback(s)` : 'Add a provider key or Ollama'}
						icon={<Sparkles size={14} />}
						onClick={() => onNavigate('models')}
					/>
					<KodiaStatTile
						label='Autonomy Mode'
						value={autonomyMode === 'autonomous' ? 'Autonomous' : autonomyMode === 'agent' ? 'Agent' : 'Assist'}
						detail={`${disabledToolCount} disabled tool(s) · ${mcpServerCount} MCP`}
						icon={<Shield size={14} />}
						onClick={() => onNavigate('agent')}
					/>
					<KodiaStatTile
						label='Visual Theme'
						value={activeTheme}
						detail={`Accent: ${activeAccentLabel}`}
						icon={<Palette size={14} />}
						onClick={() => onNavigate('appearance')}
					/>
					<KodiaStatTile
						label='Keyboard Shortcuts'
						value='Ctrl+L / Ctrl+K'
						detail='Click to customize all keybindings'
						icon={<Terminal size={14} />}
						onClick={() => void commandService.executeCommand('workbench.action.openGlobalKeybindings')}
					/>
				</div>
			</SettingGroup>

			<SettingGroup title='Recommended profiles' description='Apply a curated engineering profile in one click. All settings remain individually customizable.'>
				<div className='grid grid-cols-1 md:grid-cols-3 gap-3'>
					{KODIA_RECOMMENDED_PRESETS.map(preset => {
						const isActive =
							autonomyMode === preset.autonomyMode &&
							!!settings.globalSettings.autoAcceptLLMChanges === preset.autoAcceptLLMChanges;
						return (
							<KodiaCard
								key={preset.id}
								onClick={() => applyPreset(preset)}
								className={`flex flex-col justify-between gap-2.5 ${isActive ? '!border-[var(--kodia-accent)] bg-void-bg-3' : ''}`}
							>
								<div>
									<div className='flex items-center justify-between gap-2 mb-1'>
										<span className='text-sm font-semibold text-void-fg-1'>{preset.title}</span>
										{isActive && <KodiaBadge tone='accent'>Active</KodiaBadge>}
									</div>
									<p className='text-xs text-void-fg-3 leading-relaxed'>{preset.subtitle}</p>
								</div>
								<div className='flex flex-wrap gap-1'>
									{preset.badges.map(b => (
										<KodiaBadge key={b} tone='neutral'>{b}</KodiaBadge>
									))}
								</div>
							</KodiaCard>
						);
					})}
				</div>
			</SettingGroup>

			<SettingGroup title='Quick navigation' description='Jump directly to frequently configured Kodia subsystems.'>
				<div className='grid grid-cols-1 sm:grid-cols-2 gap-2.5'>
					{quickLinks.map(link => (
						<KodiaCard
							key={link.id}
							onClick={() => onNavigate(link.id)}
							className='!p-3 flex items-center justify-between gap-3'
						>
							<div className='flex items-start gap-2.5 min-w-0'>
								<div className='p-1.5 rounded-md bg-void-bg-1 text-void-fg-2 border border-void-border-2 shrink-0 mt-0.5'>
									{link.icon}
								</div>
								<div className='min-w-0'>
									<div className='text-xs font-semibold text-void-fg-1'>{link.title}</div>
									<div className='text-[11px] text-void-fg-3 truncate'>{link.desc}</div>
								</div>
							</div>
							<ArrowRight size={14} className='text-void-fg-3 shrink-0' />
						</KodiaCard>
					))}
				</div>
			</SettingGroup>

			{recentChanges.length > 0 && (
				<SettingGroup title='Recently changed settings' description='Changes applied in this Settings session.'>
					<div className='flex flex-col gap-1.5'>
						{recentChanges.slice(0, 6).map((item, idx) => (
							<div key={`${item.timestamp}-${idx}`} className='flex items-center justify-between text-xs px-2.5 py-1.5 rounded bg-void-bg-1 border border-void-border-2'>
								<span className='text-void-fg-1'>{item.label}</span>
								<span className='text-[10px] text-void-fg-3'>{new Date(item.timestamp).toLocaleTimeString()}</span>
							</div>
						))}
					</div>
				</SettingGroup>
			)}
		</SettingsSection>
	);
};
