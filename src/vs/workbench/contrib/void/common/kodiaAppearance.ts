/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export interface KodiaThemePreset {
	readonly id: string;
	readonly label: string;
	readonly tagline: string;
	readonly kind: 'dark' | 'light';
	readonly preview: {
		readonly bg: string;
		readonly sidebar: string;
		readonly accent: string;
		readonly text: string;
		readonly border: string;
	};
}

export const KODIA_SIGNATURE_THEMES: readonly KodiaThemePreset[] = [
	{
		id: 'Kodia Obsidian',
		label: 'Kodia Obsidian',
		tagline: 'Precision carbon-slate dark studio with crisp hierarchy',
		kind: 'dark',
		preview: { bg: '#151821', sidebar: '#11141B', accent: '#5E8BFF', text: '#DCE2EE', border: '#252C3D' },
	},
	{
		id: 'Kodia Midnight',
		label: 'Kodia Midnight',
		tagline: 'Deep navy-slate canvas tuned for long evening sessions',
		kind: 'dark',
		preview: { bg: '#0E1626', sidebar: '#0B1220', accent: '#38BDF8', text: '#DCE8F7', border: '#1B2E4A' },
	},
	{
		id: 'Kodia Daylight',
		label: 'Kodia Daylight',
		tagline: 'Architectural alabaster light workspace with high contrast',
		kind: 'light',
		preview: { bg: '#FFFFFF', sidebar: '#F5F7FB', accent: '#2563EB', text: '#1E293B', border: '#DFE4EE' },
	},
];

export interface KodiaAccentPreset {
	readonly id: string;
	readonly label: string;
	readonly primary: string;
	readonly hover: string;
	readonly soft: string;
}

export const KODIA_ACCENT_PRESETS: readonly KodiaAccentPreset[] = [
	{ id: 'cobalt', label: 'Cobalt', primary: '#3B6FF5', hover: '#4D7DF7', soft: '#3B6FF538' },
	{ id: 'sky', label: 'Sky Cyan', primary: '#0EA5E9', hover: '#38BDF8', soft: '#0EA5E938' },
	{ id: 'indigo', label: 'Indigo', primary: '#6366F1', hover: '#818CF8', soft: '#6366F138' },
	{ id: 'emerald', label: 'Emerald', primary: '#10B981', hover: '#34D399', soft: '#10B98138' },
	{ id: 'violet', label: 'Violet', primary: '#8B5CF6', hover: '#A78BFA', soft: '#8B5CF638' },
	{ id: 'amber', label: 'Amber', primary: '#D97706', hover: '#F59E0B', soft: '#D9770638' },
	{ id: 'rose', label: 'Rose', primary: '#E11D48', hover: '#F43F5E', soft: '#E11D4838' },
];

export const KODIA_ACCENT_COLOR_KEYS: readonly string[] = [
	'focusBorder',
	'button.background',
	'button.hoverBackground',
	'activityBar.activeBorder',
	'activityBarBadge.background',
	'panelTitle.activeBorder',
	'progressBar.background',
	'tab.activeBorderTop',
	'statusBarItem.remoteBackground',
	'inputOption.activeBorder',
	'inputOption.activeBackground',
];

/**
 * Merges a chosen Kodia accent preset into existing VS Code `workbench.colorCustomizations`
 * without clobbering user-defined overrides for other color keys.
 */
export function applyKodiaAccentToColorCustomizations(
	existing: Record<string, unknown> | undefined,
	accentId: string | null,
): Record<string, unknown> {
	const next: Record<string, unknown> = { ...(existing ?? {}) };
	for (const key of KODIA_ACCENT_COLOR_KEYS) {
		delete next[key];
	}
	if (!accentId) {
		return next;
	}
	const preset = KODIA_ACCENT_PRESETS.find(a => a.id === accentId);
	if (!preset) {
		return next;
	}
	next.focusBorder = preset.primary;
	next['button.background'] = preset.primary;
	next['button.hoverBackground'] = preset.hover;
	next['activityBar.activeBorder'] = preset.primary;
	next['activityBarBadge.background'] = preset.primary;
	next['panelTitle.activeBorder'] = preset.primary;
	next['progressBar.background'] = preset.primary;
	next['tab.activeBorderTop'] = preset.primary;
	next['statusBarItem.remoteBackground'] = preset.primary;
	next['inputOption.activeBorder'] = preset.primary;
	next['inputOption.activeBackground'] = preset.soft;
	return next;
}

export function detectActiveKodiaAccent(customizations: Record<string, unknown> | undefined): string | null {
	if (!customizations) { return null; }
	const active = typeof customizations['button.background'] === 'string'
		? customizations['button.background'].toLowerCase()
		: '';
	if (!active) { return null; }
	const match = KODIA_ACCENT_PRESETS.find(p => p.primary.toLowerCase() === active);
	return match?.id ?? null;
}

export type KodiaAutonomyPresetId = 'balanced' | 'autonomous' | 'strict';

export interface KodiaRecommendedPreset {
	readonly id: KodiaAutonomyPresetId;
	readonly title: string;
	readonly subtitle: string;
	readonly autonomyMode: 'assist' | 'agent' | 'autonomous';
	readonly autoAcceptLLMChanges: boolean;
	readonly badges: readonly string[];
}

export const KODIA_RECOMMENDED_PRESETS: readonly KodiaRecommendedPreset[] = [
	{
		id: 'balanced',
		title: 'Balanced Engineer',
		subtitle: 'Auto-runs reads, edits, tests, and local builds; asks before high-risk terminal or destructive actions.',
		autonomyMode: 'agent',
		autoAcceptLLMChanges: true,
		badges: ['Agent Mode', 'Auto-Accept Edits', 'Safe Guards'],
	},
	{
		id: 'autonomous',
		title: 'Full Autopilot',
		subtitle: 'Maximum execution speed across multi-file builds, subagents, browser checks, and recovery loops.',
		autonomyMode: 'autonomous',
		autoAcceptLLMChanges: true,
		badges: ['Autonomous Mode', 'Fast Loops', 'Checkpoints On'],
	},
	{
		id: 'strict',
		title: 'Strict Security Review',
		subtitle: 'Pauses before edits and external operations so you inspect every diff and command manually.',
		autonomyMode: 'assist',
		autoAcceptLLMChanges: false,
		badges: ['Assist Mode', 'Manual Diff Accept', 'High Oversight'],
	},
];
