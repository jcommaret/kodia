/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useState } from 'react';
import { Check, RotateCcw } from 'lucide-react';
import { useAccessor } from '../util/services.js';
import { SettingsSection, SettingGroup, SettingSwitch } from './SettingsControls.js';
import { KodiaBadge, KodiaSecondaryButton } from '../util/KodiaDesignSystem.js';
import {
	applyKodiaAccentToColorCustomizations,
	detectActiveKodiaAccent,
	KODIA_ACCENT_PRESETS,
	KODIA_SIGNATURE_THEMES,
} from '../../../../common/kodiaAppearance.js';

function useWorkbenchConfigValue<T>(key: string, fallback: T): [T, (next: T) => void, () => void] {
	const configService = useAccessor().get('IConfigurationService');
	const read = useCallback((): T => {
		const val = configService.getValue<T>(key);
		return val === undefined ? fallback : val;
	}, [configService, key, fallback]);

	const [value, setValue] = useState<T>(read);

	useEffect(() => {
		setValue(read());
		const d = configService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(key)) {
				setValue(read());
			}
		});
		return () => d.dispose();
	}, [configService, key, read]);

	const update = useCallback((next: T) => {
		setValue(next);
		void configService.updateValue(key, next);
	}, [configService, key]);

	const reset = useCallback(() => {
		void configService.updateValue(key, undefined);
	}, [configService, key]);

	return [value, update, reset];
}

export const AppearanceSection = ({ onRecordChange }: { onRecordChange?: (label: string) => void }) => {
	const accessor = useAccessor();
	const configService = accessor.get('IConfigurationService');
	const workbenchThemeService = accessor.get('IWorkbenchThemeService');
	const commandService = accessor.get('ICommandService');

	const [activeTheme, setActiveTheme] = useWorkbenchConfigValue<string>('workbench.colorTheme', 'Kodia Obsidian');
	const [colorCustomizations, setColorCustomizations] = useWorkbenchConfigValue<Record<string, unknown>>('workbench.colorCustomizations', {});
	const [reduceMotion, setReduceMotion] = useWorkbenchConfigValue<string>('workbench.reduceMotion', 'auto');
	const [zoomLevel, setZoomLevel, resetZoom] = useWorkbenchConfigValue<number>('window.zoomLevel', 0);

	const [installedThemes, setInstalledThemes] = useState<{ id: string; label: string }[]>([]);
	useEffect(() => {
		let cancelled = false;
		void workbenchThemeService.getColorThemes().then(themes => {
			if (!cancelled) {
				setInstalledThemes(themes.map(t => ({ id: t.settingsId || t.id, label: t.label })));
			}
		});
		return () => { cancelled = true; };
	}, [workbenchThemeService]);

	const activeAccentId = detectActiveKodiaAccent(colorCustomizations);

	const selectTheme = (themeId: string) => {
		setActiveTheme(themeId);
		onRecordChange?.(`Theme → ${themeId}`);
	};

	const selectAccent = (accentId: string | null) => {
		const updated = applyKodiaAccentToColorCustomizations(
			configService.getValue<Record<string, unknown>>('workbench.colorCustomizations'),
			accentId,
		);
		setColorCustomizations(updated);
		onRecordChange?.(accentId ? `Accent color → ${accentId}` : 'Accent color reset to theme default');
	};

	return (
		<SettingsSection
			title='Appearance & Themes'
			description='Personalize Kodia’s signature studio themes, workbench accent colors, zoom scale, and motion preferences. All changes apply immediately across the entire IDE.'
		>
			<SettingGroup title='Kodia signature themes' description='Precision-engineered dark and light studio themes crafted for long coding sessions.'>
				<div className='grid grid-cols-1 md:grid-cols-3 gap-3'>
					{KODIA_SIGNATURE_THEMES.map(theme => {
						const active = activeTheme.toLowerCase() === theme.id.toLowerCase();
						return (
							<button
								key={theme.id}
								type='button'
								onClick={() => selectTheme(theme.id)}
								style={active ? { borderColor: 'var(--kodia-accent)' } : undefined}
								className={`text-left rounded-lg border p-3 transition-all cursor-pointer flex flex-col gap-2.5 ${active
									? 'bg-void-bg-3 shadow-sm'
									: 'border-void-border-2 bg-void-bg-2/60 hover:border-void-border-1'
									}`}
							>
								{/* Mini visual IDE preview */}
								<div
									className='h-16 rounded-md overflow-hidden border flex'
									style={{ backgroundColor: theme.preview.bg, borderColor: theme.preview.border }}
								>
									<div className='w-1/4 h-full border-r p-1.5 flex flex-col gap-1' style={{ backgroundColor: theme.preview.sidebar, borderColor: theme.preview.border }}>
										<div className='h-1.5 w-3/4 rounded-full opacity-50' style={{ backgroundColor: theme.preview.text }} />
										<div className='h-1.5 w-1/2 rounded-full' style={{ backgroundColor: theme.preview.accent }} />
										<div className='h-1.5 w-2/3 rounded-full opacity-35' style={{ backgroundColor: theme.preview.text }} />
									</div>
									<div className='flex-1 p-2 flex flex-col justify-between'>
										<div className='flex gap-1'>
											<div className='h-1.5 w-10 rounded-full' style={{ backgroundColor: theme.preview.accent }} />
											<div className='h-1.5 w-8 rounded-full opacity-30' style={{ backgroundColor: theme.preview.text }} />
										</div>
										<div className='flex flex-col gap-1'>
											<div className='h-1.5 w-4/5 rounded-full opacity-60' style={{ backgroundColor: theme.preview.text }} />
											<div className='h-1.5 w-3/5 rounded-full opacity-40' style={{ backgroundColor: theme.preview.text }} />
										</div>
									</div>
								</div>
								<div>
									<div className='flex items-center justify-between gap-2'>
										<span className='text-xs font-semibold text-void-fg-1'>{theme.label}</span>
										{active && <KodiaBadge tone='accent'><Check size={10} /> Active</KodiaBadge>}
									</div>
									<div className='text-[11px] text-void-fg-3 mt-0.5'>{theme.tagline}</div>
								</div>
							</button>
						);
					})}
				</div>

				<div className='flex flex-wrap items-center gap-2 pt-2 border-t border-void-border-3'>
					<label className='text-xs text-void-fg-2'>All installed color themes:</label>
					<select
						value={activeTheme}
						onChange={e => selectTheme(e.target.value)}
						className='px-2.5 py-1 text-xs rounded-md bg-void-bg-1 border border-void-border-2 text-void-fg-1 max-w-xs'
					>
						{installedThemes.length === 0 && <option value={activeTheme}>{activeTheme}</option>}
						{installedThemes.map(t => (
							<option key={`${t.id}-${t.label}`} value={t.id}>{t.label}</option>
						))}
					</select>
					<KodiaSecondaryButton onClick={() => void commandService.executeCommand('workbench.action.selectIconTheme')}>
						File Icon Theme…
					</KodiaSecondaryButton>
				</div>
			</SettingGroup>

			<SettingGroup title='Accent color' description='Updates focus rings, primary buttons, active tabs, and Kodia Command Center highlights across the workbench.'>
				<div className='flex flex-wrap items-center gap-2'>
					{KODIA_ACCENT_PRESETS.map(accent => {
						const active = activeAccentId === accent.id;
						return (
							<button
								key={accent.id}
								type='button'
								onClick={() => selectAccent(accent.id)}
								className={`flex items-center gap-2 px-3 py-1.5 rounded-md border text-xs transition-all cursor-pointer ${active
									? 'border-void-fg-1 bg-void-bg-1 text-void-fg-1 font-medium'
									: 'border-void-border-2 bg-void-bg-2/70 text-void-fg-2 hover:border-void-border-1'
									}`}
							>
								<span className='w-3.5 h-3.5 rounded-full border border-white/20 shrink-0' style={{ backgroundColor: accent.primary }} />
								<span>{accent.label}</span>
								{active && <Check size={12} />}
							</button>
						);
					})}
					<KodiaSecondaryButton onClick={() => selectAccent(null)} disabled={!activeAccentId}>
						<RotateCcw size={12} />
						<span>Theme Default</span>
					</KodiaSecondaryButton>
				</div>
			</SettingGroup>

			<SettingGroup title='Interface scale & accessibility' description='Control window zoom and reduced-motion animations.'>
				<div className='flex flex-wrap items-center justify-between gap-3'>
					<div>
						<div className='text-sm text-void-fg-1'>Window Zoom Level</div>
						<div className='text-xs text-void-fg-3'>Current scale step: {zoomLevel} (0 is 100%)</div>
					</div>
					<div className='flex items-center gap-1.5'>
						<KodiaSecondaryButton onClick={() => { setZoomLevel(Math.max(-3, zoomLevel - 1)); onRecordChange?.('Zoom decreased'); }}>−</KodiaSecondaryButton>
						<KodiaSecondaryButton onClick={() => { resetZoom(); onRecordChange?.('Zoom reset'); }}>Reset (0)</KodiaSecondaryButton>
						<KodiaSecondaryButton onClick={() => { setZoomLevel(Math.min(4, zoomLevel + 1)); onRecordChange?.('Zoom increased'); }}>+</KodiaSecondaryButton>
					</div>
				</div>

				<SettingSwitch
					value={reduceMotion === 'on'}
					onChange={on => { setReduceMotion(on ? 'on' : 'auto'); onRecordChange?.(`Reduce motion → ${on ? 'on' : 'auto'}`); }}
					label='Reduce animations and transitions'
					description='Minimizes motion across both the VS Code workbench and Kodia Command Center panels.'
				/>
			</SettingGroup>
		</SettingsSection>
	);
};

export const EditorWorkbenchSection = ({ onRecordChange }: { onRecordChange?: (label: string) => void }) => {
	const commandService = useAccessor().get('ICommandService');

	const [fontFamily, setFontFamily, resetFontFamily] = useWorkbenchConfigValue<string>('editor.fontFamily', 'Consolas, \'Courier New\', monospace');
	const [fontSize, setFontSize, resetFontSize] = useWorkbenchConfigValue<number>('editor.fontSize', 14);
	const [fontWeight, setFontWeight] = useWorkbenchConfigValue<string>('editor.fontWeight', 'normal');
	const [lineHeight, setLineHeight] = useWorkbenchConfigValue<number>('editor.lineHeight', 0);
	const [letterSpacing, setLetterSpacing] = useWorkbenchConfigValue<number>('editor.letterSpacing', 0);
	const [fontLigatures, setFontLigatures] = useWorkbenchConfigValue<boolean>('editor.fontLigatures', false);

	const [tabSize, setTabSize] = useWorkbenchConfigValue<number>('editor.tabSize', 4);
	const [insertSpaces, setInsertSpaces] = useWorkbenchConfigValue<boolean>('editor.insertSpaces', true);
	const [wordWrap, setWordWrap] = useWorkbenchConfigValue<string>('editor.wordWrap', 'off');
	const [renderWhitespace, setRenderWhitespace] = useWorkbenchConfigValue<string>('editor.renderWhitespace', 'selection');

	const [lineNumbers, setLineNumbers] = useWorkbenchConfigValue<string>('editor.lineNumbers', 'on');
	const [minimap, setMinimap] = useWorkbenchConfigValue<boolean>('editor.minimap.enabled', true);
	const [stickyScroll, setStickyScroll] = useWorkbenchConfigValue<boolean>('editor.stickyScroll.enabled', true);
	const [folding, setFolding] = useWorkbenchConfigValue<boolean>('editor.folding', true);
	const [breadcrumbs, setBreadcrumbs] = useWorkbenchConfigValue<boolean>('breadcrumbs.enabled', true);
	const [bracketColors, setBracketColors] = useWorkbenchConfigValue<boolean>('editor.bracketPairColorization.enabled', true);
	const [indentGuides, setIndentGuides] = useWorkbenchConfigValue<boolean>('editor.guides.indentation', true);

	const [cursorStyle, setCursorStyle] = useWorkbenchConfigValue<string>('editor.cursorStyle', 'line');
	const [cursorBlinking, setCursorBlinking] = useWorkbenchConfigValue<string>('editor.cursorBlinking', 'blink');
	const [smoothCaret, setSmoothCaret] = useWorkbenchConfigValue<string>('editor.cursorSmoothCaretAnimation', 'off');
	const [diffSideBySide, setDiffSideBySide] = useWorkbenchConfigValue<boolean>('diffEditor.renderSideBySide', true);

	return (
		<SettingsSection
			title='Editor & Workbench'
			description='Direct live controls over Kodia’s underlying Monaco code editor. Every setting writes straight to VS Code configuration with zero duplication.'
		>
			<SettingGroup title='Typography & font rendering' description='Tune code legibility for long engineering sessions.'>
				<div className='grid grid-cols-1 md:grid-cols-2 gap-3'>
					<label className='flex flex-col gap-1 text-xs'>
						<span className='text-void-fg-2 font-medium'>Font Family</span>
						<div className='flex gap-1.5'>
							<input
								type='text'
								value={fontFamily}
								onChange={e => { setFontFamily(e.target.value); onRecordChange?.('Updated editor.fontFamily'); }}
								className='flex-1 px-2.5 py-1.5 rounded-md bg-void-bg-1 border border-void-border-2 text-xs text-void-fg-1 font-mono'
							/>
							<KodiaSecondaryButton onClick={resetFontFamily} title='Reset font family'>
								<RotateCcw size={12} />
							</KodiaSecondaryButton>
						</div>
					</label>

					<label className='flex flex-col gap-1 text-xs'>
						<span className='text-void-fg-2 font-medium'>Font Size ({fontSize}px)</span>
						<div className='flex items-center gap-2'>
							<input
								type='range'
								min={10}
								max={26}
								step={1}
								value={fontSize}
								onChange={e => { setFontSize(Number(e.target.value)); onRecordChange?.(`editor.fontSize → ${e.target.value}px`); }}
								className='flex-1'
							/>
							<KodiaSecondaryButton onClick={resetFontSize} title='Reset font size'>
								<RotateCcw size={12} />
							</KodiaSecondaryButton>
						</div>
					</label>

					<label className='flex flex-col gap-1 text-xs'>
						<span className='text-void-fg-2 font-medium'>Font Weight</span>
						<select
							value={String(fontWeight)}
							onChange={e => { setFontWeight(e.target.value); onRecordChange?.(`editor.fontWeight → ${e.target.value}`); }}
							className='px-2.5 py-1.5 rounded-md bg-void-bg-1 border border-void-border-2 text-xs text-void-fg-1'
						>
							<option value='normal'>Normal (400)</option>
							<option value='500'>Medium (500)</option>
							<option value='600'>Semi-Bold (600)</option>
							<option value='bold'>Bold (700)</option>
						</select>
					</label>

					<div className='grid grid-cols-2 gap-2'>
						<label className='flex flex-col gap-1 text-xs'>
							<span className='text-void-fg-2 font-medium'>Line Height (0 = auto)</span>
							<input
								type='number'
								min={0}
								max={48}
								step={1}
								value={lineHeight}
								onChange={e => { setLineHeight(Number(e.target.value)); onRecordChange?.(`editor.lineHeight → ${e.target.value}`); }}
								className='px-2.5 py-1.5 rounded-md bg-void-bg-1 border border-void-border-2 text-xs text-void-fg-1'
							/>
						</label>
						<label className='flex flex-col gap-1 text-xs'>
							<span className='text-void-fg-2 font-medium'>Letter Spacing (px)</span>
							<input
								type='number'
								min={-2}
								max={4}
								step={0.5}
								value={letterSpacing}
								onChange={e => { setLetterSpacing(Number(e.target.value)); onRecordChange?.(`editor.letterSpacing → ${e.target.value}`); }}
								className='px-2.5 py-1.5 rounded-md bg-void-bg-1 border border-void-border-2 text-xs text-void-fg-1'
							/>
						</label>
					</div>
				</div>

				<SettingSwitch
					value={!!fontLigatures}
					onChange={v => { setFontLigatures(v); onRecordChange?.(`Font ligatures → ${v}`); }}
					label='Enable font ligatures (Fira Code, JetBrains Mono, Cascadia Code)'
				/>
			</SettingGroup>

			<SettingGroup title='Indentation, wrapping & whitespace' description='Formatting defaults for editing and code generation.'>
				<div className='grid grid-cols-1 sm:grid-cols-3 gap-3'>
					<label className='flex flex-col gap-1 text-xs'>
						<span className='text-void-fg-2 font-medium'>Tab Size</span>
						<select
							value={tabSize}
							onChange={e => { setTabSize(Number(e.target.value)); onRecordChange?.(`editor.tabSize → ${e.target.value}`); }}
							className='px-2.5 py-1.5 rounded-md bg-void-bg-1 border border-void-border-2 text-xs text-void-fg-1'
						>
							<option value={2}>2 spaces</option>
							<option value={4}>4 spaces</option>
							<option value={8}>8 spaces</option>
						</select>
					</label>

					<label className='flex flex-col gap-1 text-xs'>
						<span className='text-void-fg-2 font-medium'>Word Wrap</span>
						<select
							value={wordWrap}
							onChange={e => { setWordWrap(e.target.value); onRecordChange?.(`editor.wordWrap → ${e.target.value}`); }}
							className='px-2.5 py-1.5 rounded-md bg-void-bg-1 border border-void-border-2 text-xs text-void-fg-1'
						>
							<option value='off'>Off</option>
							<option value='on'>On (Viewport)</option>
							<option value='wordWrapColumn'>At Wrap Column</option>
							<option value='bounded'>Bounded</option>
						</select>
					</label>

					<label className='flex flex-col gap-1 text-xs'>
						<span className='text-void-fg-2 font-medium'>Render Whitespace</span>
						<select
							value={renderWhitespace}
							onChange={e => { setRenderWhitespace(e.target.value); onRecordChange?.(`editor.renderWhitespace → ${e.target.value}`); }}
							className='px-2.5 py-1.5 rounded-md bg-void-bg-1 border border-void-border-2 text-xs text-void-fg-1'
						>
							<option value='none'>None</option>
							<option value='selection'>Selection</option>
							<option value='boundary'>Boundary</option>
							<option value='trailing'>Trailing</option>
							<option value='all'>All</option>
						</select>
					</label>
				</div>

				<SettingSwitch
					value={insertSpaces}
					onChange={v => { setInsertSpaces(v); onRecordChange?.(`editor.insertSpaces → ${v}`); }}
					label='Insert spaces when pressing Tab'
				/>
			</SettingGroup>

			<SettingGroup title='Navigation, minimap & visual aids' description='Keep large files structured and easy to navigate.'>
				<div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
					<label className='flex flex-col gap-1 text-xs'>
						<span className='text-void-fg-2 font-medium'>Line Numbers</span>
						<select
							value={lineNumbers}
							onChange={e => { setLineNumbers(e.target.value); onRecordChange?.(`editor.lineNumbers → ${e.target.value}`); }}
							className='px-2.5 py-1.5 rounded-md bg-void-bg-1 border border-void-border-2 text-xs text-void-fg-1'
						>
							<option value='on'>Standard</option>
							<option value='relative'>Relative</option>
							<option value='interval'>Every 10th Line</option>
							<option value='off'>Hidden</option>
						</select>
					</label>
				</div>

				<div className='grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1'>
					<SettingSwitch value={minimap} onChange={v => { setMinimap(v); onRecordChange?.(`Minimap → ${v}`); }} label='Show Minimap' />
					<SettingSwitch value={stickyScroll} onChange={v => { setStickyScroll(v); onRecordChange?.(`Sticky Scroll → ${v}`); }} label='Enable Sticky Scroll' />
					<SettingSwitch value={breadcrumbs} onChange={v => { setBreadcrumbs(v); onRecordChange?.(`Breadcrumbs → ${v}`); }} label='Show Breadcrumbs' />
					<SettingSwitch value={folding} onChange={v => { setFolding(v); onRecordChange?.(`Code Folding → ${v}`); }} label='Enable Code Folding' />
					<SettingSwitch value={bracketColors} onChange={v => { setBracketColors(v); onRecordChange?.(`Bracket Colors → ${v}`); }} label='Bracket Pair Colorization' />
					<SettingSwitch value={indentGuides} onChange={v => { setIndentGuides(v); onRecordChange?.(`Indent Guides → ${v}`); }} label='Show Indentation Guides' />
				</div>
			</SettingGroup>

			<SettingGroup title='Cursor & diff visualization' description='Customize caret motion and how Kodia renders code diffs.'>
				<div className='grid grid-cols-1 sm:grid-cols-3 gap-3'>
					<label className='flex flex-col gap-1 text-xs'>
						<span className='text-void-fg-2 font-medium'>Cursor Style</span>
						<select
							value={cursorStyle}
							onChange={e => { setCursorStyle(e.target.value); onRecordChange?.(`editor.cursorStyle → ${e.target.value}`); }}
							className='px-2.5 py-1.5 rounded-md bg-void-bg-1 border border-void-border-2 text-xs text-void-fg-1'
						>
							<option value='line'>Line</option>
							<option value='block'>Block</option>
							<option value='underline'>Underline</option>
							<option value='line-thin'>Thin Line</option>
						</select>
					</label>

					<label className='flex flex-col gap-1 text-xs'>
						<span className='text-void-fg-2 font-medium'>Cursor Blinking</span>
						<select
							value={cursorBlinking}
							onChange={e => { setCursorBlinking(e.target.value); onRecordChange?.(`editor.cursorBlinking → ${e.target.value}`); }}
							className='px-2.5 py-1.5 rounded-md bg-void-bg-1 border border-void-border-2 text-xs text-void-fg-1'
						>
							<option value='blink'>Blink</option>
							<option value='smooth'>Smooth</option>
							<option value='phase'>Phase</option>
							<option value='expand'>Expand</option>
							<option value='solid'>Solid</option>
						</select>
					</label>

					<label className='flex flex-col gap-1 text-xs'>
						<span className='text-void-fg-2 font-medium'>Smooth Caret Animation</span>
						<select
							value={smoothCaret}
							onChange={e => { setSmoothCaret(e.target.value); onRecordChange?.(`Smooth caret → ${e.target.value}`); }}
							className='px-2.5 py-1.5 rounded-md bg-void-bg-1 border border-void-border-2 text-xs text-void-fg-1'
						>
							<option value='off'>Off</option>
							<option value='explicit'>On Explicit Move</option>
							<option value='on'>Always On</option>
						</select>
					</label>
				</div>

				<SettingSwitch
					value={diffSideBySide}
					onChange={v => { setDiffSideBySide(v); onRecordChange?.(`Diff side-by-side → ${v}`); }}
					label='Render Diff Editor side-by-side (disable for unified inline diff)'
				/>

				<div className='pt-2 flex flex-wrap gap-2'>
					<KodiaSecondaryButton onClick={() => void commandService.executeCommand('workbench.action.openSettings')}>
						Open Full VS Code Settings JSON/UI…
					</KodiaSecondaryButton>
					<KodiaSecondaryButton onClick={() => void commandService.executeCommand('workbench.action.openGlobalKeybindings')}>
						Open Keyboard Shortcuts…
					</KodiaSecondaryButton>
				</div>
			</SettingGroup>
		</SettingsSection>
	);
};
