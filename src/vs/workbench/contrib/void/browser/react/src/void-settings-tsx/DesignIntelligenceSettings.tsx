/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useEffect, useState } from 'react';
import { Check, Image as ImageIcon, Palette, Save, ShieldCheck, Sparkles, Trash2 } from 'lucide-react';
import { useAccessor, useSettingsState } from '../util/services.js';
import { SettingGroup, SettingsSection, SettingSwitch } from './SettingsControls.js';
import { KodiaBadge, KodiaCard, KodiaPrimaryButton, KodiaSecondaryButton } from '../util/KodiaDesignSystem.js';
import {
	AccessibilityTarget,
	AnimationPreference,
	AssetLicensePreference,
	DEFAULT_DESIGN_INTELLIGENCE_SETTINGS,
	DesignIntelligenceSettings,
	ImageDownloadPreference,
	ImageProviderName,
	VisualDirectionId,
} from '../../../../common/designIntelligenceTypes.js';
import { VISUAL_DIRECTIONS } from '../../../../common/designKnowledgeLibrary.js';
import { DESIGN_SYSTEM_WORKSPACE_FILE } from '../../../designIntelligenceService.js';

const ALL_IMAGE_PROVIDERS: readonly { id: ImageProviderName; label: string; desc: string; needsKey?: 'unsplash' | 'pexels' | 'pixabay' }[] = [
	{ id: 'local', label: 'Local Workspace Assets', desc: 'Automatically scans project public/, assets/, and images/ folders.' },
	{ id: 'openverse', label: 'Openverse (CC Licensed)', desc: 'Free Creative Commons photography & illustrations with attribution metadata.' },
	{ id: 'wikimedia', label: 'Wikimedia Commons', desc: 'Public domain & CC editorial/architectural/historical photography.' },
	{ id: 'unsplash', label: 'Unsplash', desc: 'Curated editorial & lifestyle photography (API key optional).', needsKey: 'unsplash' },
	{ id: 'pexels', label: 'Pexels', desc: 'Commercial-friendly stock photography (API key optional).', needsKey: 'pexels' },
	{ id: 'pixabay', label: 'Pixabay', desc: 'Royalty-free photos & illustrations (API key optional).', needsKey: 'pixabay' },
];

const DIRECTION_OPTIONS = Object.values(VISUAL_DIRECTIONS);

export const DesignIntelligenceSection = ({ onRecordChange }: { onRecordChange?: (label: string) => void }) => {
	const accessor = useAccessor();
	const voidSettingsService = accessor.get('IVoidSettingsService');
	const designService = accessor.get('IDesignIntelligenceService');
	const notificationService = accessor.get('INotificationService');

	const settingsState = useSettingsState();
	const current: DesignIntelligenceSettings = {
		...DEFAULT_DESIGN_INTELLIGENCE_SETTINGS,
		...(settingsState.globalSettings.designIntelligence ?? {}),
	};

	const updateDesignSetting = <K extends keyof DesignIntelligenceSettings>(key: K, value: DesignIntelligenceSettings[K], label: string) => {
		voidSettingsService.setGlobalSetting('designIntelligence', {
			...current,
			[key]: value,
		});
		onRecordChange?.(`Design: ${label}`);
	};

	const toggleProvider = (provider: ImageProviderName) => {
		const exists = current.approvedImageProviders.includes(provider);
		const next = exists
			? current.approvedImageProviders.filter(p => p !== provider)
			: [...current.approvedImageProviders, provider];
		updateDesignSetting('approvedImageProviders', next, `Provider ${provider} ${exists ? 'disabled' : 'enabled'}`);
	};

	const updateProviderKey = (provider: 'unsplash' | 'pexels' | 'pixabay', key: string) => {
		voidSettingsService.setGlobalSetting('designIntelligence', {
			...current,
			imageProviderApiKeys: {
				...(current.imageProviderApiKeys ?? {}),
				[provider]: key.trim() || undefined,
			},
		});
	};

	// Project Brand System editor state (.kodia/design-system.json)
	const existingBrand = designService.getBrandProfile();
	const [brandName, setBrandName] = useState(existingBrand?.brandName ?? '');
	const [tagline, setTagline] = useState(existingBrand?.tagline ?? '');
	const [industry, setIndustry] = useState(existingBrand?.industry ?? '');
	const [preferredDirection, setPreferredDirection] = useState<string>(existingBrand?.preferredDirection ?? '');
	const [primaryColor, setPrimaryColor] = useState(existingBrand?.primaryColor ?? '#1D4ED8');
	const [secondaryColor, setSecondaryColor] = useState(existingBrand?.secondaryColor ?? '#0F172A');
	const [accentColor, setAccentColor] = useState(existingBrand?.accentColor ?? '#0EA5E9');
	const [headingFont, setHeadingFont] = useState(existingBrand?.headingFont ?? '');
	const [bodyFont, setBodyFont] = useState(existingBrand?.bodyFont ?? '');
	const [logoPath, setLogoPath] = useState(existingBrand?.logoPath ?? '');
	const [themeMode, setThemeMode] = useState<'light' | 'dark' | 'both'>(existingBrand?.themeMode ?? 'both');
	const [imageStyleNotes, setImageStyleNotes] = useState(existingBrand?.imageStyleNotes ?? '');
	const [restrictionsText, setRestrictionsText] = useState((existingBrand?.restrictions ?? []).join('\n'));
	const [savedFeedback, setSavedFeedback] = useState(false);

	useEffect(() => {
		const d = designService.onDidChange(() => {
			const bp = designService.getBrandProfile();
			if (bp) {
				setBrandName(bp.brandName);
				setTagline(bp.tagline ?? '');
				setIndustry(bp.industry ?? '');
				setPreferredDirection(bp.preferredDirection ?? '');
				if (bp.primaryColor) { setPrimaryColor(bp.primaryColor); }
				if (bp.secondaryColor) { setSecondaryColor(bp.secondaryColor); }
				if (bp.accentColor) { setAccentColor(bp.accentColor); }
				setHeadingFont(bp.headingFont ?? '');
				setBodyFont(bp.bodyFont ?? '');
				setLogoPath(bp.logoPath ?? '');
				setThemeMode(bp.themeMode ?? 'both');
				setImageStyleNotes(bp.imageStyleNotes ?? '');
				setRestrictionsText((bp.restrictions ?? []).join('\n'));
			}
		});
		return () => d.dispose();
	}, [designService]);

	const handleSaveBrand = async () => {
		await designService.saveBrandProfile({
			brandName: brandName.trim() || 'Project Brand',
			tagline: tagline.trim() || undefined,
			industry: industry.trim() || undefined,
			preferredDirection: (preferredDirection || undefined) as VisualDirectionId | undefined,
			primaryColor: primaryColor.trim() || undefined,
			secondaryColor: secondaryColor.trim() || undefined,
			accentColor: accentColor.trim() || undefined,
			headingFont: headingFont.trim() || undefined,
			bodyFont: bodyFont.trim() || undefined,
			logoPath: logoPath.trim() || undefined,
			themeMode,
			accessibilityTarget: current.accessibilityTarget,
			imageStyleNotes: imageStyleNotes.trim() || undefined,
			restrictions: restrictionsText.split(/\r?\n/).map(s => s.trim()).filter(Boolean),
		});
		setSavedFeedback(true);
		setTimeout(() => setSavedFeedback(false), 2200);
		onRecordChange?.(`Saved brand system (${brandName.trim() || 'Project Brand'})`);
		notificationService.info(`Saved project Brand System to ${DESIGN_SYSTEM_WORKSPACE_FILE}`);
	};

	const handleClearBrand = async () => {
		await designService.clearBrandProfile();
		setBrandName('');
		setTagline('');
		setIndustry('');
		setPreferredDirection('');
		setHeadingFont('');
		setBodyFont('');
		setLogoPath('');
		setImageStyleNotes('');
		setRestrictionsText('');
		onRecordChange?.('Cleared project brand system');
	};

	return (
		<SettingsSection
			title='Autonomous Design Intelligence & Brand Systems'
			description='Configure Kodia’s default UI/UX creative direction, visual asset discovery providers, browser visual QA checks, accessibility targets, and project-level brand guidelines across all BYOK models.'
			badge={<KodiaBadge tone='accent'><Sparkles size={11} /> 25 Design Tools Active</KodiaBadge>}
		>
			<SettingGroup title='Autonomous design defaults' description='Controls Kodia’s automatic product analysis, design system generation, and style direction across all connected LLMs.'>
				<SettingSwitch
					value={current.autoDesignIntelligence}
					onChange={v => updateDesignSetting('autoDesignIntelligence', v, `Auto design intelligence ${v ? 'on' : 'off'}`)}
					label='Automatic UI/UX design intelligence'
					description='Automatically analyzes product goals, selects visual direction, generates accessible color/typography tokens, and enforces design quality by default.'
				/>
				<SettingSwitch
					value={current.autoAssetDiscovery}
					onChange={v => updateDesignSetting('autoAssetDiscovery', v, `Auto asset discovery ${v ? 'on' : 'off'}`)}
					label='Automatic visual asset discovery'
					description='Proactively searches approved providers and local folders for suitable photography and artwork instead of relying on placeholders.'
				/>
				<div className='grid grid-cols-1 md:grid-cols-2 gap-3 pt-1'>
					<label className='flex flex-col gap-1'>
						<span className='text-xs font-medium text-void-fg-1'>Preferred visual style direction</span>
						<select
							value={current.preferredStyleDirection}
							onChange={e => updateDesignSetting('preferredStyleDirection', e.target.value as VisualDirectionId | 'auto', `Style: ${e.target.value}`)}
							className='px-2.5 py-1.5 text-xs rounded-md bg-void-bg-1 border border-void-border-2 text-void-fg-1'
						>
							<option value='auto'>Auto-select by product category (Recommended)</option>
							{DIRECTION_OPTIONS.map(d => (
								<option key={d.id} value={d.id}>{d.name}</option>
							))}
						</select>
					</label>
					<label className='flex flex-col gap-1'>
						<span className='text-xs font-medium text-void-fg-1'>Motion & animation preference</span>
						<select
							value={current.animationPreference}
							onChange={e => updateDesignSetting('animationPreference', e.target.value as AnimationPreference, `Animation: ${e.target.value}`)}
							className='px-2.5 py-1.5 text-xs rounded-md bg-void-bg-1 border border-void-border-2 text-void-fg-1'
						>
							<option value='refined'>Refined micro-interactions (Recommended)</option>
							<option value='minimal'>Minimal state feedback only</option>
							<option value='expressive'>Expressive storytelling reveals</option>
							<option value='reduced-motion'>Strict reduced motion (accessibility-first)</option>
						</select>
					</label>
				</div>
			</SettingGroup>

			<SettingGroup title='Visual asset discovery & licensing' description='Configure how Kodia discovers, downloads, licenses, and stores photography and artwork.'>
				<div className='grid grid-cols-1 md:grid-cols-2 gap-3'>
					<label className='flex flex-col gap-1'>
						<span className='text-xs font-medium text-void-fg-1'>Image acquisition strategy</span>
						<select
							value={current.imageDownloadPreference}
							onChange={e => updateDesignSetting('imageDownloadPreference', e.target.value as ImageDownloadPreference, `Image mode: ${e.target.value}`)}
							className='px-2.5 py-1.5 text-xs rounded-md bg-void-bg-1 border border-void-border-2 text-void-fg-1'
						>
							<option value='download-local'>Download verified assets locally into workspace (Recommended)</option>
							<option value='remote-verified'>Use verified remote URLs where permitted</option>
							<option value='svg-only'>Generate original local SVG artwork only (offline-safe)</option>
						</select>
					</label>
					<label className='flex flex-col gap-1'>
						<span className='text-xs font-medium text-void-fg-1'>Asset licensing preference</span>
						<select
							value={current.assetLicensePreference}
							onChange={e => updateDesignSetting('assetLicensePreference', e.target.value as AssetLicensePreference, `License: ${e.target.value}`)}
							className='px-2.5 py-1.5 text-xs rounded-md bg-void-bg-1 border border-void-border-2 text-void-fg-1'
						>
							<option value='permissive-commercial'>Permissive commercial (CC0 / Public Domain / Stock License)</option>
							<option value='attribution-ok'>Commercial with attribution manifest (Recommended)</option>
							<option value='any-verified'>Any verified legitimate source</option>
						</select>
					</label>
				</div>

				<div className='grid grid-cols-1 md:grid-cols-2 gap-2.5 pt-2'>
					{ALL_IMAGE_PROVIDERS.map(p => {
						const enabled = current.approvedImageProviders.includes(p.id);
						return (
							<KodiaCard key={p.id} className='!p-3 flex flex-col gap-2'>
								<div className='flex items-start justify-between gap-2'>
									<div className='flex items-center gap-1.5'>
										<ImageIcon size={13} className='text-void-fg-3 shrink-0' />
										<span className='text-xs font-semibold text-void-fg-1'>{p.label}</span>
									</div>
									<button
										type='button'
										onClick={() => toggleProvider(p.id)}
										className={`text-[10px] px-2 py-0.5 rounded border cursor-pointer ${enabled ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400' : 'bg-void-bg-1 border-void-border-2 text-void-fg-3'}`}
									>
										{enabled ? 'Approved' : 'Disabled'}
									</button>
								</div>
								<p className='text-[11px] text-void-fg-3 leading-relaxed'>{p.desc}</p>
								{p.needsKey && (
									<input
										type='password'
										value={current.imageProviderApiKeys?.[p.needsKey] ?? ''}
										onChange={e => updateProviderKey(p.needsKey!, e.target.value)}
										placeholder={`Optional ${p.label} API Key…`}
										className='w-full px-2 py-1 text-[11px] rounded bg-void-bg-1 border border-void-border-2 text-void-fg-1 placeholder:text-void-fg-3'
									/>
								)}
							</KodiaCard>
						);
					})}
				</div>
			</SettingGroup>

			<SettingGroup title='Visual quality QA, responsive & accessibility checks' description='Automated real-browser verification standards executed via Playwright Chromium.'>
				<SettingSwitch
					value={current.enableVisualQualityChecks}
					onChange={v => updateDesignSetting('enableVisualQualityChecks', v, `Visual QA ${v ? 'on' : 'off'}`)}
					label='Automated visual quality inspection'
					description='Verifies loaded images, aspect ratios, typography scale, spacing consistency, and zero console/network errors.'
				/>
				<SettingSwitch
					value={current.enableResponsiveTesting}
					onChange={v => updateDesignSetting('enableResponsiveTesting', v, `Responsive testing ${v ? 'on' : 'off'}`)}
					label='Multi-viewport responsive testing (375px / 768px / 1440px)'
					description='Renders pages across mobile, tablet, and desktop viewports to detect horizontal overflow and tiny touch targets.'
				/>
				<SettingSwitch
					value={current.enableVisualRegression}
					onChange={v => updateDesignSetting('enableVisualRegression', v, `Visual regression ${v ? 'on' : 'off'}`)}
					label='Visual revision comparison (pixel diffing)'
					description='Enables pixel-by-pixel PNG screenshot comparison before and after visual defect repairs.'
				/>
				<SettingSwitch
					value={current.enableAccessibilityChecks}
					onChange={v => updateDesignSetting('enableAccessibilityChecks', v, `Accessibility checks ${v ? 'on' : 'off'}`)}
					label='WCAG 2.1 accessibility & contrast auditing'
					description='Measures live rendered text contrast, alt text, form labels, landmarks, heading hierarchy, and focus indicators.'
				/>
				<label className='flex flex-col gap-1 max-w-xs pt-1'>
					<span className='text-xs font-medium text-void-fg-1 flex items-center gap-1.5'>
						<ShieldCheck size={13} /> Contrast & accessibility standard
					</span>
					<select
						value={current.accessibilityTarget}
						onChange={e => updateDesignSetting('accessibilityTarget', e.target.value as AccessibilityTarget, `WCAG target: ${e.target.value}`)}
						className='px-2.5 py-1.5 text-xs rounded-md bg-void-bg-1 border border-void-border-2 text-void-fg-1'
					>
						<option value='WCAG_AA'>WCAG 2.1 AA (≥4.5:1 body, ≥3:1 large — Recommended)</option>
						<option value='WCAG_AAA'>WCAG 2.1 AAA (≥7.0:1 body — High Accessibility)</option>
					</select>
				</label>
			</SettingGroup>

			<SettingGroup title='Project brand system & guidelines' description={`Persists reusable brand colors, typography, logo, and design restrictions to ${DESIGN_SYSTEM_WORKSPACE_FILE} so every model honors your brand automatically.`}>
				<div className='grid grid-cols-1 md:grid-cols-2 gap-3'>
					<label className='flex flex-col gap-1'>
						<span className='text-xs font-medium text-void-fg-1'>Brand / Product Name</span>
						<input value={brandName} onChange={e => setBrandName(e.target.value)} placeholder='e.g. Atelier Nord' className='px-2.5 py-1.5 text-xs rounded-md bg-void-bg-1 border border-void-border-2 text-void-fg-1' />
					</label>
					<label className='flex flex-col gap-1'>
						<span className='text-xs font-medium text-void-fg-1'>Industry / Domain</span>
						<input value={industry} onChange={e => setIndustry(e.target.value)} placeholder='e.g. Luxury Fashion, Fintech, SaaS' className='px-2.5 py-1.5 text-xs rounded-md bg-void-bg-1 border border-void-border-2 text-void-fg-1' />
					</label>
					<label className='flex flex-col gap-1'>
						<span className='text-xs font-medium text-void-fg-1'>Tagline</span>
						<input value={tagline} onChange={e => setTagline(e.target.value)} placeholder='Short brand positioning statement' className='px-2.5 py-1.5 text-xs rounded-md bg-void-bg-1 border border-void-border-2 text-void-fg-1' />
					</label>
					<label className='flex flex-col gap-1'>
						<span className='text-xs font-medium text-void-fg-1'>Brand Visual Direction</span>
						<select value={preferredDirection} onChange={e => setPreferredDirection(e.target.value)} className='px-2.5 py-1.5 text-xs rounded-md bg-void-bg-1 border border-void-border-2 text-void-fg-1'>
							<option value=''>Auto-match product category</option>
							{DIRECTION_OPTIONS.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
						</select>
					</label>
				</div>

				<div className='grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1'>
					{[
						{ label: 'Primary Color', value: primaryColor, set: setPrimaryColor },
						{ label: 'Secondary Color', value: secondaryColor, set: setSecondaryColor },
						{ label: 'Accent Color', value: accentColor, set: setAccentColor },
					].map(c => (
						<label key={c.label} className='flex flex-col gap-1'>
							<span className='text-xs font-medium text-void-fg-1 flex items-center gap-1.5'>
								<Palette size={12} /> {c.label}
							</span>
							<div className='flex items-center gap-2'>
								<input type='color' value={/^#[0-9a-fA-F]{6}$/.test(c.value) ? c.value : '#1D4ED8'} onChange={e => c.set(e.target.value.toUpperCase())} className='w-8 h-7 rounded border border-void-border-2 bg-transparent cursor-pointer' />
								<input value={c.value} onChange={e => c.set(e.target.value)} className='flex-1 px-2 py-1 text-xs font-mono rounded bg-void-bg-1 border border-void-border-2 text-void-fg-1' />
							</div>
						</label>
					))}
				</div>

				<div className='grid grid-cols-1 md:grid-cols-3 gap-3'>
					<label className='flex flex-col gap-1'>
						<span className='text-xs font-medium text-void-fg-1'>Heading Font</span>
						<input value={headingFont} onChange={e => setHeadingFont(e.target.value)} placeholder='e.g. Cormorant Garamond' className='px-2.5 py-1.5 text-xs rounded-md bg-void-bg-1 border border-void-border-2 text-void-fg-1' />
					</label>
					<label className='flex flex-col gap-1'>
						<span className='text-xs font-medium text-void-fg-1'>Body Font</span>
						<input value={bodyFont} onChange={e => setBodyFont(e.target.value)} placeholder='e.g. Inter' className='px-2.5 py-1.5 text-xs rounded-md bg-void-bg-1 border border-void-border-2 text-void-fg-1' />
					</label>
					<label className='flex flex-col gap-1'>
						<span className='text-xs font-medium text-void-fg-1'>Theme Mode</span>
						<select value={themeMode} onChange={e => setThemeMode(e.target.value as 'light' | 'dark' | 'both')} className='px-2.5 py-1.5 text-xs rounded-md bg-void-bg-1 border border-void-border-2 text-void-fg-1'>
							<option value='both'>Light + Dark</option>
							<option value='light'>Light Primary</option>
							<option value='dark'>Dark Primary</option>
						</select>
					</label>
				</div>

				<div className='grid grid-cols-1 md:grid-cols-2 gap-3'>
					<label className='flex flex-col gap-1'>
						<span className='text-xs font-medium text-void-fg-1'>Logo Path (workspace-relative)</span>
						<input value={logoPath} onChange={e => setLogoPath(e.target.value)} placeholder='e.g. public/logo.svg' className='px-2.5 py-1.5 text-xs rounded-md bg-void-bg-1 border border-void-border-2 text-void-fg-1' />
					</label>
					<label className='flex flex-col gap-1'>
						<span className='text-xs font-medium text-void-fg-1'>Imagery Style Notes</span>
						<input value={imageStyleNotes} onChange={e => setImageStyleNotes(e.target.value)} placeholder='e.g. Natural daylight, warm minimal studio photography' className='px-2.5 py-1.5 text-xs rounded-md bg-void-bg-1 border border-void-border-2 text-void-fg-1' />
					</label>
				</div>

				<label className='flex flex-col gap-1'>
					<span className='text-xs font-medium text-void-fg-1'>Design Restrictions (one per line)</span>
					<textarea rows={2} value={restrictionsText} onChange={e => setRestrictionsText(e.target.value)} placeholder='e.g. Never use neon gradients&#10;Always preserve sharp 2px border radii' className='px-2.5 py-1.5 text-xs rounded-md bg-void-bg-1 border border-void-border-2 text-void-fg-1' />
				</label>

				<div className='flex items-center gap-2 pt-1'>
					<KodiaPrimaryButton onClick={() => void handleSaveBrand()} className='!text-xs'>
						{savedFeedback ? <Check size={13} /> : <Save size={13} />}
						<span>{savedFeedback ? 'Brand System Saved' : 'Save Project Brand System'}</span>
					</KodiaPrimaryButton>
					{existingBrand && (
						<KodiaSecondaryButton onClick={() => void handleClearBrand()} className='!text-xs'>
							<Trash2 size={12} />
							<span>Clear Brand</span>
						</KodiaSecondaryButton>
					)}
				</div>
			</SettingGroup>
		</SettingsSection>
	);
};
