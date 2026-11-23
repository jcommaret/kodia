/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useEffect, useState } from 'react';
import { CheckCircle2, Eye, Image as ImageIcon, Layers, Palette, RefreshCw, ShieldCheck, Sparkles, Wand2 } from 'lucide-react';
import { useAccessor } from '../util/services.js';
import { KodiaBadge, KodiaCard, KodiaEmptyState, KodiaPrimaryButton, KodiaSecondaryButton } from '../util/KodiaDesignSystem.js';
import { ProjectDesignState } from '../../../designIntelligenceService.js';
import { VOID_OPEN_SETTINGS_ACTION_ID } from '../../../voidSettingsPane.js';

type StudioTab = 'system' | 'assets' | 'qa';

const Swatch = ({ label, color }: { label: string; color: string }) => (
	<div className='flex items-center gap-2 p-1.5 rounded bg-void-bg-1 border border-void-border-2'>
		<span className='w-5 h-5 rounded border border-white/15 shrink-0' style={{ backgroundColor: color }} />
		<div className='min-w-0'>
			<div className='text-[10px] font-medium text-void-fg-1 truncate'>{label}</div>
			<div className='text-[9px] font-mono text-void-fg-3 truncate'>{color}</div>
		</div>
	</div>
);

export const DesignStudioPanel = ({ onSendPrompt }: { onSendPrompt?: (prompt: string) => void }) => {
	const accessor = useAccessor();
	const designService = accessor.get('IDesignIntelligenceService');
	const commandService = accessor.get('ICommandService');

	const [tab, setTab] = useState<StudioTab>('system');
	const [designState, setDesignState] = useState<ProjectDesignState>(designService.state);

	useEffect(() => {
		setDesignState(designService.state);
		const d = designService.onDidChange(() => setDesignState({ ...designService.state }));
		return () => d.dispose();
	}, [designService]);

	const {
		brandProfile,
		latestBrief,
		latestDirection,
		latestPalette,
		latestTokens,
		latestExistingSystem,
		latestConsistencyAudit,
		latestCritique,
		latestMultiViewport,
		downloadedAssets,
		discoveredAssets,
		screenshotRevisions,
	} = designState;

	const triggerDesignAudit = () => {
		onSendPrompt?.('Run inspect_existing_design_system, audit_design_consistency, and critique_interface_design on this workspace, then summarize the concrete visual and responsive improvements needed.');
	};

	const triggerGenerateSystem = () => {
		onSendPrompt?.('Inspect this project with inspect_existing_design_system and generate a cohesive, WCAG-accessible design system using generate_design_brief, generate_design_tokens, and recommend_typography.');
	};

	return (
		<div className='w-full h-full flex flex-col overflow-hidden bg-void-bg-2 text-void-fg-1'>
			{/* Header */}
			<div className='px-3 py-2.5 border-b border-void-border-2 bg-void-bg-1/70 flex items-center justify-between gap-2 shrink-0'>
				<div className='min-w-0'>
					<div className='flex items-center gap-1.5'>
						<Palette size={14} style={{ color: 'var(--kodia-accent)' }} />
						<h2 className='text-xs font-semibold tracking-tight truncate'>Design Intelligence Studio</h2>
					</div>
					<p className='text-[10px] text-void-fg-3 truncate mt-0.5'>
						{brandProfile ? `Brand: ${brandProfile.brandName}` : latestBrief ? `Brief: ${latestBrief.productName}` : 'Autonomous Creative Direction & Visual QA'}
					</p>
				</div>
				<KodiaSecondaryButton
					onClick={() => void commandService.executeCommand(VOID_OPEN_SETTINGS_ACTION_ID)}
					className='!px-2 !py-1 !text-[10px]'
				>
					<span>Brand & Settings</span>
				</KodiaSecondaryButton>
			</div>

			{/* Sub-tabs */}
			<div className='px-2.5 py-1.5 border-b border-void-border-2 flex items-center gap-1 shrink-0'>
				{[
					{ id: 'system' as const, label: 'Design System', icon: <Layers size={11} /> },
					{ id: 'assets' as const, label: `Assets (${downloadedAssets.length + discoveredAssets.length})`, icon: <ImageIcon size={11} /> },
					{ id: 'qa' as const, label: `Visual QA${latestCritique ? ` (${latestCritique.grade})` : ''}`, icon: <Eye size={11} /> },
				].map(t => (
					<button
						key={t.id}
						type='button'
						onClick={() => setTab(t.id)}
						className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] cursor-pointer transition-colors ${tab === t.id ? 'bg-void-bg-3 text-void-fg-1 font-medium border border-void-border-2' : 'text-void-fg-3 hover:text-void-fg-1'}`}
					>
						{t.icon}
						<span>{t.label}</span>
					</button>
				))}
			</div>

			{/* Body */}
			<div className='flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-3'>
				{/* Quick Actions */}
				<div className='flex flex-wrap gap-1.5'>
					<KodiaPrimaryButton onClick={triggerDesignAudit} className='!text-[11px] !py-1 !px-2.5'>
						<ShieldCheck size={12} />
						<span>Audit Design & A11y</span>
					</KodiaPrimaryButton>
					<KodiaSecondaryButton onClick={triggerGenerateSystem} className='!text-[11px] !py-1 !px-2.5'>
						<Wand2 size={12} />
						<span>Generate Tokens</span>
					</KodiaSecondaryButton>
				</div>

				{tab === 'system' && (
					<>
						{brandProfile && (
							<KodiaCard className='!p-3 flex flex-col gap-2'>
								<div className='flex items-center justify-between gap-2'>
									<span className='text-xs font-semibold text-void-fg-1'>{brandProfile.brandName}</span>
									<KodiaBadge tone='accent'>Active Brand System</KodiaBadge>
								</div>
								{brandProfile.tagline && <p className='text-[11px] text-void-fg-3'>{brandProfile.tagline}</p>}
								<div className='grid grid-cols-3 gap-1.5'>
									{brandProfile.primaryColor && <Swatch label='Primary' color={brandProfile.primaryColor} />}
									{brandProfile.secondaryColor && <Swatch label='Secondary' color={brandProfile.secondaryColor} />}
									{brandProfile.accentColor && <Swatch label='Accent' color={brandProfile.accentColor} />}
								</div>
								{(brandProfile.headingFont || brandProfile.bodyFont) && (
									<div className='text-[10px] text-void-fg-3'>
										Fonts: <span className='text-void-fg-1'>{brandProfile.headingFont || 'Auto'}</span> / <span className='text-void-fg-1'>{brandProfile.bodyFont || 'Auto'}</span>
									</div>
								)}
							</KodiaCard>
						)}

						{latestExistingSystem && (
							<KodiaCard className='!p-3 flex flex-col gap-1.5'>
								<div className='flex items-center justify-between'>
									<span className='text-xs font-semibold'>Detected Workspace Stack</span>
									<KodiaBadge>{latestExistingSystem.framework} · {latestExistingSystem.stylingSystem}</KodiaBadge>
								</div>
								<p className='text-[11px] text-void-fg-3 leading-relaxed'>{latestExistingSystem.summary}</p>
							</KodiaCard>
						)}

						{latestBrief && (
							<KodiaCard className='!p-3 flex flex-col gap-1.5'>
								<div className='flex items-center justify-between gap-2'>
									<span className='text-xs font-semibold'>Creative Brief: {latestBrief.productName}</span>
									<KodiaBadge tone='accent'>{latestBrief.visualDirectionId}</KodiaBadge>
								</div>
								<p className='text-[11px] text-void-fg-2 leading-relaxed'>{latestBrief.executiveSummary}</p>
								<p className='text-[10px] text-void-fg-3 leading-relaxed'>{latestBrief.creativeDirection}</p>
							</KodiaCard>
						)}

						{latestDirection && !latestBrief && (
							<KodiaCard className='!p-3 flex flex-col gap-1'>
								<span className='text-xs font-semibold'>Visual Direction: {latestDirection.name}</span>
								<p className='text-[11px] text-void-fg-3'>{latestDirection.rationale}</p>
							</KodiaCard>
						)}

						{latestPalette && (
							<KodiaCard className='!p-3 flex flex-col gap-2'>
								<div className='flex items-center justify-between gap-2'>
									<span className='text-xs font-semibold'>Color System ({latestPalette.harmony})</span>
									<KodiaBadge tone={latestPalette.allContrastChecksPassAA ? 'success' : 'warning'}>
										{latestPalette.allContrastChecksPassAA ? 'WCAG AA Verified' : 'Check Contrast'}
									</KodiaBadge>
								</div>
								<div className='text-[10px] font-medium text-void-fg-3 uppercase tracking-wider'>Light Tokens</div>
								<div className='grid grid-cols-2 gap-1.5'>
									<Swatch label='Background' color={latestPalette.light.background} />
									<Swatch label='Surface' color={latestPalette.light.surface} />
									<Swatch label='Primary' color={latestPalette.light.primary} />
									<Swatch label='Accent' color={latestPalette.light.accent} />
									<Swatch label='Text' color={latestPalette.light.text} />
									<Swatch label='Border' color={latestPalette.light.border} />
								</div>
								<div className='text-[10px] font-medium text-void-fg-3 uppercase tracking-wider pt-1'>Dark Tokens</div>
								<div className='grid grid-cols-2 gap-1.5'>
									<Swatch label='Background' color={latestPalette.dark.background} />
									<Swatch label='Surface' color={latestPalette.dark.surface} />
									<Swatch label='Primary' color={latestPalette.dark.primary} />
									<Swatch label='Accent' color={latestPalette.dark.accent} />
								</div>
							</KodiaCard>
						)}

						{latestTokens && (
							<KodiaCard className='!p-3 flex flex-col gap-1.5'>
								<span className='text-xs font-semibold'>Typography Pairing: {latestTokens.typography.pairingName}</span>
								<p className='text-[11px] text-void-fg-3'>{latestTokens.typography.rationale}</p>
								<div className='text-[10px] font-mono text-void-fg-3 break-all'>{latestTokens.typography.fontStacks.display}</div>
							</KodiaCard>
						)}

						{!brandProfile && !latestBrief && !latestPalette && !latestExistingSystem && (
							<KodiaEmptyState
								icon={<Sparkles size={18} />}
								title='No Design System Captured Yet'
								description='Ask Kodia to build any website, store, dashboard, or app — or click "Generate Tokens" above — and your live brand tokens, typography, assets, and visual QA scores will appear here automatically.'
							/>
						)}
					</>
				)}

				{tab === 'assets' && (
					<>
						{downloadedAssets.length > 0 && (
							<div className='flex flex-col gap-2'>
								<div className='text-[10px] font-semibold uppercase tracking-wider text-void-fg-3'>
									Verified Local Assets ({downloadedAssets.length})
								</div>
								{downloadedAssets.map(a => (
									<KodiaCard key={a.relativePath || a.localPath} className='!p-2.5 flex items-start justify-between gap-2'>
										<div className='min-w-0'>
											<div className='text-xs font-medium text-void-fg-1 truncate'>{a.relativePath}</div>
											<div className='text-[10px] text-void-fg-3 mt-0.5'>
												{a.provider} · {(a.sizeBytes / 1024).toFixed(1)} KB{a.width ? ` · ${a.width}×${a.height}` : ''} · {a.license}
											</div>
											<div className='text-[10px] text-void-fg-3 italic truncate mt-0.5'>alt: “{a.altText}”</div>
										</div>
										<CheckCircle2 size={14} className='text-emerald-400 shrink-0 mt-0.5' />
									</KodiaCard>
								))}
							</div>
						)}

						{discoveredAssets.length > 0 && (
							<div className='flex flex-col gap-2'>
								<div className='text-[10px] font-semibold uppercase tracking-wider text-void-fg-3'>
									Discovered Candidates ({discoveredAssets.length})
								</div>
								{discoveredAssets.slice(0, 12).map(a => (
									<KodiaCard key={a.id} className='!p-2.5 flex flex-col gap-1'>
										<div className='flex items-center justify-between gap-2'>
											<span className='text-xs font-medium text-void-fg-1 truncate'>{a.title}</span>
											<KodiaBadge>{a.provider}</KodiaBadge>
										</div>
										<div className='text-[10px] text-void-fg-3'>
											{a.width && a.height ? `${a.width}×${a.height} · ` : ''}{a.license}
										</div>
									</KodiaCard>
								))}
							</div>
						)}

						{downloadedAssets.length === 0 && discoveredAssets.length === 0 && (
							<KodiaEmptyState
								icon={<ImageIcon size={18} />}
								title='No Visual Assets Cataloged'
								description='When Kodia discovers or downloads photography and bespoke SVGs via discover_visual_assets / download_visual_assets, verified assets and license metadata appear here.'
							/>
						)}
					</>
				)}

				{tab === 'qa' && (
					<>
						{latestCritique && (
							<KodiaCard className='!p-3 flex flex-col gap-2.5'>
								<div className='flex items-center justify-between gap-2'>
									<div>
										<div className='text-xs font-semibold text-void-fg-1'>Interface Design Critique</div>
										<div className='text-[10px] text-void-fg-3 mt-0.5'>{latestCritique.verdict}</div>
									</div>
									<div className='text-right shrink-0'>
										<div className='text-lg font-bold text-void-fg-1'>{latestCritique.grade}</div>
										<div className='text-[10px] text-void-fg-3'>{latestCritique.overallScore}/100</div>
									</div>
								</div>
								<div className='flex flex-col gap-1.5'>
									{latestCritique.dimensions.map(d => (
										<div key={d.name} className='flex flex-col gap-0.5'>
											<div className='flex items-center justify-between text-[10px]'>
												<span className='text-void-fg-2'>{d.name}</span>
												<span className='font-mono text-void-fg-1'>{d.score}</span>
											</div>
											<div className='h-1.5 rounded-full bg-void-bg-1 overflow-hidden'>
												<div
													className='h-full rounded-full transition-all'
													style={{
														width: `${d.score}%`,
														backgroundColor: d.score >= 85 ? '#10B981' : d.score >= 70 ? '#F59E0B' : '#EF4444',
													}}
												/>
											</div>
										</div>
									))}
								</div>
							</KodiaCard>
						)}

						{latestConsistencyAudit && !latestCritique && (
							<KodiaCard className='!p-3 flex flex-col gap-1'>
								<div className='flex items-center justify-between'>
									<span className='text-xs font-semibold'>Static Consistency Audit</span>
									<KodiaBadge>{latestConsistencyAudit.score}/100</KodiaBadge>
								</div>
								<p className='text-[11px] text-void-fg-3'>{latestConsistencyAudit.summary}</p>
							</KodiaCard>
						)}

						{latestMultiViewport && (
							<KodiaCard className='!p-3 flex flex-col gap-2'>
								<div className='flex items-center justify-between'>
									<span className='text-xs font-semibold'>Multi-Viewport Verification</span>
									<KodiaBadge tone={latestMultiViewport.allViewportsClean ? 'success' : 'warning'}>
										{latestMultiViewport.allViewportsClean ? 'All Viewports Clean' : 'Issues Found'}
									</KodiaBadge>
								</div>
								<div className='flex flex-col gap-2'>
									{latestMultiViewport.captures.map(c => (
										<div key={c.label} className='p-2 rounded bg-void-bg-1 border border-void-border-2 flex flex-col gap-1.5'>
											<div className='flex items-center justify-between text-[11px]'>
												<span className='font-medium'>{c.label} ({c.width}×{c.height})</span>
												<span className={c.hasHorizontalOverflow || c.brokenImageCount > 0 ? 'text-amber-400' : 'text-emerald-400'}>
													{c.hasHorizontalOverflow ? 'Overflow' : `${c.layoutIssueCount} layout · ${c.brokenImageCount} img`}
												</span>
											</div>
											{c.dataUrl && (
												<img src={c.dataUrl} alt={`${c.label} preview screenshot`} className='w-full rounded border border-void-border-2 max-h-36 object-cover object-top' />
											)}
										</div>
									))}
								</div>
							</KodiaCard>
						)}

						{!latestCritique && !latestConsistencyAudit && !latestMultiViewport && screenshotRevisions.length === 0 && (
							<KodiaEmptyState
								icon={<RefreshCw size={18} />}
								title='No Visual QA Runs Yet'
								description='Click "Audit Design & A11y" or let Kodia render your app in Chromium to inspect live responsive layouts, WCAG contrast, and visual revisions.'
							/>
						)}
					</>
				)}
			</div>
		</div>
	);
};
