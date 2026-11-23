/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import {
	AccessibilityTarget,
	ColorHarmonyStrategy,
	ContrastCheckResult,
	DesignKnowledgeEntry,
	IconLibraryName,
	ProductCategory,
	ProductDomain,
	RequiredAssetNeed,
	ThemeColorTokens,
	TypographyRecommendation,
	UserJourneySpec,
	VisualDirectionId,
	VisualDirectionSpec,
} from './designIntelligenceTypes.js';

// ============================================================================
// 1. REAL COLOR SCIENCE & WCAG 2.1 CONTRAST MATHEMATICS
// ============================================================================

export interface RGB { readonly r: number; readonly g: number; readonly b: number; }
export interface HSL { readonly h: number; readonly s: number; readonly l: number; }

export function normalizeHex(hex: string, fallback = '#2563EB'): string {
	const cleaned = hex.trim().replace(/^#/, '');
	if (/^[0-9a-fA-F]{3}$/.test(cleaned)) {
		return `#${cleaned[0]}${cleaned[0]}${cleaned[1]}${cleaned[1]}${cleaned[2]}${cleaned[2]}`.toUpperCase();
	}
	if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
		return `#${cleaned}`.toUpperCase();
	}
	return fallback.toUpperCase();
}

export function hexToRgb(hex: string): RGB {
	const norm = normalizeHex(hex);
	const n = parseInt(norm.slice(1), 16);
	return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }: RGB): string {
	const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
	return `#${[clamp(r), clamp(g), clamp(b)].map(v => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

export function hexToHsl(hex: string): HSL {
	const { r: r255, g: g255, b: b255 } = hexToRgb(hex);
	const r = r255 / 255;
	const g = g255 / 255;
	const b = b255 / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	if (max === min) {
		return { h: 0, s: 0, l: Math.round(l * 100) };
	}
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h = 0;
	switch (max) {
		case r: h = (g - b) / d + (g < b ? 6 : 0); break;
		case g: h = (b - r) / d + 2; break;
		case b: h = (r - g) / d + 4; break;
	}
	h /= 6;
	return { h: Math.round(h * 360) % 360, s: Math.round(s * 100), l: Math.round(l * 100) };
}

export function hslToHex({ h, s, l }: HSL): string {
	const hue = ((h % 360) + 360) % 360;
	const sat = Math.max(0, Math.min(100, s)) / 100;
	const lig = Math.max(0, Math.min(100, l)) / 100;
	const c = (1 - Math.abs(2 * lig - 1)) * sat;
	const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
	const m = lig - c / 2;
	let r = 0, g = 0, b = 0;
	if (hue < 60) { r = c; g = x; }
	else if (hue < 120) { r = x; g = c; }
	else if (hue < 180) { g = c; b = x; }
	else if (hue < 240) { g = x; b = c; }
	else if (hue < 300) { r = x; b = c; }
	else { r = c; b = x; }
	return rgbToHex({ r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 });
}

export function getRelativeLuminance(hex: string): number {
	const { r, g, b } = hexToRgb(hex);
	const lin = (c: number) => {
		const srgb = c / 255;
		return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
	};
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function getContrastRatio(fgHex: string, bgHex: string): number {
	const l1 = getRelativeLuminance(fgHex);
	const l2 = getRelativeLuminance(bgHex);
	const lighter = Math.max(l1, l2);
	const darker = Math.min(l1, l2);
	return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}

/**
 * Adjusts foreground lightness while preserving hue/saturation until it meets target WCAG contrast against bgHex.
 */
export function ensureContrast(fgHex: string, bgHex: string, minRatio = 4.5): string {
	const normFg = normalizeHex(fgHex);
	const normBg = normalizeHex(bgHex);
	if (getContrastRatio(normFg, normBg) >= minRatio) {
		return normFg;
	}
	const bgLum = getRelativeLuminance(normBg);
	const hsl = hexToHsl(normFg);
	const goDarker = bgLum > 0.35;
	for (let step = 1; step <= 95; step++) {
		const candidateL = goDarker
			? Math.max(3, hsl.l - step)
			: Math.min(97, hsl.l + step);
		const candidate = hslToHex({ h: hsl.h, s: hsl.s, l: candidateL });
		const ratio = getContrastRatio(candidate, normBg);
		if (ratio >= minRatio) {
			return candidate;
		}
	}
	// Ultimate accessible fallback (black or white) if extreme saturation prevented hitting ratio
	const blackRatio = getContrastRatio('#09090B', normBg);
	const whiteRatio = getContrastRatio('#FAFAFA', normBg);
	return blackRatio >= whiteRatio ? '#09090B' : '#FAFAFA';
}

export function pickReadableForeground(bgHex: string, minRatio = 4.5): string {
	const darkInk = '#0B0F19';
	const lightInk = '#FFFFFF';
	const darkRatio = getContrastRatio(darkInk, bgHex);
	const lightRatio = getContrastRatio(lightInk, bgHex);
	if (lightRatio >= minRatio && lightRatio >= darkRatio) { return lightInk; }
	if (darkRatio >= minRatio) { return darkInk; }
	return lightRatio > darkRatio ? lightInk : darkInk;
}

/**
 * Ensures a button/badge fill color supports at least `minRatio` contrast with either white or near-black ink
 * (avoiding the ~4.3–4.4 mid-luminance dead zone like #6366F1 on white).
 */
export function ensureAccessibleFill(fillHex: string, preferDarker: boolean, minRatio = 4.5): string {
	const norm = normalizeHex(fillHex);
	if (Math.max(getContrastRatio('#FFFFFF', norm), getContrastRatio('#0B0F19', norm)) >= minRatio) {
		return norm;
	}
	const hsl = hexToHsl(norm);
	for (let step = 1; step <= 45; step++) {
		const candidateL = preferDarker ? Math.max(8, hsl.l - step) : Math.min(92, hsl.l + step);
		const candidate = hslToHex({ h: hsl.h, s: hsl.s, l: candidateL });
		if (Math.max(getContrastRatio('#FFFFFF', candidate), getContrastRatio('#0B0F19', candidate)) >= minRatio) {
			return candidate;
		}
	}
	return preferDarker ? '#1E293B' : '#E2E8F0';
}

export function generateHarmonySeeds(
	primaryHex: string,
	harmony: ColorHarmonyStrategy,
): { primary: string; secondary: string; accent: string; neutral: string } {
	const primary = normalizeHex(primaryHex);
	const hsl = hexToHsl(primary);
	let secondaryH = hsl.h;
	let accentH = hsl.h;
	let secondaryS = Math.max(12, Math.round(hsl.s * 0.65));
	let accentS = Math.min(82, Math.max(45, hsl.s));

	switch (harmony) {
		case 'monochromatic':
			secondaryH = hsl.h;
			accentH = hsl.h;
			secondaryS = Math.max(8, Math.round(hsl.s * 0.4));
			break;
		case 'neutral-accent':
			secondaryH = hsl.h;
			secondaryS = Math.min(16, Math.round(hsl.s * 0.25));
			accentH = (hsl.h + 24) % 360;
			break;
		case 'complementary':
			secondaryH = (hsl.h + 180) % 360;
			accentH = (hsl.h + 180) % 360;
			break;
		case 'analogous':
			secondaryH = (hsl.h + 28) % 360;
			accentH = (hsl.h + 332) % 360;
			break;
		case 'split-complementary':
			secondaryH = (hsl.h + 150) % 360;
			accentH = (hsl.h + 210) % 360;
			break;
		case 'triadic':
			secondaryH = (hsl.h + 120) % 360;
			accentH = (hsl.h + 240) % 360;
			break;
		case 'warm-editorial':
			secondaryH = (hsl.h + 22) % 360;
			accentH = 32;
			secondaryS = Math.min(35, Math.max(12, hsl.s * 0.5));
			break;
		case 'cool-technical':
			secondaryH = (hsl.h + 35) % 360;
			accentH = (hsl.h + 190) % 360;
			break;
		case 'dark-premium':
			secondaryH = (hsl.h + 20) % 360;
			accentH = (hsl.h + 42) % 360;
			break;
	}

	const neutralHue = harmony === 'warm-editorial' ? 34 : hsl.s < 10 ? 220 : hsl.h;
	return {
		primary,
		secondary: hslToHex({ h: secondaryH, s: secondaryS, l: Math.max(32, Math.min(54, hsl.l)) }),
		accent: hslToHex({ h: accentH, s: accentS, l: Math.max(42, Math.min(56, hsl.l)) }),
		neutral: hslToHex({ h: neutralHue, s: harmony === 'warm-editorial' ? 8 : 6, l: 46 }),
	};
}

export function buildThemeTokens(
	seeds: { primary: string; secondary: string; accent: string; neutral: string },
	mode: 'light' | 'dark',
	target: AccessibilityTarget = 'WCAG_AA',
	warmSurface = false,
): ThemeColorTokens {
	const minBodyRatio = target === 'WCAG_AAA' ? 7.0 : 4.5;
	const minMutedRatio = 4.5;
	const nHsl = hexToHsl(seeds.neutral);
	const pHsl = hexToHsl(seeds.primary);
	const aHsl = hexToHsl(seeds.accent);
	const surfHue = warmSurface ? 36 : nHsl.h;
	const surfSat = warmSurface ? 14 : Math.min(12, nHsl.s);

	if (mode === 'light') {
		const background = warmSurface ? hslToHex({ h: 38, s: 22, l: 98 }) : '#FFFFFF';
		const backgroundSubtle = hslToHex({ h: surfHue, s: surfSat, l: 96 });
		const surface = warmSurface ? hslToHex({ h: 38, s: 18, l: 99 }) : '#FFFFFF';
		const surfaceElevated = '#FFFFFF';
		const surfaceHover = hslToHex({ h: surfHue, s: surfSat, l: 93 });
		const border = hslToHex({ h: surfHue, s: Math.min(14, surfSat + 4), l: 88 });
		const borderStrong = hslToHex({ h: surfHue, s: Math.min(16, surfSat + 6), l: 76 });
		const text = ensureContrast(hslToHex({ h: surfHue, s: 16, l: 11 }), background, minBodyRatio);
		const textSecondary = ensureContrast(hslToHex({ h: surfHue, s: 12, l: 28 }), background, minBodyRatio);
		const textMuted = ensureContrast(hslToHex({ h: surfHue, s: 10, l: 42 }), background, minMutedRatio);

		const primary = ensureAccessibleFill(ensureContrast(seeds.primary, background, 3.2), true, 4.5);
		const primaryHover = hslToHex({ h: pHsl.h, s: pHsl.s, l: Math.max(12, hexToHsl(primary).l - 7) });
		const primaryForeground = pickReadableForeground(primary, 4.5);

		const secondary = hslToHex({ h: hexToHsl(seeds.secondary).h, s: Math.min(28, hexToHsl(seeds.secondary).s), l: 93 });
		const secondaryForeground = ensureContrast(hslToHex({ h: hexToHsl(seeds.secondary).h, s: 24, l: 18 }), secondary, 4.5);

		const accent = ensureAccessibleFill(ensureContrast(seeds.accent, background, 3.1), true, 4.5);
		const accentForeground = pickReadableForeground(accent, 4.5);

		return {
			background,
			backgroundSubtle,
			surface,
			surfaceElevated,
			surfaceHover,
			border,
			borderStrong,
			text,
			textSecondary,
			textMuted,
			primary,
			primaryHover,
			primaryForeground,
			secondary,
			secondaryForeground,
			accent,
			accentForeground,
			focusRing: primary,
			success: ensureContrast('#15803D', background, 4.5),
			warning: ensureContrast('#B45309', background, 4.5),
			error: ensureContrast('#B91C1C', background, 4.5),
			info: ensureContrast('#0369A1', background, 4.5),
			heroGradient: `linear-gradient(135deg, ${background} 0%, ${backgroundSubtle} 55%, ${hslToHex({ h: pHsl.h, s: Math.min(28, pHsl.s), l: 95 })} 100%)`,
			surfaceGlow: `radial-gradient(600px circle at 50% 0%, ${hslToHex({ h: pHsl.h, s: Math.min(40, pHsl.s), l: 92 })}40, transparent 70%)`,
			shadowSm: '0 1px 2px rgba(15, 23, 42, 0.05)',
			shadowMd: '0 8px 24px -4px rgba(15, 23, 42, 0.08), 0 2px 6px -2px rgba(15, 23, 42, 0.04)',
			shadowLg: '0 20px 44px -12px rgba(15, 23, 42, 0.14), 0 4px 12px -4px rgba(15, 23, 42, 0.06)',
		};
	}

	// Dark mode tokens
	const background = hslToHex({ h: surfHue, s: Math.min(18, surfSat + 4), l: 7 });
	const backgroundSubtle = hslToHex({ h: surfHue, s: Math.min(16, surfSat + 4), l: 10 });
	const surface = hslToHex({ h: surfHue, s: Math.min(16, surfSat + 4), l: 11 });
	const surfaceElevated = hslToHex({ h: surfHue, s: Math.min(16, surfSat + 4), l: 15 });
	const surfaceHover = hslToHex({ h: surfHue, s: Math.min(16, surfSat + 4), l: 19 });
	const border = hslToHex({ h: surfHue, s: Math.min(14, surfSat + 4), l: 22 });
	const borderStrong = hslToHex({ h: surfHue, s: Math.min(14, surfSat + 4), l: 32 });
	const text = ensureContrast(hslToHex({ h: surfHue, s: 10, l: 95 }), background, minBodyRatio);
	const textSecondary = ensureContrast(hslToHex({ h: surfHue, s: 10, l: 78 }), background, minBodyRatio);
	const textMuted = ensureContrast(hslToHex({ h: surfHue, s: 10, l: 64 }), background, minMutedRatio);

	const darkPrimarySeed = hslToHex({ h: pHsl.h, s: Math.min(82, Math.max(45, pHsl.s)), l: Math.max(54, Math.min(68, pHsl.l + 12)) });
	const primary = ensureAccessibleFill(ensureContrast(darkPrimarySeed, background, 4.5), false, 4.5);
	const primaryHover = hslToHex({ h: pHsl.h, s: hexToHsl(primary).s, l: Math.min(82, hexToHsl(primary).l + 7) });
	const primaryForeground = pickReadableForeground(primary, 4.5);

	const secondary = hslToHex({ h: hexToHsl(seeds.secondary).h, s: 18, l: 18 });
	const secondaryForeground = ensureContrast('#F4F4F5', secondary, 4.5);

	const darkAccentSeed = hslToHex({ h: aHsl.h, s: Math.min(85, Math.max(50, aHsl.s)), l: 62 });
	const accent = ensureAccessibleFill(ensureContrast(darkAccentSeed, background, 4.5), false, 4.5);
	const accentForeground = pickReadableForeground(accent, 4.5);

	return {
		background,
		backgroundSubtle,
		surface,
		surfaceElevated,
		surfaceHover,
		border,
		borderStrong,
		text,
		textSecondary,
		textMuted,
		primary,
		primaryHover,
		primaryForeground,
		secondary,
		secondaryForeground,
		accent,
		accentForeground,
		focusRing: primary,
		success: ensureContrast('#34D399', background, 4.5),
		warning: ensureContrast('#FBBF24', background, 4.5),
		error: ensureContrast('#F87171', background, 4.5),
		info: ensureContrast('#38BDF8', background, 4.5),
		heroGradient: `linear-gradient(135deg, ${background} 0%, ${backgroundSubtle} 55%, ${hslToHex({ h: pHsl.h, s: Math.min(34, pHsl.s), l: 14 })} 100%)`,
		surfaceGlow: `radial-gradient(640px circle at 50% -10%, ${primary}26, transparent 70%)`,
		shadowSm: '0 1px 2px rgba(0, 0, 0, 0.35)',
		shadowMd: '0 10px 28px -6px rgba(0, 0, 0, 0.5), 0 2px 8px -2px rgba(0, 0, 0, 0.35)',
		shadowLg: '0 24px 52px -12px rgba(0, 0, 0, 0.65), 0 6px 16px -4px rgba(0, 0, 0, 0.45)',
	};
}

export function evaluatePaletteContrast(light: ThemeColorTokens, dark: ThemeColorTokens): ContrastCheckResult[] {
	const pairs: [string, string, string][] = [
		['Light: text on background', light.text, light.background],
		['Light: textSecondary on surface', light.textSecondary, light.surface],
		['Light: textMuted on surface', light.textMuted, light.surface],
		['Light: primaryForeground on primary', light.primaryForeground, light.primary],
		['Light: accentForeground on accent', light.accentForeground, light.accent],
		['Light: error on surface', light.error, light.surface],
		['Dark: text on background', dark.text, dark.background],
		['Dark: textSecondary on surface', dark.textSecondary, dark.surface],
		['Dark: textMuted on surface', dark.textMuted, dark.surface],
		['Dark: primaryForeground on primary', dark.primaryForeground, dark.primary],
		['Dark: accentForeground on accent', dark.accentForeground, dark.accent],
		['Dark: error on surface', dark.error, dark.surface],
	];
	return pairs.map(([pair, foreground, background]) => {
		const ratio = getContrastRatio(foreground, background);
		return {
			pair,
			foreground,
			background,
			ratio,
			passesAA: ratio >= 4.5,
			passesAALarge: ratio >= 3.0,
			passesAAA: ratio >= 7.0,
		};
	});
}

// ============================================================================
// 2. VISUAL DIRECTION LIBRARY (26 ART DIRECTIONS WITH RESTRAINT GUARDRAILS)
// ============================================================================

export const VISUAL_DIRECTIONS: Readonly<Record<VisualDirectionId, VisualDirectionSpec>> = {
	'premium-minimalism': {
		id: 'premium-minimalism',
		name: 'Premium Minimalism',
		rationale: 'Maximizes clarity, calm authority, and perceived product value through generous negative space and crisp typographic contrast.',
		aestheticKeywords: ['restrained', 'spacious', 'architectural', 'quiet confidence'],
		colorMood: 'Warm or crisp neutral canvas with a single disciplined ink-and-accent hierarchy.',
		typographyCharacter: 'Clean geometric or neo-grotesk sans with tight display tracking and comfortable body measure (60–72ch).',
		layoutPhilosophy: 'Asymmetric 12-column editorial grid with deliberate breathing room and clear section rhythm.',
		surfaceTreatment: 'Flat matte surfaces separated by hairline 1px borders and subtle tonal shifts.',
		elevationStrategy: 'Restrained elevation — reserve shadows strictly for floating overlays and active interactive focus.',
		borderRadiusStyle: 'Crisp medium radii (8–12px) on containers, 6–8px on controls.',
		motionCharacter: 'Subtle, fast opacity and 4–8px translate transitions (180–240ms cubic-bezier).',
		visualTreatmentsToUse: ['Hairline borders', 'Generous whitespace', 'Subtle surface elevation', 'High-resolution photography'],
		visualTreatmentsToAvoid: ['Heavy neon glows', 'Overlapping gradients', 'Bouncy cartoon animations', 'Decorative clutter'],
		appropriateFor: ['SaaS websites', 'Portfolios', 'Consumer tech', 'Productivity apps', 'Design studios'],
		unsuitableFor: ['Arcade games', 'Dense industrial telemetry', 'Loud youth festival posters'],
	},
	'luxury-editorial': {
		id: 'luxury-editorial',
		name: 'Luxury Editorial',
		rationale: 'Elevates fashion, hospitality, architecture, and high-ticket lifestyle brands through magazine-grade pacing, serif sophistication, and full-bleed art direction.',
		aestheticKeywords: ['couture', 'atelier', 'editorial', 'timeless', 'tactile'],
		colorMood: 'Warm alabaster / ivory / stone neutrals paired with deep obsidian ink and muted champagne, bronze, or espresso accents.',
		typographyCharacter: 'High-contrast modern serif headlines paired with understated grotesque sans body and tracked-out micro-labels.',
		layoutPhilosophy: 'Full-bleed visual chapters alternating with asymmetrical lookbook grids and generous vertical cadence.',
		surfaceTreatment: 'Ultra-clean paper/stone grounds, crisp edges or minimal radii, photography as hero rather than UI chrome.',
		elevationStrategy: 'Almost flat; depth comes from scale, photography lighting, and typography hierarchy.',
		borderRadiusStyle: 'Sharp 0–4px corners for editorial authority (or 999px pill strictly for micro-badges).',
		motionCharacter: 'Slow, deliberate reveals (350–500ms ease-out) and smooth hover image zoom (scale 1.03).',
		visualTreatmentsToUse: ['Full-bleed photography', 'Serif/sans contrast', 'Fine 1px rules', 'Lookbook aspect ratios (3:4, 4:5)'],
		visualTreatmentsToAvoid: ['Thick drop shadows', 'Bubble rounded cards', 'Neon gradients', 'Dense badge walls'],
		appropriateFor: ['Fashion stores', 'Luxury hospitality', 'Fine dining', 'Real estate', 'Beauty & cosmetics', 'Architecture'],
		unsuitableFor: ['Developer consoles', 'Dense ERP tables', 'Kids educational games'],
	},
	'modern-enterprise': {
		id: 'modern-enterprise',
		name: 'Modern Enterprise',
		rationale: 'Communicates institutional reliability, scannability, and operational efficiency for B2B platforms and mission-critical software.',
		aestheticKeywords: ['structured', 'dependable', 'scannable', 'authoritative'],
		colorMood: 'Slate neutrals with confident cobalt, indigo, or deep teal primary and semantic status clarity.',
		typographyCharacter: 'Neutral neo-grotesk UI font with tabular numerals (`font-variant-numeric: tabular-nums`) for data precision.',
		layoutPhilosophy: 'Predictable persistent navigation shell (sidebar + top utility bar) with clean 12-column workspace cards.',
		surfaceTreatment: 'Layered neutral surfaces with crisp borders and clear active/selected indicators.',
		elevationStrategy: 'Subtle 2-tier elevation separating workspace canvas, cards, and popovers/modals.',
		borderRadiusStyle: 'Measured 6–8px radii for consistent enterprise precision.',
		motionCharacter: 'Snappy, utilitarian micro-transitions (120–180ms) that never slow power users.',
		visualTreatmentsToUse: ['Tabular numerals', 'Clear status pills', 'Keyboard focus rings', 'Structured data tables'],
		visualTreatmentsToAvoid: ['Experimental scroll-jacking', 'Low-contrast glassmorphism', 'Whimsical decorative blobs'],
		appropriateFor: ['CRM', 'ERP', 'HR platforms', 'B2B commerce', 'Internal tools', 'Admin consoles'],
		unsuitableFor: ['Experimental art portfolios', 'Immersive RPG games'],
	},
	'high-end-saas': {
		id: 'high-end-saas',
		name: 'High-End SaaS',
		rationale: 'Balances razor-sharp product storytelling with refined technical polish, crisp borders, and clear conversion paths.',
		aestheticKeywords: ['precision', 'modern', 'crisp', 'product-led'],
		colorMood: 'Deep charcoal or crisp cool white base, subtle tinted borders, focused electric indigo/violet/blue accent.',
		typographyCharacter: 'Geometric sans display with negative letter-spacing (-0.03em), readable sans body, mono for metrics/code.',
		layoutPhilosophy: 'Focused value-prop hero with real product preview, bento feature showcases, social proof, and transparent pricing.',
		surfaceTreatment: 'Crisp bordered cards, subtle top-edge radial sheen on dark surfaces, clean interactive states.',
		elevationStrategy: 'Fine border contrast + subtle layered shadows on elevated cards and interactive popovers.',
		borderRadiusStyle: '10–14px cards, 8px buttons/inputs.',
		motionCharacter: 'Refined spring micro-interactions and purposeful state transitions (150–250ms).',
		visualTreatmentsToUse: ['Bento grids', 'Product UI showcases', 'Subtle radial ambient light', 'Crisp hairline borders'],
		visualTreatmentsToAvoid: ['Rainbow gradients on every button', 'Generic stock handshake photos', 'Wall-of-text hero sections'],
		appropriateFor: ['SaaS websites', 'SaaS apps', 'AI products', 'Developer tools', 'Startup websites'],
		unsuitableFor: ['Traditional luxury fashion', 'Government legal archives'],
	},
	'contemporary-commerce': {
		id: 'contemporary-commerce',
		name: 'Contemporary Commerce',
		rationale: 'Optimizes product discovery, visual desirability, trust, and frictionless mobile-to-desktop purchasing.',
		aestheticKeywords: ['merchandising-first', 'inviting', 'trustworthy', 'conversion-focused'],
		colorMood: 'Clean neutral merchandising backdrop so product photography carries color, paired with strong high-contrast CTA buttons.',
		typographyCharacter: 'Clean expressive sans or editorial display paired with hyper-legible prices, badges, and variant selectors.',
		layoutPhilosophy: 'Hero campaign banner, category discovery strip, filterable responsive product grid, quick-view/PDP gallery, slide-over cart drawer.',
		surfaceTreatment: 'Clean studio product frames (consistent 3:4 or 1:1 ratios), subtle hover image swap, clear sale/stock states.',
		elevationStrategy: 'Flat product cards on clean surfaces; elevated sticky headers, filter drawers, and checkout summary.',
		borderRadiusStyle: '4–10px depending on brand warmth (sharper for fashion, softer for lifestyle/beauty).',
		motionCharacter: 'Crisp hover swaps, smooth drawer slides, instant add-to-cart feedback.',
		visualTreatmentsToUse: ['Consistent product card aspect ratios', 'Color/size swatch selectors', 'Trust & shipping signals', 'Sticky mobile add-to-cart'],
		visualTreatmentsToAvoid: ['Cluttered promo popups blocking content', 'Inconsistent image crops', 'Low-contrast price text'],
		appropriateFor: ['Online stores', 'Fashion', 'Electronics', 'Furniture', 'Beauty', 'Marketplaces', 'Groceries'],
		unsuitableFor: ['Industrial SCADA panels', 'Code editors'],
	},
	'swiss-editorial': {
		id: 'swiss-editorial',
		name: 'Swiss Typography & Grid',
		rationale: 'Uses mathematical grids, strong typographic scale contrast, and objective clarity for information-dense or design-forward products.',
		aestheticKeywords: ['international typographic style', 'modular', 'objective', 'disciplined'],
		colorMood: 'Stark white/off-white and deep black with one bold vermilion, cobalt, or emerald signal color.',
		typographyCharacter: 'Neo-grotesk sans (Helvetica/Inter/Plus Jakarta/Space Grotesk) with strict modular scale and flush-left alignment.',
		layoutPhilosophy: 'Visible or implied mathematical column rules, generous alignment discipline, numbered sections.',
		surfaceTreatment: 'Flat surfaces, crisp 1px horizontal and vertical dividers, zero decorative fluff.',
		elevationStrategy: 'Flat plane with structural dividers instead of drop shadows.',
		borderRadiusStyle: '0–4px sharp geometric discipline.',
		motionCharacter: 'Direct, crisp state changes without bounce.',
		visualTreatmentsToUse: ['Strong grid lines', 'Oversized typographic hierarchy', 'Monospace metadata', 'Disciplined negative space'],
		visualTreatmentsToAvoid: ['Blurry glassmorphism', 'Soft pastel blobs', 'Centered paragraphs of long prose'],
		appropriateFor: ['Documentation', 'Agencies', 'Design portfolios', 'Cultural events', 'Publishing', 'Architecture'],
		unsuitableFor: ['Casual mobile games', 'Playful kids apps'],
	},
	'editorial-magazine': {
		id: 'editorial-magazine',
		name: 'Editorial Magazine',
		rationale: 'Sustains long-form reading engagement and rich storytelling with deliberate pacing, pull quotes, and art-directed media.',
		aestheticKeywords: ['storytelling', 'curated', 'readable', 'authoritative'],
		colorMood: 'Warm paper ground (#FAF9F6) or high-contrast dark ink mode with restrained editorial accents.',
		typographyCharacter: 'Expressive editorial serif for headlines + highly legible body font (17–19px, 1.65 line-height).',
		layoutPhilosophy: 'Lead feature story, multi-column curated feed, clean single-column reading column (65ch max).',
		surfaceTreatment: 'Rule-separated story modules, caption typography, balanced photography ratios.',
		elevationStrategy: 'Flat editorial surface with subtle hover underlines and image framing.',
		borderRadiusStyle: '2–6px clean editorial framing.',
		motionCharacter: 'Gentle fade/reveal transitions that never distract from reading.',
		visualTreatmentsToUse: ['Category kickers', 'Bylines & reading time', 'Pull quotes', 'Responsive image captions'],
		visualTreatmentsToAvoid: ['Auto-playing distracting animations', 'Cramped 4-column text walls', 'Low-contrast gray body text'],
		appropriateFor: ['News & media', 'Blogs', 'Publishing platforms', 'Cultural institutions', 'Nonprofits'],
		unsuitableFor: ['Real-time trading terminals', 'Game HUDs'],
	},
	'modern-brutalism': {
		id: 'modern-brutalism',
		name: 'Modern Brutalism',
		rationale: 'Projects raw, unapologetic creative confidence and unmistakable brand memorability while maintaining usability.',
		aestheticKeywords: ['raw', 'structural', 'high-contrast', 'memorable'],
		colorMood: 'Stark monochrome paired with a single high-voltage acid, crimson, or cobalt accent.',
		typographyCharacter: 'Bold industrial grotesque or brutalist display paired with crisp monospace.',
		layoutPhilosophy: 'Exposed grid cells, full-width structural bands, oversized display typography.',
		surfaceTreatment: 'Solid fills, crisp 1–2px dark borders, raw honest structure.',
		elevationStrategy: 'Zero soft blur shadows; depth via hard contrast and layering.',
		borderRadiusStyle: '0px sharp structural edges.',
		motionCharacter: 'Instant snappy mechanical transitions (80–140ms).',
		visualTreatmentsToUse: ['Exposed borders', 'Monospace labels', 'High contrast', 'Bold typographic scale'],
		visualTreatmentsToAvoid: ['Unreadable low-contrast chaos', 'Broken mobile overflow', 'Soft pastel gradients'],
		appropriateFor: ['Creative agencies', 'Music/culture events', 'Experimental studios', 'Independent streetwear'],
		unsuitableFor: ['Healthcare clinics', 'Retail banking', 'Government portals'],
	},
	'neo-brutalism': {
		id: 'neo-brutalism',
		name: 'Neo-Brutalism',
		rationale: 'Combines playful bold color blocking, thick crisp outlines, and offset hard shadows with modern accessibility and clarity.',
		aestheticKeywords: ['bold', 'graphic', 'energetic', 'tactile'],
		colorMood: 'Warm cream canvas with saturated primary blocks (sunflower, electric blue, coral) framed in crisp black ink.',
		typographyCharacter: 'Heavy geometric display headings + crisp legible sans body.',
		layoutPhilosophy: 'Modular graphic cards with strong visual rhythm and unmistakable CTAs.',
		surfaceTreatment: '2px solid ink borders + hard 4px offset shadows that depress on active click.',
		elevationStrategy: 'Hard offset shadows (`4px 4px 0 #111`).',
		borderRadiusStyle: '6–10px crisp bordered corners.',
		motionCharacter: 'Tactile press-down micro-interaction (`translate(2px, 2px)`).',
		visualTreatmentsToUse: ['Crisp 2px outlines', 'Hard offset shadows', 'Bold pill badges', 'Tactile button press'],
		visualTreatmentsToAvoid: ['Muddy colors without contrast', 'Clashing unreadable text on bright fills'],
		appropriateFor: ['Creator tools', 'Indie products', 'Community platforms', 'Youth brands', 'Events'],
		unsuitableFor: ['Private wealth management', 'Luxury couture', 'Medical records'],
	},
	'glassmorphism': {
		id: 'glassmorphism',
		name: 'Restrained Glassmorphism',
		rationale: 'Creates depth and spatial continuity for layered overlays, media interfaces, and modern spatial dashboards when applied with strict contrast discipline.',
		aestheticKeywords: ['translucent', 'layered', 'atmospheric', 'spatial'],
		colorMood: 'Deep rich ambient backdrop with frosted semi-opaque panels (`rgba` + `backdrop-filter: blur(16px)`) and crisp 1px luminous edge highlight.',
		typographyCharacter: 'Clean modern sans with guaranteed >=4.5:1 text contrast over blurred surfaces.',
		layoutPhilosophy: 'Layered foreground panels over a subtle controlled ambient canvas.',
		surfaceTreatment: 'Controlled translucency (70–85% opacity) + 1px `rgba(255,255,255,0.14)` border; never unreadable transparent glass over busy photos.',
		elevationStrategy: 'Soft deep ambient shadow + luminous top rim highlight.',
		borderRadiusStyle: '14–20px smooth continuous corners.',
		motionCharacter: 'Fluid 220–300ms ease-out spatial transitions.',
		visualTreatmentsToUse: ['Frosted navbars/overlays', '1px luminous borders', 'Controlled ambient gradients', 'High-contrast text backing'],
		visualTreatmentsToAvoid: ['Glass panels over noisy busy imagery', 'Unreadable faint white-on-white text', 'Blurring 50+ scrolling nodes (GPU lag)'],
		appropriateFor: ['Media players', 'Smart-home/IoT', 'Spatial/AR/VR', 'Music & entertainment', 'Modern hero overlays'],
		unsuitableFor: ['Print-heavy documentation', 'Dense accounting ledgers'],
	},
	'soft-neumorphism': {
		id: 'soft-neumorphism',
		name: 'Carefully Restrained Neumorphism',
		rationale: 'Delivers tactile hardware-inspired physicality for smart-device controls, audio tools, and wellness apps while preserving accessible borders and contrast.',
		aestheticKeywords: ['tactile', 'sculpted', 'calm', 'hardware-inspired'],
		colorMood: 'Soft low-contrast neutral surface with accessible subtle borders and clear high-contrast active indicator accents.',
		typographyCharacter: 'Clean geometric/humanist sans with strong contrast (never faint embossed text).',
		layoutPhilosophy: 'Focused tactile controls with generous spacing so soft shadows never collide.',
		surfaceTreatment: 'Subtle dual-light soft extrusion paired with an explicit 1px accessibility border for clarity.',
		elevationStrategy: 'Soft inset (pressed) vs raised (idle) states.',
		borderRadiusStyle: '14–20px smooth sculptural radii.',
		motionCharacter: 'Smooth tactile press transitions (150ms).',
		visualTreatmentsToUse: ['Hardware dials/toggles', 'Subtle inner/outer shadow + explicit border', 'Clear focus outlines'],
		visualTreatmentsToAvoid: ['Low-contrast buttons without visible edges', 'Applying neumorphism to dense tables or long text'],
		appropriateFor: ['Smart-device controls', 'Audio/music utilities', 'Wellness & meditation apps'],
		unsuitableFor: ['Enterprise tables', 'E-commerce catalogs', 'Accessibility-first government sites'],
	},
	'soft-minimalism': {
		id: 'soft-minimalism',
		name: 'Soft Minimalism',
		rationale: 'Creates approachable, serene, human-centered interfaces for healthcare, wellness, education, and consumer lifestyle apps.',
		aestheticKeywords: ['serene', 'approachable', 'warm', 'gentle'],
		colorMood: 'Soft warm neutrals (sand, sage, mist, soft slate) with calm trustworthy accents.',
		typographyCharacter: 'Humanist sans or friendly geometric sans with generous line-height (1.6).',
		layoutPhilosophy: 'Open, uncluttered card groupings with calm visual cadence and low cognitive load.',
		surfaceTreatment: 'Soft tonal cards on gentle off-white canvas with delicate borders.',
		elevationStrategy: 'Very soft diffused shadows on primary cards.',
		borderRadiusStyle: '12–16px friendly radii.',
		motionCharacter: 'Gentle, unhurried transitions (220–280ms).',
		visualTreatmentsToUse: ['Soft tonal grouping', 'Warm natural photography', 'Clear progress indicators', 'Generous padding'],
		visualTreatmentsToAvoid: ['Harsh neon alerts', 'Aggressive visual density', 'Sharp aggressive spikes'],
		appropriateFor: ['Healthcare', 'Wellness & fitness', 'Education', 'Personal finance', 'Lifestyle mobile apps'],
		unsuitableFor: ['Cybersecurity war rooms', 'Hardcore action games'],
	},
	'dark-premium': {
		id: 'dark-premium',
		name: 'Dark Premium',
		rationale: 'Delivers sleek focus, cinematic depth, and reduced glare for developer tools, creative studios, AI apps, media, and luxury dark brands.',
		aestheticKeywords: ['obsidian', 'cinematic', 'focused', 'crafted'],
		colorMood: 'Rich layered charcoal/obsidian (#090A0F, #11131A, #181B25 — never flat #000 everywhere) with crisp light ink and disciplined luminous accent.',
		typographyCharacter: 'Sharp modern sans + crisp monospace for telemetry/metadata.',
		layoutPhilosophy: 'Focused modular sections with subtle hairline grid dividers and clear contrast steps.',
		surfaceTreatment: 'Multi-step dark elevation ladder, 1px subtle translucent borders, occasional controlled ambient glow.',
		elevationStrategy: 'Lighter surface lightness for higher elevation + deep shadows.',
		borderRadiusStyle: '8–12px sleek precision radii.',
		motionCharacter: 'Silky 180–240ms transitions with subtle hover border illumination.',
		visualTreatmentsToUse: ['Layered dark surfaces', 'Subtle luminous hairline borders', 'Crisp syntax/data highlights'],
		visualTreatmentsToAvoid: ['Pure #000000 with harsh #FFFFFF glare', 'Blurry muddy dark gray text below 4.5:1 contrast'],
		appropriateFor: ['Developer tools', 'AI applications', 'Creative software', 'Media platforms', 'Crypto/fintech dark dashboards'],
		unsuitableFor: ['Traditional print newspapers', 'Bright daytime grocery stores'],
	},
	'light-premium': {
		id: 'light-premium',
		name: 'Light Premium',
		rationale: 'Projects crisp daylight clarity, openness, and effortless professionalism across SaaS, business, commerce, and consumer apps.',
		aestheticKeywords: ['luminous', 'crisp', 'airiness', 'clean'],
		colorMood: 'Pure white surfaces layered over subtle cool/warm alabaster canvas (#F8FAFC / #FAFAF9) with crisp charcoal ink.',
		typographyCharacter: 'Refined neo-grotesk or humanist sans with crisp weight hierarchy.',
		layoutPhilosophy: 'Structured grid with clear whitespace ratios and subtle card elevation.',
		surfaceTreatment: 'Crisp white cards with delicate 1px cool-gray borders and refined soft shadows.',
		elevationStrategy: 'Clean paper-like elevation tiers.',
		borderRadiusStyle: '10–12px balanced radii.',
		motionCharacter: 'Clean, effortless 160–220ms transitions.',
		visualTreatmentsToUse: ['Subtle tinted canvas vs pure white cards', 'Crisp hairline borders', 'Clean photography'],
		visualTreatmentsToAvoid: ['Heavy murky gray shadows', 'Washed-out borderless white-on-white cards'],
		appropriateFor: ['Business websites', 'SaaS apps', 'Healthcare', 'Education', 'Productivity'],
		unsuitableFor: ['Nocturnal cinema apps', 'Dark cyberpunk games'],
	},
	'material-inspired': {
		id: 'material-inspired',
		name: 'Material-Inspired',
		rationale: 'Provides familiar, tactile, accessible cross-platform affordances ideal for Android, multi-platform web apps, and utility workflows.',
		aestheticKeywords: ['tactile', 'systematic', 'accessible', 'tonal'],
		colorMood: 'Tonal surface container hierarchy derived from a harmonious primary seed color.',
		typographyCharacter: 'Highly legible humanist/geometric sans with strict display/headline/title/body/label roles.',
		layoutPhilosophy: 'Adaptive navigation rail/bar, responsive cards, floating action button where primary creation dominates.',
		surfaceTreatment: 'Tonal surface shifts + clear state layers (hover 8%, focus 12%, pressed 12%).',
		elevationStrategy: 'Consistent elevation scale (level 0–5).',
		borderRadiusStyle: '12–16px containers, full-pill primary actions and chips.',
		motionCharacter: 'Emphasized decelerate/accelerate curves with clear state feedback.',
		visualTreatmentsToUse: ['Tonal containers', 'Clear state layers', 'Adaptive nav rails/bottom bars', 'Accessible chips & FABs'],
		visualTreatmentsToAvoid: ['Conflicting multiple FABs', 'Legacy heavy Material 1 drop shadows'],
		appropriateFor: ['Android apps', 'Cross-platform mobile', 'Productivity', 'Delivery & utility apps'],
		unsuitableFor: ['Avant-garde fashion editorials'],
	},
	'fluent-inspired': {
		id: 'fluent-inspired',
		name: 'Fluent-Inspired',
		rationale: 'Suits desktop-grade productivity and enterprise software with calm neutral layering, subtle acrylic navigation, and crisp focus clarity.',
		aestheticKeywords: ['calm', 'desktop-native', 'layered', 'productive'],
		colorMood: 'Neutral mica/layer hierarchy with focused accent reserved for active selection and primary actions.',
		typographyCharacter: 'System/humanist UI sans with crisp sizing for dense toolbars and panels.',
		layoutPhilosophy: 'Clean master-detail panes, command bars, inspector panels, and keyboard-first shortcuts.',
		surfaceTreatment: 'Subtle translucent navigation rails paired with opaque high-legibility content canvases.',
		elevationStrategy: 'Restrained elevation with crisp 1px stroke borders.',
		borderRadiusStyle: '4–8px crisp desktop radii.',
		motionCharacter: 'Fast, responsive 120–180ms motion.',
		visualTreatmentsToUse: ['Command bars', 'Master-detail panes', 'Subtle selection indicators', 'Keyboard navigation'],
		visualTreatmentsToAvoid: ['Oversized marketing hero banners inside desktop tools'],
		appropriateFor: ['Desktop productivity', 'Enterprise desktop', 'System utilities', 'Management apps'],
		unsuitableFor: ['Editorial magazines', 'Casual mobile games'],
	},
	'apple-restraint': {
		id: 'apple-restraint',
		name: 'Apple-Inspired Restraint',
		rationale: 'Achieves iconic clarity through relentless simplification, razor-sharp typography, tactile controls, and content-first framing.',
		aestheticKeywords: ['clarity', 'deference', 'depth', 'craft'],
		colorMood: 'Pure crisp monochrome canvas where photography and one vibrant system tint provide focus.',
		typographyCharacter: 'Neutral sans with tight display tracking, clean optical weights, and effortless legibility.',
		layoutPhilosophy: 'Generous margins, unmistakable focal point per viewport, zero redundant chrome.',
		surfaceTreatment: 'Clean grouped surfaces, hairline dividers, subtle translucent top bar on scroll.',
		elevationStrategy: 'Content-first depth via subtle blur bars and refined sheets/popovers.',
		borderRadiusStyle: '12–18px smooth continuous corners.',
		motionCharacter: 'Natural physics-inspired spring transitions.',
		visualTreatmentsToUse: ['Content-first framing', 'Translucent sticky headers', 'Grouped inset lists', 'Crisp iconography'],
		visualTreatmentsToAvoid: ['Redundant borders inside borders', 'Noisy promotional clutter'],
		appropriateFor: ['iOS apps', 'Consumer hardware/products', 'Personal productivity', 'Media & lifestyle'],
		unsuitableFor: ['Raw brutalist zines'],
	},
	'high-contrast-editorial': {
		id: 'high-contrast-editorial',
		name: 'High-Contrast Editorial',
		rationale: 'Commands immediate attention through stark tonal contrast, dramatic typographic scale, and curated photography.',
		aestheticKeywords: ['dramatic', 'monochrome', 'sculptural', 'bold'],
		colorMood: 'Deep ink (#0A0A0A) and crisp off-white (#F7F6F2) with a single surgical accent.',
		typographyCharacter: 'Dramatic oversized display headlines paired with refined crisp body copy.',
		layoutPhilosophy: 'Full-width editorial splits, asymmetric galleries, strong rhythm between dark and light bands.',
		surfaceTreatment: 'High-contrast band alternation with crisp 1px rules.',
		elevationStrategy: 'Flat contrast planes.',
		borderRadiusStyle: '0–4px sharp editorial framing.',
		motionCharacter: 'Measured cinematic reveals.',
		visualTreatmentsToUse: ['Alternating dark/light bands', 'Editorial photography', 'Oversized numerals'],
		visualTreatmentsToAvoid: ['Muted low-contrast gray-on-gray sections'],
		appropriateFor: ['Agencies', 'Architecture', 'Fashion lookbooks', 'Cultural events', 'Design portfolios'],
		unsuitableFor: ['Dense operational spreadsheets'],
	},
	'modern-dashboard': {
		id: 'modern-dashboard',
		name: 'Modern Dashboard',
		rationale: 'Maximizes analytical comprehension, rapid anomaly spotting, and effortless drill-downs without visual fatigue.',
		aestheticKeywords: ['analytical', 'legible', 'high-signal', 'modular'],
		colorMood: 'Low-saturation neutral canvas so chart series, KPI deltas, and semantic status colors carry immediate meaning.',
		typographyCharacter: 'Clean UI sans with mandatory tabular numbers (`tabular-nums`) for aligned KPIs and tables.',
		layoutPhilosophy: 'Collapsible sidebar, filter/date toolbar, KPI summary strip, primary visualization grid, interactive detail table.',
		surfaceTreatment: 'Crisp uniform cards (1px border, consistent padding) with clear empty/loading/error states.',
		elevationStrategy: 'Flat bordered cards; elevated tooltips, dropdowns, and detail drawers.',
		borderRadiusStyle: '8–10px uniform radii.',
		motionCharacter: 'Crisp chart/filter transitions (150–220ms) that keep data updates clear.',
		visualTreatmentsToUse: ['Tabular KPIs', 'Colorblind-safe chart palettes', 'Inline sparklines', 'Interactive filters & sorting'],
		visualTreatmentsToAvoid: ['3D pie charts', 'Rainbow backgrounds behind charts', 'Tiny unreadable axis labels'],
		appropriateFor: ['Analytics', 'BI dashboards', 'Financial dashboards', 'Merchant dashboards', 'IoT dashboards'],
		unsuitableFor: ['Luxury fashion homepages'],
	},
	'immersive-storytelling': {
		id: 'immersive-storytelling',
		name: 'Immersive Visual Storytelling',
		rationale: 'Engages emotion and narrative flow through full-bleed visuals, paced chapter reveals, and atmospheric art direction.',
		aestheticKeywords: ['cinematic', 'narrative', 'atmospheric', 'art-directed'],
		colorMood: 'Derived harmoniously from hero photography/artwork with dark/light contrast scrims for text legibility.',
		typographyCharacter: 'Expressive display typography paired with clean readable narrative copy.',
		layoutPhilosophy: 'Paced full-bleed chapters, sticky narrative split panels, curated media galleries.',
		surfaceTreatment: 'Full-bleed photography with subtle gradient contrast scrims (`linear-gradient(to top, rgba(0,0,0,0.72), transparent)`).',
		elevationStrategy: 'Atmospheric depth through framing and subtle parallax (disabled under `prefers-reduced-motion`).',
		borderRadiusStyle: '4–12px tailored to brand tone.',
		motionCharacter: 'Paced scroll reveals that respect `prefers-reduced-motion`.',
		visualTreatmentsToUse: ['Gradient image scrims', 'Full-bleed hero media', 'Narrative pacing', 'Curated galleries'],
		visualTreatmentsToAvoid: ['Text directly over busy images without scrims', 'Janky scroll hijacking'],
		appropriateFor: ['Travel & hospitality', 'Events', 'Nonprofit impact stories', 'Entertainment', 'Restaurants', 'Brand launches'],
		unsuitableFor: ['Accounting software', 'Database consoles'],
	},
	'experimental-creative': {
		id: 'experimental-creative',
		name: 'Experimental Creative',
		rationale: 'Demonstrates studio artistry and distinctive digital craft through bold composition, expressive typography, and kinetic detail.',
		aestheticKeywords: ['avant-garde', 'expressive', 'distinctive', 'artistic'],
		colorMood: 'Curated high-character palette (e.g. bone + cobalt + vermilion, or obsidian + chartreuse).',
		typographyCharacter: 'Distinctive display face with dynamic scale contrast and editorial captions.',
		layoutPhilosophy: 'Asymmetric broken-grid showcases that still collapse cleanly and predictably on mobile.',
		surfaceTreatment: 'Bold typographic framing, curated media masks, crisp interactive hover previews.',
		elevationStrategy: 'Compositional layering rather than generic drop shadows.',
		borderRadiusStyle: 'Intentional contrast (either razor sharp 0px or sculptural pills).',
		motionCharacter: 'Choreographed micro-interactions and smooth hover physics with reduced-motion fallback.',
		visualTreatmentsToUse: ['Asymmetric grids', 'Hover preview reveals', 'Expressive display type'],
		visualTreatmentsToAvoid: ['Breaking navigation discoverability', 'Unusable mobile layouts'],
		appropriateFor: ['Creative agencies', 'Design portfolios', 'Art exhibitions', 'Interactive brand experiences'],
		unsuitableFor: ['Healthcare', 'Banking', 'Government'],
	},
	'futuristic-tech': {
		id: 'futuristic-tech',
		name: 'Futuristic Technology',
		rationale: 'Signals cutting-edge AI, robotics, geospatial, or deep-tech innovation through precision telemetry aesthetics and subtle luminous accents.',
		aestheticKeywords: ['precision', 'luminous', 'technical', 'forward-looking'],
		colorMood: 'Deep slate/obsidian ground with crisp cyan, electric blue, or emerald technical accents.',
		typographyCharacter: 'Geometric technical sans + monospace telemetry labels.',
		layoutPhilosophy: 'Precision modular grid with technical indicators, crisp diagrams, and live interactive controls.',
		surfaceTreatment: 'Dark precision panels, subtle grid hairlines, restrained accent glow on active focus.',
		elevationStrategy: 'Luminous 1px rim borders and subtle layered depth.',
		borderRadiusStyle: '6–10px technical precision.',
		motionCharacter: 'Crisp, purposeful telemetry transitions.',
		visualTreatmentsToUse: ['Subtle dot/line grid texture', 'Monospace status badges', 'Restrained accent borders'],
		visualTreatmentsToAvoid: ['Unreadable sci-fi novelty fonts', 'Blinding neon overload'],
		appropriateFor: ['AI apps', 'IoT dashboards', 'Maps/geospatial', 'Scientific/robotics tools', 'Automotive UI'],
		unsuitableFor: ['Organic bakeries', 'Traditional law firms'],
	},
	'financial-authority': {
		id: 'financial-authority',
		name: 'Professional Financial',
		rationale: 'Instills instant trust, numerical accuracy, and calm decision-making for banking, wealth, accounting, and fintech products.',
		aestheticKeywords: ['trustworthy', 'precise', 'calm', 'institutional'],
		colorMood: 'Crisp alabaster/white + deep navy, forest emerald, or slate ink; semantic green/red strictly for positive/negative performance.',
		typographyCharacter: 'Authoritative sans (or refined serif display for wealth) + strict `tabular-nums` for balances and tables.',
		layoutPhilosophy: 'Clear balance/portfolio hierarchy, scannable transaction ledger, explicit confirmation flows.',
		surfaceTreatment: 'Crisp bordered surfaces, clean spacing, clear security/verification cues.',
		elevationStrategy: 'Subtle crisp elevation for primary account cards and action modals.',
		borderRadiusStyle: '8–10px measured radii.',
		motionCharacter: 'Calm, confident transitions (150–200ms) with zero gimmickry.',
		visualTreatmentsToUse: ['Tabular currency alignment', 'Clear semantic delta badges', 'Explicit confirmation dialogs', 'Clean accessible charts'],
		visualTreatmentsToAvoid: ['Playful cartoon confetti on financial transfers', 'Ambiguous color-only gain/loss cues'],
		appropriateFor: ['Banking apps', 'Financial services', 'Accounting software', 'Financial dashboards', 'Fintech'],
		unsuitableFor: ['Arcade games', 'Streetwear drops'],
	},
	'elegant-hospitality': {
		id: 'elegant-hospitality',
		name: 'Elegant Hospitality',
		rationale: 'Evokes warmth, sensory pleasure, and effortless reservation/booking clarity for restaurants, hotels, and travel brands.',
		aestheticKeywords: ['inviting', 'sensory', 'refined', 'warm'],
		colorMood: 'Warm cream, linen, terracotta, olive, or deep espresso with rich photography.',
		typographyCharacter: 'Warm editorial serif headings paired with clean legible humanist sans.',
		layoutPhilosophy: 'Atmospheric hero with immediate booking/reservation widget, curated menus/rooms, photography gallery, location & hours.',
		surfaceTreatment: 'Warm paper grounds, crisp photography frames, clear pricing and availability.',
		elevationStrategy: 'Soft natural shadows on sticky booking bars and cards.',
		borderRadiusStyle: '4–10px refined warmth.',
		motionCharacter: 'Smooth inviting reveals (250–350ms).',
		visualTreatmentsToUse: ['Appetizing/atmospheric photography', 'Immediate booking/reservation access', 'Clean menu/itinerary typography'],
		visualTreatmentsToAvoid: ['Cold sterile corporate blue', 'Hard-to-find hours/location/booking controls'],
		appropriateFor: ['Restaurants', 'Travel & hospitality', 'Boutique hotels', 'Booking platforms', 'Real estate'],
		unsuitableFor: ['Industrial control panels', 'Code editors'],
	},
	'sophisticated-fashion': {
		id: 'sophisticated-fashion',
		name: 'Sophisticated Fashion',
		rationale: 'Balances runway editorial allure with effortless e-commerce merchandising, size/color clarity, and high-converting lookbook flows.',
		aestheticKeywords: ['editorial', 'modern-luxury', 'lookbook', 'curated'],
		colorMood: 'Pure gallery white or warm stone canvas, stark black ink, ultra-restrained camel/burgundy/espresso accent.',
		typographyCharacter: 'Refined editorial serif or sharp fashion grotesque + uppercase tracked micro-navigation.',
		layoutPhilosophy: 'Full-bleed seasonal campaign, clean 3:4 portrait product cards, quick size selector, editorial lookbook, slide-out bag.',
		surfaceTreatment: 'Borderless or hairline gallery product tiles where garments breathe with generous whitespace.',
		elevationStrategy: 'Flat gallery grid; crisp slide-over cart and filter drawers.',
		borderRadiusStyle: '0–4px crisp tailored corners.',
		motionCharacter: 'Refined hover secondary-angle image transition and smooth drawer motion.',
		visualTreatmentsToUse: ['3:4 portrait apparel photography', 'Hover alternate angle / quick-add', 'Color swatches & size guide', 'Editorial typography'],
		visualTreatmentsToAvoid: ['Giant red discount stickers covering garments', 'Heavy rounded drop-shadow boxes', 'Cluttered sidebars'],
		appropriateFor: ['Fashion stores', 'Beauty & cosmetics', 'Jewelry & accessories', 'Design furniture'],
		unsuitableFor: ['Developer IDEs', 'Server monitoring tools'],
	},
	'gaming-immersive': {
		id: 'gaming-immersive',
		name: 'Gaming & Interactive Experience',
		rationale: 'Delivers strong art direction, immediate HUD legibility, responsive control feedback, and exciting atmosphere without sacrificing readability.',
		aestheticKeywords: ['immersive', 'kinetic', 'art-directed', 'responsive'],
		colorMood: 'Deep atmospheric dark ground with intentional high-contrast faction/rarity/status accents (gold, emerald, crimson, electric cyan).',
		typographyCharacter: 'Distinctive display title font paired with ultra-clear HUD sans/mono numerals.',
		layoutPhilosophy: 'Focused viewport canvas / interactive stage with unobtrusive peripheral HUD, clear inventory/menu hierarchy.',
		surfaceTreatment: 'Layered atmospheric frames, sharp bevels or crisp luminous borders, tactile interactive hit states.',
		elevationStrategy: 'Layered HUD depth over immersive world backdrop.',
		borderRadiusStyle: '4–8px crisp tactical geometry (or rounded playful for puzzle/casual games).',
		motionCharacter: 'Responsive 60fps feedback (hover, press, score/reward pulses) with reduced-motion option.',
		visualTreatmentsToUse: ['Clear HUD contrast plates', 'Responsive keyboard/touch/gamepad states', 'Distinct rarity/status coding'],
		visualTreatmentsToAvoid: ['Unreadable decorative fonts in menus', 'HUD elements obscuring gameplay area'],
		appropriateFor: ['Browser games', 'Mobile/desktop games', 'Game launchers', 'Game stores', 'HUDs & inventory UIs'],
		unsuitableFor: ['Healthcare patient portals', 'Tax accounting'],
	},
};

// ============================================================================
// 3. PROFESSIONAL TYPOGRAPHY PAIRINGS
// ============================================================================

interface TypographyPreset {
	readonly id: string;
	readonly pairingName: string;
	readonly displayFont: string;
	readonly bodyFont: string;
	readonly monoFont: string;
	readonly directions: readonly VisualDirectionId[];
	readonly rationale: string;
}

const TYPOGRAPHY_PRESETS: readonly TypographyPreset[] = [
	{
		id: 'editorial-serif-grotesk',
		pairingName: 'Cormorant Garamond + Inter',
		displayFont: 'Cormorant Garamond',
		bodyFont: 'Inter',
		monoFont: 'JetBrains Mono',
		directions: ['luxury-editorial', 'sophisticated-fashion', 'elegant-hospitality'],
		rationale: 'High-contrast luxury serif display headlines paired with crisp, neutral UI sans for effortless prices, navigation, and body legibility.',
	},
	{
		id: 'magazine-serif-sans',
		pairingName: 'Playfair Display + Source Sans 3',
		displayFont: 'Playfair Display',
		bodyFont: 'Source Sans 3',
		monoFont: 'JetBrains Mono',
		directions: ['editorial-magazine', 'immersive-storytelling'],
		rationale: 'Authoritative editorial headlines paired with an exceptionally readable humanist sans built for sustained reading.',
	},
	{
		id: 'saas-geometric-precision',
		pairingName: 'Plus Jakarta Sans + Inter',
		displayFont: 'Plus Jakarta Sans',
		bodyFont: 'Inter',
		monoFont: 'JetBrains Mono',
		directions: ['high-end-saas', 'light-premium', 'premium-minimalism', 'contemporary-commerce'],
		rationale: 'Modern geometric display warmth with tight headline tracking, anchored by Inter for razor-sharp interface legibility at all sizes.',
	},
	{
		id: 'swiss-modernist',
		pairingName: 'Space Grotesk + Inter',
		displayFont: 'Space Grotesk',
		bodyFont: 'Inter',
		monoFont: 'IBM Plex Mono',
		directions: ['swiss-editorial', 'modern-brutalism', 'neo-brutalism', 'experimental-creative', 'futuristic-tech'],
		rationale: 'Architectural grotesque display character paired with clean neutral sans and technical IBM Plex Mono metadata.',
	},
	{
		id: 'enterprise-clarity',
		pairingName: 'IBM Plex Sans + IBM Plex Mono',
		displayFont: 'IBM Plex Sans',
		bodyFont: 'IBM Plex Sans',
		monoFont: 'IBM Plex Mono',
		directions: ['modern-enterprise', 'modern-dashboard', 'financial-authority', 'fluent-inspired'],
		rationale: 'Engineered specifically for complex UIs, financial tables, and dashboards with superb figure legibility and tabular alignment.',
	},
	{
		id: 'humanist-calm',
		pairingName: 'Outfit + DM Sans',
		displayFont: 'Outfit',
		bodyFont: 'DM Sans',
		monoFont: 'JetBrains Mono',
		directions: ['soft-minimalism', 'soft-neumorphism', 'material-inspired', 'glassmorphism'],
		rationale: 'Friendly, balanced geometric proportions that communicate calm clarity for healthcare, wellness, education, and mobile apps.',
	},
	{
		id: 'dark-precision-studio',
		pairingName: 'Sora + Inter',
		displayFont: 'Sora',
		bodyFont: 'Inter',
		monoFont: 'JetBrains Mono',
		directions: ['dark-premium', 'high-contrast-editorial', 'apple-restraint'],
		rationale: 'Crisp contemporary display geometry with strong presence on dark and light surfaces alike.',
	},
	{
		id: 'gaming-tactical',
		pairingName: 'Chakra Petch + Inter',
		displayFont: 'Chakra Petch',
		bodyFont: 'Inter',
		monoFont: 'JetBrains Mono',
		directions: ['gaming-immersive'],
		rationale: 'Distinctive sharp-cornered display energy for titles and HUD counters paired with ultra-legible sans for menus and tooltips.',
	},
];

function encodeGoogleFont(name: string, weights: string): string {
	return `family=${encodeURIComponent(name).replace(/%20/g, '+')}:wght@${weights}`;
}

export function buildTypographyRecommendation(
	direction: VisualDirectionId,
	overrides?: { headingFont?: string; bodyFont?: string; monoFont?: string },
): TypographyRecommendation {
	const preset = TYPOGRAPHY_PRESETS.find(p => p.directions.includes(direction)) ?? TYPOGRAPHY_PRESETS[2];
	const displayFont = overrides?.headingFont?.trim() || preset.displayFont;
	const bodyFont = overrides?.bodyFont?.trim() || preset.bodyFont;
	const monoFont = overrides?.monoFont?.trim() || preset.monoFont;

	const isSerifDisplay = /garamond|playfair|merriweather|lora|fraunces|serif|bodoni|cormorant|newsreader/i.test(displayFont);
	const families = new Set<string>([
		encodeGoogleFont(displayFont, isSerifDisplay ? '400;500;600;700' : '500;600;700;800'),
		encodeGoogleFont(bodyFont, '400;500;600;700'),
		encodeGoogleFont(monoFont, '400;500;600'),
	]);
	const googleFontsUrl = `https://fonts.googleapis.com/css2?${[...families].join('&')}&display=swap`;

	const isEditorial = direction === 'luxury-editorial' || direction === 'editorial-magazine' || direction === 'sophisticated-fashion';

	return {
		id: preset.id,
		pairingName: `${displayFont} + ${bodyFont}`,
		displayFont,
		bodyFont,
		monoFont,
		googleFontsUrl,
		fontStacks: {
			display: `'${displayFont}', ${isSerifDisplay ? 'Georgia, Cambria, "Times New Roman", serif' : 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'}`,
			body: `'${bodyFont}', system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`,
			mono: `'${monoFont}', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`,
		},
		scale: [
			{ token: '--text-display', role: 'Hero Display', sizeClamp: isEditorial ? 'clamp(2.5rem, 5.5vw, 4.75rem)' : 'clamp(2.25rem, 4.5vw, 3.75rem)', lineHeight: '1.08', weight: isSerifDisplay ? 500 : 700, letterSpacing: isSerifDisplay ? '-0.02em' : '-0.03em' },
			{ token: '--text-h1', role: 'Page Heading (H1)', sizeClamp: 'clamp(1.875rem, 3.2vw, 2.75rem)', lineHeight: '1.15', weight: isSerifDisplay ? 500 : 700, letterSpacing: '-0.025em' },
			{ token: '--text-h2', role: 'Section Heading (H2)', sizeClamp: 'clamp(1.5rem, 2.4vw, 2.125rem)', lineHeight: '1.22', weight: 600, letterSpacing: '-0.02em' },
			{ token: '--text-h3', role: 'Card / Subsection Heading (H3)', sizeClamp: 'clamp(1.125rem, 1.5vw, 1.375rem)', lineHeight: '1.3', weight: 600, letterSpacing: '-0.01em' },
			{ token: '--text-body-lg', role: 'Lead Paragraph', sizeClamp: 'clamp(1.0625rem, 1.2vw, 1.25rem)', lineHeight: '1.6', weight: 400, letterSpacing: '0em' },
			{ token: '--text-body', role: 'Body Copy', sizeClamp: '1rem', lineHeight: '1.6', weight: 400, letterSpacing: '0em' },
			{ token: '--text-sm', role: 'UI Control / Secondary Text', sizeClamp: '0.875rem', lineHeight: '1.5', weight: 500, letterSpacing: '0em' },
			{ token: '--text-xs', role: 'Caption / Overline / Badge', sizeClamp: '0.75rem', lineHeight: '1.4', weight: 600, letterSpacing: '0.06em' },
		],
		rationale: preset.rationale,
		bestPractices: [
			'Limit body copy width to 60–72ch (`max-w-prose`) for effortless reading.',
			'Use `font-variant-numeric: tabular-nums` on prices, KPI counters, timers, and table numbers.',
			'Keep exactly one `<h1>` per page with clean descending heading levels (`h1 → h2 → h3`).',
			'Never make every element visually loud — reserve display sizes strictly for primary page/section anchors.',
			'Preconnect to `fonts.googleapis.com` and `fonts.gstatic.com` with `display=swap` to avoid FOIT.',
		],
	};
}

// ============================================================================
// 4. PRODUCT CATEGORY BLUEPRINTS (ALL 7 DIGITAL PRODUCT DOMAINS)
// ============================================================================

export interface ProductBlueprint {
	readonly category: ProductCategory;
	readonly domain: ProductDomain;
	readonly label: string;
	readonly industry: string;
	readonly keywords: readonly string[];
	readonly defaultDirections: readonly VisualDirectionId[];
	readonly defaultThemeMode: 'light' | 'dark' | 'both';
	readonly defaultPrimaryHex: string;
	readonly defaultHarmony: ColorHarmonyStrategy;
	readonly targetUsers: readonly string[];
	readonly primaryGoals: readonly string[];
	readonly requiredPages: readonly string[];
	readonly coreComponents: readonly string[];
	readonly interactiveFunctionality: readonly string[];
	readonly userJourneys: readonly UserJourneySpec[];
	readonly assetNeeds: readonly RequiredAssetNeed[];
	readonly brandPersonality: readonly string[];
}

export const PRODUCT_BLUEPRINTS: readonly ProductBlueprint[] = [
	// --- E-COMMERCE ---
	{
		category: 'fashion_store',
		domain: 'ecommerce',
		label: 'Fashion E-Commerce Store',
		industry: 'Fashion & Apparel Retail',
		keywords: ['fashion', 'clothing', 'apparel', 'boutique', 'streetwear', 'couture', 'atelier', 'wardrobe', 'dress', 'menswear', 'womenswear', 'shoes', 'sneakers', 'luxury brand'],
		defaultDirections: ['sophisticated-fashion', 'luxury-editorial', 'contemporary-commerce'],
		defaultThemeMode: 'light',
		defaultPrimaryHex: '#18181B',
		defaultHarmony: 'warm-editorial',
		targetUsers: ['Style-conscious shoppers', 'Repeat brand loyalists', 'Mobile impulse buyers', 'Gift shoppers'],
		primaryGoals: ['Discover seasonal collections effortlessly', 'Evaluate garment fit, fabric, and styling visually', 'Filter by category, size, color, and price', 'Complete checkout smoothly on mobile and desktop'],
		requiredPages: ['Homepage / Campaign Lookbook', 'Collection / Product Listing (PLP)', 'Product Detail Page (PDP)', 'Shopping Bag Drawer & Cart Page', 'Checkout Flow', 'Search & Discovery', 'Wishlist & Customer Account', 'Order History & Tracking', 'Admin / Inventory & Orders View (if full platform)'],
		coreComponents: ['Editorial hero campaign', '3:4 portrait product cards with hover swap', 'Sticky mega-nav with mobile drawer', 'Faceted filter & sort bar', 'Color & size swatch selector', 'Image gallery with zoom', 'Slide-over cart drawer with live subtotal', 'Wishlist toggle', 'Reviews & fit guide', 'Trust & shipping banner'],
		interactiveFunctionality: ['Live search across catalog', 'Multi-facet filtering (category, size, color, price) & sorting', 'Variant selection updating price/SKU/availability', 'Persistent shopping cart (add, quantity, remove, promo code, subtotal)', 'Wishlist persistence', 'Validated checkout form with order confirmation state'],
		userJourneys: [
			{ name: 'Collection Discovery to Purchase', actor: 'Shopper', steps: ['Land on editorial hero', 'Browse collection or search', 'Filter by size & color', 'Inspect PDP gallery & size guide', 'Select size and add to bag', 'Review slide-over cart and complete checkout'], conversionOrOutcome: 'Completed order with tracking confirmation' },
			{ name: 'Curated Wishlist Save', actor: 'Returning Shopper', steps: ['Heart items on PLP/PDP', 'Open Wishlist', 'Move preferred size to bag'], conversionOrOutcome: 'Higher repeat purchase conversion' },
		],
		assetNeeds: [
			{ slot: 'hero-campaign', purpose: 'Full-bleed seasonal campaign hero photograph', subjectQuery: 'minimalist luxury fashion editorial model studio coat', style: 'editorial studio lighting', aspectRatio: '16:9', orientation: 'landscape', altTextTemplate: 'Seasonal collection editorial lookbook hero', priority: 'essential' },
			{ slot: 'product-apparel', purpose: 'Consistent portrait product photography for catalog cards', subjectQuery: 'modern tailored fashion garment minimal studio portrait', style: 'clean neutral studio backdrop', aspectRatio: '3:4', orientation: 'portrait', altTextTemplate: 'Tailored fashion product photograph', priority: 'essential' },
			{ slot: 'lookbook-editorial', purpose: 'Lifestyle/atelier storytelling banner', subjectQuery: 'fashion atelier fabric texture luxury boutique interior', style: 'warm editorial natural light', aspectRatio: '4:3', orientation: 'landscape', altTextTemplate: 'Brand craftsmanship and boutique atmosphere', priority: 'recommended' },
		],
		brandPersonality: ['refined', 'editorial', 'confident', 'curated'],
	},
	{
		category: 'online_store',
		domain: 'ecommerce',
		label: 'Online Store / E-Commerce Platform',
		industry: 'Retail & E-Commerce',
		keywords: ['ecommerce', 'e-commerce', 'online store', 'shop', 'storefront', 'shopping', 'marketplace', 'retail', 'electronics store', 'furniture store', 'grocery', 'beauty', 'cosmetics', 'cart', 'checkout'],
		defaultDirections: ['contemporary-commerce', 'light-premium', 'premium-minimalism'],
		defaultThemeMode: 'light',
		defaultPrimaryHex: '#1D4ED8',
		defaultHarmony: 'neutral-accent',
		targetUsers: ['Online shoppers', 'Comparison buyers', 'Mobile shoppers', 'Store administrators'],
		primaryGoals: ['Find relevant products quickly', 'Compare specs, prices, and reviews', 'Manage cart and checkout with zero friction'],
		requiredPages: ['Storefront Homepage', 'Category & Product Listing', 'Product Detail Page', 'Cart & Checkout', 'Search Results', 'Wishlist & Account / Order Tracking'],
		coreComponents: ['Hero promotion banner', 'Category cards', 'Product cards with rating & quick-add', 'Faceted filters & sort dropdown', 'Product gallery', 'Slide-over cart drawer', 'Checkout stepper', 'Search bar with live results', 'Review & rating summary'],
		interactiveFunctionality: ['Real-time product search', 'Category/price/rating filtering & sorting', 'Cart state with localStorage persistence', 'Quantity/remove/coupon calculations', 'Validated checkout & order confirmation', 'Wishlist toggle'],
		userJourneys: [
			{ name: 'Search to Checkout', actor: 'Buyer', steps: ['Search or click category', 'Filter and sort products', 'Open product detail & reviews', 'Add to cart', 'Complete checkout form'], conversionOrOutcome: 'Verified order receipt' },
		],
		assetNeeds: [
			{ slot: 'hero-banner', purpose: 'Primary storefront hero visual', subjectQuery: 'modern lifestyle product photography minimal studio aesthetic', style: 'crisp commercial studio', aspectRatio: '16:9', orientation: 'landscape', altTextTemplate: 'Featured storefront collection', priority: 'essential' },
			{ slot: 'product-grid', purpose: 'Clean product photography for cards', subjectQuery: 'minimalist consumer product studio photography clean background', style: 'clean e-commerce product shot', aspectRatio: '1:1', orientation: 'square', altTextTemplate: 'Product item photograph', priority: 'essential' },
		],
		brandPersonality: ['trustworthy', 'modern', 'inviting', 'clear'],
	},
	// --- SAAS & WEB APPS ---
	{
		category: 'saas_application',
		domain: 'web_app',
		label: 'SaaS Web Application',
		industry: 'B2B / Cloud Software',
		keywords: ['saas', 'web app', 'platform', 'workspace', 'crm', 'erp', 'project management', 'kanban', 'workflow', 'collaboration', 'hr platform', 'customer portal', 'admin', 'ticketing', 'helpdesk'],
		defaultDirections: ['high-end-saas', 'modern-enterprise', 'modern-dashboard'],
		defaultThemeMode: 'both',
		defaultPrimaryHex: '#4F46E5',
		defaultHarmony: 'neutral-accent',
		targetUsers: ['Knowledge workers', 'Team leads & managers', 'Operations & admin specialists'],
		primaryGoals: ['Complete daily workflows rapidly', 'Monitor team/pipeline status at a glance', 'Search, filter, and act on records without friction'],
		requiredPages: ['Workspace Overview / Dashboard', 'Primary Entity List & Filters (Table/Board)', 'Detail View / Drawer', 'Create & Edit Forms', 'Team / Settings & Billing', 'Authentication (Sign In / Sign Up)'],
		coreComponents: ['Collapsible sidebar navigation', 'Top command/search bar', 'KPI metric tiles', 'Interactive filterable/sortable data table', 'Slide-over detail drawer', 'Modal forms with validation', 'Status badges & avatars', 'Toast notifications', 'Empty, loading skeleton, and error states'],
		interactiveFunctionality: ['Instant search & multi-filter on records', 'Column sorting & pagination', 'Create/Edit/Delete records with state updates', 'Tab/view switching (List vs Board)', 'Persisted settings/preferences', 'Keyboard-accessible dialogs'],
		userJourneys: [
			{ name: 'Triage and Update Record', actor: 'Team Member', steps: ['Scan KPIs on overview', 'Filter table to high-priority items', 'Open record detail drawer', 'Update status and save', 'See live metric and toast feedback'], conversionOrOutcome: 'Record updated with immediate feedback' },
		],
		assetNeeds: [
			{ slot: 'user-avatars', purpose: 'Realistic team/customer portraits or crisp initial avatars', subjectQuery: 'professional portrait headshot studio minimal', style: 'clean neutral portrait', aspectRatio: '1:1', orientation: 'square', altTextTemplate: 'Team member portrait', priority: 'recommended' },
		],
		brandPersonality: ['crisp', 'productive', 'dependable', 'modern'],
	},
	{
		category: 'analytics_platform',
		domain: 'web_app',
		label: 'Analytics & BI Dashboard',
		industry: 'Data & Business Intelligence',
		keywords: ['analytics', 'dashboard', 'bi', 'metrics', 'telemetry', 'monitoring', 'reporting', 'kpi', 'insights', 'data visualization', 'charts', 'observability'],
		defaultDirections: ['modern-dashboard', 'dark-premium', 'modern-enterprise'],
		defaultThemeMode: 'both',
		defaultPrimaryHex: '#2563EB',
		defaultHarmony: 'cool-technical',
		targetUsers: ['Analysts', 'Executives', 'Product & engineering leads'],
		primaryGoals: ['Spot trends and anomalies rapidly', 'Segment data by timeframe and dimensions', 'Drill into underlying records and export'],
		requiredPages: ['Executive Overview', 'Detailed Analytics / Explorer', 'Reports & Exports', 'Alerts & Thresholds', 'Data Sources & Settings'],
		coreComponents: ['Sidebar nav', 'Date range & segment filter bar', 'KPI stat cards with trend deltas', 'Interactive line/bar/area/donut charts with tooltips', 'Sortable data table', 'Export CSV/JSON control', 'Loading skeletons & empty states'],
		interactiveFunctionality: ['Date range & segment filtering updating KPIs and charts live', 'Interactive hover tooltips on data points', 'Sortable/searchable breakdown table', 'Theme toggle (Light/Dark)', 'Real data export'],
		userJourneys: [
			{ name: 'Investigate Metric Anomaly', actor: 'Analyst', steps: ['Review KPI delta cards', 'Change date window & segment filter', 'Hover chart spike to inspect values', 'Drill into breakdown table'], conversionOrOutcome: 'Actionable insight verified from real data' },
		],
		assetNeeds: [],
		brandPersonality: ['analytical', 'precise', 'calm', 'high-signal'],
	},
	{
		category: 'financial_dashboard',
		domain: 'web_app',
		label: 'Banking, Finance & Accounting Platform',
		industry: 'Financial Services & Fintech',
		keywords: ['bank', 'banking', 'finance', 'fintech', 'accounting', 'wallet', 'trading', 'portfolio', 'invest', 'payment', 'invoice', 'treasury', 'wealth', 'crypto'],
		defaultDirections: ['financial-authority', 'modern-dashboard', 'light-premium'],
		defaultThemeMode: 'both',
		defaultPrimaryHex: '#0F4C81',
		defaultHarmony: 'monochromatic',
		targetUsers: ['Account holders', 'Finance teams', 'Portfolio managers', 'Auditors'],
		primaryGoals: ['Verify exact balances and cash flow', 'Inspect transactions with clarity', 'Execute transfers/payments with high trust and explicit confirmation'],
		requiredPages: ['Accounts & Net Worth Overview', 'Transactions Ledger', 'Transfers & Payments', 'Analytics & Cash Flow', 'Cards / Security & Settings'],
		coreComponents: ['Account balance hero cards (tabular numerals)', 'Cash-flow chart', 'Searchable/filterable transaction ledger', 'Transfer form with review/confirm modal', 'Security status badges', 'Statement export'],
		interactiveFunctionality: ['Filter transactions by category, status, date, and search', 'Validated transfer/payment flow with live balance update', 'Chart timeframe toggle', 'Masked/unmasked balance toggle'],
		userJourneys: [
			{ name: 'Review Balances & Send Transfer', actor: 'Customer', steps: ['Verify account balances', 'Filter recent ledger entries', 'Enter transfer recipient and amount', 'Review confirmation summary', 'Submit and verify updated balance & receipt'], conversionOrOutcome: 'Accurate, confirmed financial action' },
		],
		assetNeeds: [
			{ slot: 'trust-hero', purpose: 'Clean architectural/institutional visual for marketing/onboarding if needed', subjectQuery: 'modern minimalist financial architecture glass building daylight', style: 'crisp architectural photography', aspectRatio: '16:9', orientation: 'landscape', altTextTemplate: 'Modern financial institution architecture', priority: 'recommended' },
		],
		brandPersonality: ['trustworthy', 'authoritative', 'precise', 'calm'],
	},
	{
		category: 'ai_application',
		domain: 'web_app',
		label: 'AI-Powered Application',
		industry: 'Artificial Intelligence & Productivity',
		keywords: ['ai', 'llm', 'copilot', 'chatbot', 'assistant', 'agent', 'prompt', 'generative', 'machine learning', 'studio'],
		defaultDirections: ['dark-premium', 'high-end-saas', 'futuristic-tech'],
		defaultThemeMode: 'dark',
		defaultPrimaryHex: '#6366F1',
		defaultHarmony: 'cool-technical',
		targetUsers: ['Creators', 'Developers', 'Researchers', 'Enterprise operators'],
		primaryGoals: ['Compose prompts or workflows effortlessly', 'Inspect streaming outputs, citations, and artifacts clearly', 'Iterate, compare, and export results'],
		requiredPages: ['Interactive Workspace / Chat & Canvas', 'History & Saved Sessions', 'Prompt / Model Settings', 'Templates & Examples'],
		coreComponents: ['Thread/session sidebar', 'Rich prompt composer with quick starters', 'Structured response renderer (markdown, code, artifacts)', 'Model/parameter selector', 'Activity/status indicators', 'Copy/regenerate/export actions'],
		interactiveFunctionality: ['Live interactive session creation & switching', 'Prompt submission with realistic streaming/loading states', 'Search through session history', 'Settings persistence'],
		userJourneys: [
			{ name: 'Prompt to Verified Output', actor: 'User', steps: ['Pick starter or type prompt', 'Observe clear progress state', 'Inspect structured output & copy/save'], conversionOrOutcome: 'High-clarity AI workflow' },
		],
		assetNeeds: [],
		brandPersonality: ['intelligent', 'crisp', 'focused', 'crafted'],
	},
	// --- WEBSITES ---
	{
		category: 'saas_website',
		domain: 'website',
		label: 'SaaS & Startup Marketing Website',
		industry: 'Software & Technology',
		keywords: ['landing page', 'saas website', 'startup', 'marketing site', 'product launch', 'waitlist', 'homepage', 'corporate website', 'business website'],
		defaultDirections: ['high-end-saas', 'premium-minimalism', 'light-premium'],
		defaultThemeMode: 'both',
		defaultPrimaryHex: '#2563EB',
		defaultHarmony: 'neutral-accent',
		targetUsers: ['Prospective buyers', 'Technical evaluators', 'Decision makers'],
		primaryGoals: ['Understand the product value within 5 seconds', 'See concrete product proof and capabilities', 'Compare pricing clearly', 'Sign up, book a demo, or start a trial'],
		requiredPages: ['Landing / Homepage', 'Features / Product Tour', 'Pricing (Monthly/Annual toggle)', 'About / Customer Stories', 'Contact / Demo Request'],
		coreComponents: ['Sticky glass/crisp navbar with CTA', 'High-impact hero with interactive product preview', 'Logo trust strip', 'Bento feature grid', 'Interactive pricing cards (monthly/yearly toggle)', 'Customer testimonials', 'FAQ accordion', 'Conversion footer'],
		interactiveFunctionality: ['Monthly/annual pricing calculator toggle', 'Interactive feature tabs or live preview switcher', 'FAQ accordion', 'Validated demo/waitlist signup form with confirmation', 'Responsive mobile navigation drawer'],
		userJourneys: [
			{ name: 'Evaluate & Start Trial', actor: 'Prospect', steps: ['Read hero value prop & product preview', 'Explore bento capabilities', 'Toggle monthly/annual pricing', 'Submit trial or demo form'], conversionOrOutcome: 'Qualified lead or trial signup' },
		],
		assetNeeds: [
			{ slot: 'hero-visual', purpose: 'Atmospheric brand/product environment visual', subjectQuery: 'minimalist modern workspace technology architecture clean light', style: 'crisp editorial studio', aspectRatio: '16:9', orientation: 'landscape', altTextTemplate: 'Product showcase visual', priority: 'recommended' },
		],
		brandPersonality: ['confident', 'modern', 'clear', 'credible'],
	},
	{
		category: 'restaurant_website',
		domain: 'website',
		label: 'Restaurant & Culinary Website',
		industry: 'Hospitality & Dining',
		keywords: ['restaurant', 'cafe', 'coffee', 'bakery', 'bistro', 'bar', 'menu', 'dining', 'culinary', 'chef', 'food', 'pizza', 'sushi'],
		defaultDirections: ['elegant-hospitality', 'luxury-editorial', 'immersive-storytelling'],
		defaultThemeMode: 'light',
		defaultPrimaryHex: '#9A3412',
		defaultHarmony: 'warm-editorial',
		targetUsers: ['Diners seeking reservations', 'Local food lovers', 'Private dining planners'],
		primaryGoals: ['Feel the restaurant ambiance immediately', 'Browse curated menus with dietary filters & prices', 'Book a table or order effortlessly', 'Find hours, location, and parking instantly'],
		requiredPages: ['Home / Atmosphere Hero', 'Interactive Menu (Starters, Mains, Drinks, Dietary tags)', 'Table Reservation Form', 'Chef Story & Gallery', 'Location, Hours & Private Dining'],
		coreComponents: ['Full-bleed culinary hero with Reserve CTA', 'Category-tabbed menu with dietary filters (V, VG, GF)', 'Interactive reservation widget (date, party size, time slot)', 'Editorial photography gallery', 'Hours & location card'],
		interactiveFunctionality: ['Menu category tabs & dietary filter toggles', 'Interactive reservation availability picker & validated booking confirmation', 'Lightbox photo gallery'],
		userJourneys: [
			{ name: 'Browse Menu & Reserve Table', actor: 'Diner', steps: ['View hero & ambiance', 'Filter menu for dietary needs', 'Pick date, party size, and time slot', 'Confirm reservation'], conversionOrOutcome: 'Confirmed dining reservation' },
		],
		assetNeeds: [
			{ slot: 'hero-dish', purpose: 'Full-bleed hero dining / signature dish photograph', subjectQuery: 'fine dining restaurant signature dish warm lighting photography', style: 'warm moody culinary photography', aspectRatio: '16:9', orientation: 'landscape', altTextTemplate: 'Signature culinary dish on warm table setting', priority: 'essential' },
			{ slot: 'menu-dishes', purpose: 'Artisan food & beverage photography', subjectQuery: 'artisan plated gourmet food overhead warm natural light', style: 'editorial culinary photography', aspectRatio: '4:3', orientation: 'landscape', altTextTemplate: 'Freshly prepared menu dish', priority: 'essential' },
			{ slot: 'interior-ambiance', purpose: 'Dining room interior atmosphere', subjectQuery: 'warm modern restaurant interior evening lighting tables', style: 'architectural hospitality photography', aspectRatio: '4:3', orientation: 'landscape', altTextTemplate: 'Restaurant dining room interior', priority: 'recommended' },
		],
		brandPersonality: ['warm', 'inviting', 'artisanal', 'memorable'],
	},
	{
		category: 'travel_hospitality_website',
		domain: 'website',
		label: 'Travel, Hotel & Booking Website',
		industry: 'Travel & Hospitality',
		keywords: ['travel', 'hotel', 'resort', 'booking', 'vacation', 'flight', 'destination', 'tour', 'hospitality', 'airbnb', 'villa'],
		defaultDirections: ['elegant-hospitality', 'immersive-storytelling', 'light-premium'],
		defaultThemeMode: 'light',
		defaultPrimaryHex: '#0F766E',
		defaultHarmony: 'analogous',
		targetUsers: ['Leisure travelers', 'Business travelers', 'Experience seekers'],
		primaryGoals: ['Be inspired by destinations/stays', 'Search availability by dates, guests, and budget', 'Compare stays/itineraries and book confidently'],
		requiredPages: ['Destination Hero & Search', 'Stays / Experiences Listing with Filters', 'Property / Itinerary Detail & Gallery', 'Booking & Guest Checkout'],
		coreComponents: ['Full-bleed destination hero with search bar', 'Destination & property cards with pricing/ratings', 'Date/guest/price filters', 'Photo gallery', 'Interactive booking summary calculator'],
		interactiveFunctionality: ['Destination, date, guest, and price filtering', 'Live nightly price & tax calculation', 'Validated booking confirmation', 'Saved/favorited stays'],
		userJourneys: [
			{ name: 'Search to Booking', actor: 'Traveler', steps: ['Enter destination & dates', 'Filter by price & amenities', 'Inspect room photos & reviews', 'Calculate total and confirm booking'], conversionOrOutcome: 'Confirmed reservation itinerary' },
		],
		assetNeeds: [
			{ slot: 'destination-hero', purpose: 'Breathtaking destination or boutique resort hero', subjectQuery: 'luxury coastal boutique hotel architecture golden hour sea view', style: 'editorial travel photography', aspectRatio: '16:9', orientation: 'landscape', altTextTemplate: 'Scenic travel destination view', priority: 'essential' },
			{ slot: 'property-cards', purpose: 'Inviting interior & destination photography', subjectQuery: 'minimalist luxury hotel suite sunlit architectural interior', style: 'bright hospitality photography', aspectRatio: '4:3', orientation: 'landscape', altTextTemplate: 'Curated stay interior', priority: 'essential' },
		],
		brandPersonality: ['inspiring', 'serene', 'refined', 'effortless'],
	},
	{
		category: 'real_estate_website',
		domain: 'website',
		label: 'Real Estate & Property Platform',
		industry: 'Real Estate & Architecture',
		keywords: ['real estate', 'property', 'homes', 'apartments', 'mortgage', 'realtor', 'architecture', 'listings', 'rent', 'buy house'],
		defaultDirections: ['luxury-editorial', 'light-premium', 'premium-minimalism'],
		defaultThemeMode: 'light',
		defaultPrimaryHex: '#1E3A5F',
		defaultHarmony: 'warm-editorial',
		targetUsers: ['Home buyers', 'Renters', 'Investors', 'Agents'],
		primaryGoals: ['Search properties by location, price, beds/baths', 'Inspect architectural photos & floorplans', 'Estimate monthly payments & schedule tours'],
		requiredPages: ['Featured Properties & Search', 'Listings Grid + Map/Filter View', 'Property Detail & Mortgage Calculator', 'Schedule Viewing Form'],
		coreComponents: ['Property search bar', 'Architectural listing cards (price, beds, baths, sqft)', 'Faceted filters', 'Property photo gallery', 'Interactive mortgage estimator', 'Tour booking drawer'],
		interactiveFunctionality: ['Filter by Buy/Rent, price range, beds, location', 'Sort by price/newest', 'Live mortgage monthly payment calculator', 'Save favorite listings & request viewing'],
		userJourneys: [
			{ name: 'Filter & Book Tour', actor: 'Buyer', steps: ['Filter neighborhood and price', 'Inspect gallery and specs', 'Calculate estimated monthly payment', 'Submit tour request'], conversionOrOutcome: 'Scheduled property viewing' },
		],
		assetNeeds: [
			{ slot: 'architecture-hero', purpose: 'Architectural residence hero image', subjectQuery: 'modern minimalist luxury house architecture twilight warm interior light', style: 'architectural digest photography', aspectRatio: '16:9', orientation: 'landscape', altTextTemplate: 'Modern residential architecture exterior', priority: 'essential' },
			{ slot: 'interior-listings', purpose: 'Bright contemporary living room & kitchen interiors', subjectQuery: 'modern luxury apartment living room natural daylight minimalist interior', style: 'architectural interior photography', aspectRatio: '4:3', orientation: 'landscape', altTextTemplate: 'Property living room interior', priority: 'essential' },
		],
		brandPersonality: ['architectural', 'trustworthy', 'aspirational', 'clear'],
	},
	{
		category: 'healthcare_website',
		domain: 'website',
		label: 'Healthcare & Medical Platform',
		industry: 'Healthcare & Life Sciences',
		keywords: ['health', 'healthcare', 'medical', 'clinic', 'hospital', 'doctor', 'telehealth', 'patient', 'therapy', 'dental', 'pharmacy', 'wellness'],
		defaultDirections: ['soft-minimalism', 'light-premium', 'apple-restraint'],
		defaultThemeMode: 'light',
		defaultPrimaryHex: '#0D6E6E',
		defaultHarmony: 'analogous',
		targetUsers: ['Patients & caregivers', 'Clinicians', 'Care coordinators'],
		primaryGoals: ['Find trusted care and specialists effortlessly', 'Book appointments without anxiety or confusion', 'Access clear, WCAG-accessible health information'],
		requiredPages: ['Care Overview & Quick Appointment', 'Specialties & Providers Directory', 'Appointment Booking Flow', 'Patient Resources & FAQ', 'Contact & Emergency Info'],
		coreComponents: ['Calm accessible hero', 'Provider profile cards with credentials & availability', 'Specialty/location filter', 'Step-by-step appointment scheduler', 'High-contrast accessible forms', 'Trust/accreditation indicators'],
		interactiveFunctionality: ['Filter doctors by specialty & availability', 'Interactive appointment slot booking & confirmation', 'Accessible FAQ & symptom/service search'],
		userJourneys: [
			{ name: 'Find Doctor & Book Visit', actor: 'Patient', steps: ['Select specialty', 'Compare doctor profiles & next available slot', 'Book appointment with clear confirmation'], conversionOrOutcome: 'Confirmed care appointment' },
		],
		assetNeeds: [
			{ slot: 'clinic-hero', purpose: 'Calm, bright, trustworthy healthcare visual', subjectQuery: 'bright calm modern medical clinic interior warm natural light', style: 'clean reassuring photography', aspectRatio: '16:9', orientation: 'landscape', altTextTemplate: 'Modern welcoming healthcare environment', priority: 'essential' },
			{ slot: 'provider-portraits', purpose: 'Warm professional clinician portraits', subjectQuery: 'friendly medical doctor portrait bright natural clinical lighting', style: 'approachable editorial portrait', aspectRatio: '1:1', orientation: 'square', altTextTemplate: 'Healthcare specialist portrait', priority: 'recommended' },
		],
		brandPersonality: ['calm', 'trustworthy', 'empathetic', 'accessible'],
	},
	{
		category: 'educational_website',
		domain: 'website',
		label: 'Education & Learning Platform',
		industry: 'Education & EdTech',
		keywords: ['education', 'learning', 'course', 'academy', 'school', 'university', 'lms', 'tutorial', 'study', 'quiz', 'bootcamp', 'training'],
		defaultDirections: ['soft-minimalism', 'light-premium', 'high-end-saas'],
		defaultThemeMode: 'both',
		defaultPrimaryHex: '#1D4ED8',
		defaultHarmony: 'split-complementary',
		targetUsers: ['Students & self-learners', 'Instructors', 'Academic administrators'],
		primaryGoals: ['Discover structured learning paths', 'Track progress and milestones clearly', 'Read/watch lessons without distraction'],
		requiredPages: ['Course Catalog & Learning Paths', 'Course Detail & Syllabus', 'Interactive Lesson / Learning Player', 'Student Progress Dashboard'],
		coreComponents: ['Course cards with level, duration & progress bar', 'Topic/level filter bar', 'Interactive syllabus accordion', 'Lesson viewer with completion checklist & quiz', 'Progress stats'],
		interactiveFunctionality: ['Filter/search courses by topic & difficulty', 'Enroll & track lesson completion persisted in state', 'Interactive knowledge check quiz with instant feedback'],
		userJourneys: [
			{ name: 'Discover & Complete Lesson', actor: 'Learner', steps: ['Filter course catalog', 'Inspect syllabus', 'Open lesson & mark complete', 'Verify progress bar update'], conversionOrOutcome: 'Measurable learning milestone' },
		],
		assetNeeds: [
			{ slot: 'learning-hero', purpose: 'Engaging mature educational photography', subjectQuery: 'modern university library study desk notebook warm daylight', style: 'clean editorial photography', aspectRatio: '16:9', orientation: 'landscape', altTextTemplate: 'Focused modern learning environment', priority: 'recommended' },
		],
		brandPersonality: ['clear', 'encouraging', 'structured', 'mature'],
	},
	{
		category: 'portfolio_website',
		domain: 'website',
		label: 'Agency / Portfolio / Personal Brand Website',
		industry: 'Creative, Design & Consulting',
		keywords: ['portfolio', 'agency', 'studio', 'personal brand', 'designer', 'photographer', 'architect', 'freelance', 'creative', 'resume', 'cv'],
		defaultDirections: ['high-contrast-editorial', 'swiss-editorial', 'experimental-creative', 'premium-minimalism'],
		defaultThemeMode: 'both',
		defaultPrimaryHex: '#111827',
		defaultHarmony: 'monochromatic',
		targetUsers: ['Potential clients', 'Hiring managers & founders', 'Collaborators'],
		primaryGoals: ['Establish craft authority within seconds', 'Showcase selected case studies with visual impact', 'Make inquiry/contact effortless'],
		requiredPages: ['Hero & Selected Work', 'Case Study Detail', 'About / Capabilities & Experience', 'Contact / Project Inquiry'],
		coreComponents: ['Sculptural typographic hero', 'Asymmetric case-study gallery with category filter', 'Case study detail view/modal', 'Capabilities & client list', 'Project inquiry form'],
		interactiveFunctionality: ['Filter work by discipline', 'Open full case study breakdowns', 'Validated project inquiry submission', 'Smooth section navigation'],
		userJourneys: [
			{ name: 'Review Craft & Inquire', actor: 'Client', steps: ['Scan hero positioning', 'Filter & inspect case study', 'Submit project inquiry'], conversionOrOutcome: 'High-intent project lead' },
		],
		assetNeeds: [
			{ slot: 'case-study-covers', purpose: 'Art-directed project showcase visuals', subjectQuery: 'minimalist architectural design object studio lighting composition', style: 'gallery art direction', aspectRatio: '16:10', orientation: 'landscape', altTextTemplate: 'Featured design case study showcase', priority: 'essential' },
		],
		brandPersonality: ['distinctive', 'crafted', 'intentional', 'memorable'],
	},
	{
		category: 'news_media_website',
		domain: 'website',
		label: 'News, Blog & Publishing Platform',
		industry: 'Media & Digital Publishing',
		keywords: ['news', 'media', 'magazine', 'blog', 'journal', 'editorial', 'newsletter', 'article', 'publishing', 'podcast'],
		defaultDirections: ['editorial-magazine', 'swiss-editorial', 'light-premium'],
		defaultThemeMode: 'both',
		defaultPrimaryHex: '#18181B',
		defaultHarmony: 'warm-editorial',
		targetUsers: ['Readers', 'Subscribers', 'Editors & writers'],
		primaryGoals: ['Scan breaking & featured stories effortlessly', 'Enjoy distraction-free long-form reading', 'Subscribe, bookmark, and filter by topic'],
		requiredPages: ['Front Page / Curated Feed', 'Topic / Category Archive', 'Article Reader View', 'Search & Bookmarks', 'Newsletter Subscription'],
		coreComponents: ['Masthead navigation', 'Lead feature story layout', 'Editorial article cards with kicker & read time', 'Comfortable 65ch reading layout', 'Bookmark/save toggle', 'Newsletter signup'],
		interactiveFunctionality: ['Topic filtering & live article search', 'Full article reader view', 'Bookmark saving', 'Reading font-size / theme toggle', 'Newsletter signup validation'],
		userJourneys: [
			{ name: 'Discover & Read Article', actor: 'Reader', steps: ['Scan lead story', 'Filter by topic', 'Read article comfortably', 'Bookmark or subscribe'], conversionOrOutcome: 'Engaged returning reader' },
		],
		assetNeeds: [
			{ slot: 'lead-story', purpose: 'Strong editorial lead photograph', subjectQuery: 'modern city architecture street photography golden hour editorial', style: 'photojournalistic editorial', aspectRatio: '16:9', orientation: 'landscape', altTextTemplate: 'Lead feature article photograph', priority: 'essential' },
		],
		brandPersonality: ['authoritative', 'articulate', 'curated', 'readable'],
	},
	{
		category: 'documentation_website',
		domain: 'website',
		label: 'Documentation & Developer Portal',
		industry: 'Developer Experience',
		keywords: ['docs', 'documentation', 'api docs', 'reference', 'wiki', 'knowledge base', 'developer portal', 'sdk', 'guide'],
		defaultDirections: ['swiss-editorial', 'light-premium', 'dark-premium'],
		defaultThemeMode: 'both',
		defaultPrimaryHex: '#2563EB',
		defaultHarmony: 'cool-technical',
		targetUsers: ['Software engineers', 'Integrators', 'Technical writers'],
		primaryGoals: ['Find exact answers via instant search', 'Copy working code snippets immediately', 'Navigate hierarchical guides & API references clearly'],
		requiredPages: ['Docs Home / Quickstart', 'Guide / Reference Page (3-column: Nav, Prose, On-this-page TOC)', 'API Reference Explorer', 'Changelog'],
		coreComponents: ['Instant search (`Ctrl+K`)', 'Collapsible sidebar tree', 'Code blocks with copy button & language tabs', 'Callout alerts', 'Right-side sticky table of contents', 'Prev/Next pagination'],
		interactiveFunctionality: ['Instant full-text docs search', 'One-click code copy with confirmation', 'Language/SDK tab switcher', 'Light/Dark theme toggle'],
		userJourneys: [
			{ name: 'Search & Copy Snippet', actor: 'Developer', steps: ['Search topic', 'Switch SDK language tab', 'Copy verified code snippet'], conversionOrOutcome: 'Fast developer integration' },
		],
		assetNeeds: [],
		brandPersonality: ['clear', 'technical', 'fast', 'structured'],
	},
	// --- MOBILE APPS ---
	{
		category: 'mobile_lifestyle_app',
		domain: 'mobile_app',
		label: 'Mobile Application (iOS / Android / Cross-Platform)',
		industry: 'Mobile Consumer & Utility',
		keywords: ['mobile app', 'ios', 'android', 'react native', 'flutter', 'fitness app', 'delivery app', 'social app', 'messaging app', 'habit tracker', 'workout'],
		defaultDirections: ['apple-restraint', 'material-inspired', 'soft-minimalism'],
		defaultThemeMode: 'both',
		defaultPrimaryHex: '#2563EB',
		defaultHarmony: 'analogous',
		targetUsers: ['On-the-go mobile users', 'Daily habitual users'],
		primaryGoals: ['Reach core actions with one thumb', 'See immediate personal status and progress', 'Move smoothly between tabs without clutter'],
		requiredPages: ['Home / Feed / Today View', 'Explore / Search', 'Primary Action / Detail Sheet', 'Activity / Progress', 'Profile & Settings'],
		coreComponents: ['Bottom tab navigation (4–5 destinations)', 'Touch-friendly >=44px controls', 'Compact mobile cards', 'Bottom sheets / drawers', 'Pull-to-refresh / skeleton states', 'Safe-area inset padding'],
		interactiveFunctionality: ['Bottom tab routing', 'Interactive bottom sheets', 'Live filtering/logging/check-ins', 'Persistent user state'],
		userJourneys: [
			{ name: 'One-Thumb Daily Action', actor: 'Mobile User', steps: ['Open Today view', 'Tap primary action button', 'Complete quick sheet interaction', 'See instant feedback & updated streak/list'], conversionOrOutcome: 'Effortless mobile habit loop' },
		],
		assetNeeds: [
			{ slot: 'mobile-featured', purpose: 'Clean high-contrast mobile card imagery', subjectQuery: 'minimalist lifestyle wellness morning sunlight clean composition', style: 'vibrant natural mobile photography', aspectRatio: '4:3', orientation: 'landscape', altTextTemplate: 'Featured mobile experience card image', priority: 'recommended' },
		],
		brandPersonality: ['effortless', 'tactile', 'personal', 'responsive'],
	},
	// --- DESKTOP APPS ---
	{
		category: 'desktop_productivity',
		domain: 'desktop_app',
		label: 'Desktop Application & Tooling',
		industry: 'Desktop Software & Creative/Dev Tools',
		keywords: ['desktop app', 'electron', 'tauri', 'code editor', 'ide', 'creative tool', 'media player', 'notes app', 'workspace tool', 'utility'],
		defaultDirections: ['dark-premium', 'fluent-inspired', 'apple-restraint'],
		defaultThemeMode: 'dark',
		defaultPrimaryHex: '#3B82F6',
		defaultHarmony: 'cool-technical',
		targetUsers: ['Power users', 'Creators', 'Developers', 'Operators'],
		primaryGoals: ['Operate keyboard-first with high information density', 'Inspect and edit workspaces cleanly', 'Customize panes and preferences reliably'],
		requiredPages: ['Multi-Pane Workbench Shell', 'Inspector / Properties Panel', 'Command Palette (`Ctrl+K`)', 'Settings & Shortcuts'],
		coreComponents: ['Activity rail / collapsible sidebar', 'Resizable split panes', 'Command palette', 'Toolbar & status bar', 'Context menus', 'Keyboard shortcut hints'],
		interactiveFunctionality: ['Split-pane switching & filtering', 'Command palette search & action dispatch', 'Real-time editing & persisted workspace state'],
		userJourneys: [
			{ name: 'Keyboard-Driven Task', actor: 'Power User', steps: ['Open command palette', 'Switch view or filter items', 'Edit in main pane with live inspector feedback'], conversionOrOutcome: 'High-velocity desktop workflow' },
		],
		assetNeeds: [],
		brandPersonality: ['focused', 'fast', 'precision-crafted', 'calm'],
	},
	// --- GAMES & INTERACTIVE EXPERIENCES ---
	{
		category: 'browser_game',
		domain: 'game',
		label: 'Game & Interactive Experience',
		industry: 'Gaming & Interactive Entertainment',
		keywords: ['game', 'rpg', 'puzzle', 'strategy', 'simulation', 'arcade', 'multiplayer', 'hud', 'game launcher', 'game store', 'inventory', 'leaderboard', 'canvas'],
		defaultDirections: ['gaming-immersive', 'dark-premium', 'futuristic-tech'],
		defaultThemeMode: 'dark',
		defaultPrimaryHex: '#F59E0B',
		defaultHarmony: 'split-complementary',
		targetUsers: ['Players (desktop & touch/mobile)', 'Competitive & casual gamers'],
		primaryGoals: ['Jump into play or core loop immediately', 'Read HUD stats (score, health, resources, objectives) at a glance', 'Enjoy tactile, responsive controls and clear progression'],
		requiredPages: ['Title / Launch Menu', 'Active Gameplay Stage + HUD', 'Inventory / Loadout / Upgrades Modal', 'Pause / Settings (Audio, Controls, Reduced Motion)', 'Victory / Game Over & Score Summary'],
		coreComponents: ['Atmospheric title screen', 'Unobtrusive high-contrast HUD bar', 'Interactive game board / canvas stage', 'Inventory/upgrade cards with rarity states', 'Pause & settings overlay', 'Responsive keyboard + touch controls'],
		interactiveFunctionality: ['Real playable game loop / state machine', 'Keyboard and pointer/touch input handling', 'Score/progress/high-score persistence', 'Pause, restart, and difficulty/settings controls'],
		userJourneys: [
			{ name: 'Launch, Play & Progress', actor: 'Player', steps: ['Start game from polished title screen', 'Play core loop with live HUD feedback', 'Open upgrade/pause overlay', 'Complete round and see score summary + replay'], conversionOrOutcome: 'Responsive, engaging playable experience' },
		],
		assetNeeds: [
			{ slot: 'game-backdrop', purpose: 'Atmospheric art-directed game world backdrop or custom SVG scene', subjectQuery: 'dramatic atmospheric night mountain nebula digital landscape', style: 'cinematic concept art', aspectRatio: '16:9', orientation: 'landscape', altTextTemplate: 'Game world atmospheric backdrop', priority: 'recommended' },
		],
		brandPersonality: ['immersive', 'kinetic', 'bold', 'responsive'],
	},
	// --- SPECIALIZED INTERFACES ---
	{
		category: 'iot_dashboard',
		domain: 'specialized',
		label: 'Specialized Interface (IoT / Geospatial / Industrial / Scientific)',
		industry: 'Specialized Engineering & Smart Systems',
		keywords: ['iot', 'smart home', 'map', 'geospatial', 'gis', 'scientific', 'automotive', 'industrial', 'scada', 'kiosk', 'tv app', 'wearable', 'ar', 'vr', 'spatial', 'control panel'],
		defaultDirections: ['futuristic-tech', 'modern-dashboard', 'dark-premium'],
		defaultThemeMode: 'dark',
		defaultPrimaryHex: '#0EA5E9',
		defaultHarmony: 'cool-technical',
		targetUsers: ['System operators', 'Field engineers', 'Researchers', 'Smart-device owners'],
		primaryGoals: ['Monitor live telemetry & alerts unambiguously', 'Control physical or spatial systems safely', 'Maintain zero-error readability in target viewing conditions'],
		requiredPages: ['Live System / Spatial Overview', 'Device / Node Detail & Controls', 'Alerts & Diagnostics Log', 'Configuration & Safety Thresholds'],
		coreComponents: ['Live status telemetry cards', 'Interactive device toggles/sliders with confirmation', 'Alert severity banner', 'Map/spatial/schematic viewport', 'Threshold gauges & sparklines'],
		interactiveFunctionality: ['Live device control state updates', 'Alert acknowledgment & filtering', 'Real-time simulated or connected telemetry stream', 'Safe-mode / confirmation guards for critical controls'],
		userJourneys: [
			{ name: 'Monitor & Adjust Control', actor: 'Operator', steps: ['Inspect live telemetry status', 'Select flagged device/zone', 'Adjust parameter with safety confirmation', 'Verify updated state'], conversionOrOutcome: 'Safe, deterministic operational control' },
		],
		assetNeeds: [],
		brandPersonality: ['precise', 'reliable', 'high-contrast', 'engineered'],
	},
];

export function matchProductBlueprint(description: string, explicitCategory?: string): { blueprint: ProductBlueprint; confidence: number } {
	const raw = `${explicitCategory ?? ''} ${description}`.toLowerCase();
	if (explicitCategory) {
		const exact = PRODUCT_BLUEPRINTS.find(b => b.category === explicitCategory.toLowerCase());
		if (exact) {
			return { blueprint: exact, confidence: 0.98 };
		}
	}

	let best: ProductBlueprint = PRODUCT_BLUEPRINTS[6]; // saas_website neutral default
	let bestScore = 0;

	for (const bp of PRODUCT_BLUEPRINTS) {
		let score = 0;
		for (const kw of bp.keywords) {
			if (raw.includes(kw)) {
				// Multi-word matches carry stronger signal
				score += kw.includes(' ') ? 3.5 : 2;
			}
		}
		if (raw.includes(bp.category.replace(/_/g, ' '))) {
			score += 5;
		}
		if (score > bestScore) {
			bestScore = score;
			best = bp;
		}
	}

	const confidence = bestScore === 0 ? 0.55 : Math.min(0.98, 0.65 + bestScore * 0.06);
	return { blueprint: best, confidence: Math.round(confidence * 100) / 100 };
}

// ============================================================================
// 5. ICON LIBRARY REGISTRY
// ============================================================================

export interface IconLibraryMeta {
	readonly name: IconLibraryName;
	readonly packageNames: readonly string[];
	readonly defaultPackage: string;
	readonly defaultStrokeWidth: string;
	readonly bestFor: string;
}

export const ICON_LIBRARIES: readonly IconLibraryMeta[] = [
	{ name: 'lucide', packageNames: ['lucide-react', 'lucide-vue-next', 'lucide-svelte', 'lucide', 'lucide-angular'], defaultPackage: 'lucide-react', defaultStrokeWidth: '1.75', bestFor: 'Clean modern React/Vue/Svelte/SaaS/commerce apps' },
	{ name: 'heroicons', packageNames: ['@heroicons/react', '@heroicons/vue', 'heroicons'], defaultPackage: '@heroicons/react', defaultStrokeWidth: '1.5', bestFor: 'Tailwind CSS ecosystems needing crisp outline & solid variants' },
	{ name: 'phosphor', packageNames: ['@phosphor-icons/react', '@phosphor-icons/vue', 'phosphor-react', '@phosphor-icons/web'], defaultPackage: '@phosphor-icons/react', defaultStrokeWidth: '1.5', bestFor: 'Editorial, luxury, and expressive apps needing thin/light/duotone weights' },
	{ name: 'tabler', packageNames: ['@tabler/icons-react', '@tabler/icons-vue', '@tabler/icons-svelte', '@tabler/icons'], defaultPackage: '@tabler/icons-react', defaultStrokeWidth: '1.75', bestFor: 'Data-heavy dashboards and enterprise apps needing 5,000+ technical icons' },
	{ name: 'material-symbols', packageNames: ['@mui/icons-material', 'material-symbols'], defaultPackage: 'material-symbols', defaultStrokeWidth: '1.5', bestFor: 'Material-inspired, Android, and Google-style utility apps' },
	{ name: 'react-icons', packageNames: ['react-icons'], defaultPackage: 'react-icons', defaultStrokeWidth: '1.75', bestFor: 'Projects already bundling react-icons' },
	{ name: 'fontawesome', packageNames: ['@fortawesome/react-fontawesome', '@fortawesome/fontawesome-free'], defaultPackage: '@fortawesome/fontawesome-free', defaultStrokeWidth: 'solid/regular', bestFor: 'Legacy or enterprise apps already standardizing on Font Awesome' },
];

// ============================================================================
// 6. PERMANENT SEARCHABLE DESIGN KNOWLEDGE LIBRARY
// ============================================================================

export const DESIGN_KNOWLEDGE_ENTRIES: readonly DesignKnowledgeEntry[] = [
	{
		id: 'principle-hierarchy-restraint',
		topic: 'principle',
		title: 'Visual Hierarchy & Purposeful Restraint',
		summary: 'Every viewport needs one unmistakable focal point, clear secondary paths, and calm supporting structure.',
		guidance: [
			'Avoid making every card, badge, and button loud — reserve the primary accent color for primary actions and active states.',
			'Use a 60-30-10 tonal balance: 60% calm background/surface, 30% structural neutrals/typography, 10% brand/semantic accents.',
			'Never add glassmorphism, neon glows, or floating animations unless they serve spatial clarity and brand fit.',
		],
		tags: ['hierarchy', 'restraint', 'composition', 'visual-weight'],
	},
	{
		id: 'principle-spacing-rhythm',
		topic: 'principle',
		title: '4px/8px Spatial Grid & Grouping Proximity',
		summary: 'Consistent spacing rhythm creates immediate perceived professionalism.',
		guidance: [
			'Base all spacing on a 4px grid (4, 8, 12, 16, 20, 24, 32, 48, 64, 96px).',
			'Internal card padding must be strictly smaller than the gap between sibling sections (Law of Proximity).',
			'Give desktop sections 64–112px vertical rhythm and mobile sections 40–64px.',
		],
		tags: ['spacing', 'grid', 'proximity', 'rhythm'],
	},
	{
		id: 'responsive-mobile-first',
		topic: 'responsive',
		title: 'Deliberate Mobile Transformation (Not Shrunk Desktop)',
		summary: 'Mobile interfaces must reorganize navigation, grids, tables, and touch targets deliberately.',
		guidance: [
			'Never allow horizontal overflow (`scrollWidth <= clientWidth`) at 320px, 375px, 768px, 1024px, or 1440px.',
			'Ensure every interactive touch target is at least 44x44px on touch viewports with >=8px separation.',
			'Convert multi-column tables on mobile into stacked summary cards or purposefully scrollable containers with sticky key column.',
			'Use `clamp()` fluid typography, CSS Grid `repeat(auto-fit, minmax(min(100%, 280px), 1fr))`, and Container Queries for reusable widgets.',
			'Respect `env(safe-area-inset-bottom)` on sticky mobile bars and bottom navigation.',
		],
		tags: ['responsive', 'mobile', 'touch-targets', 'container-queries', 'overflow'],
	},
	{
		id: 'a11y-wcag-core',
		topic: 'accessibility',
		title: 'WCAG 2.1 AA/AAA Accessibility Engineering',
		summary: 'Accessibility is structural engineering built into semantics, contrast, focus, and motion from the start.',
		guidance: [
			'Maintain >=4.5:1 contrast for normal text and >=3:1 for large text (>=18pt or >=14pt bold) and UI components.',
			'Always provide visible `:focus-visible` focus rings (never `outline: none` without a clear replacement).',
			'Use semantic landmarks (`<header>`, `<nav>`, `<main>`, `<footer>`), one `<h1>` per page, and logical heading order.',
			'Associate every form input with a `<label for>` or `aria-label`, and announce validation errors accessibly.',
			'Every meaningful `<img>` needs descriptive `alt` text; purely decorative graphics use `alt=""` and `aria-hidden="true"`.',
			'Respect `@media (prefers-reduced-motion: reduce)` by disabling non-essential motion.',
		],
		tags: ['accessibility', 'wcag', 'contrast', 'keyboard', 'aria', 'reduced-motion'],
	},
	{
		id: 'component-cards-buttons',
		topic: 'component',
		title: 'Polished Cards, Buttons & Complete Interactive States',
		summary: 'Production components cover default, hover, focus-visible, active, disabled, loading, empty, and error states.',
		guidance: [
			'Cards: establish 3-level internal hierarchy (media/eyebrow → title → metadata/CTA), consistent aspect-ratio framing, and subtle hover polish.',
			'Buttons: maintain clear visual separation between Primary (solid high-contrast), Secondary (subtle tonal/outline), Ghost, and Destructive variants.',
			'Never leave dead buttons or nonfunctional search/filter controls — wire real client/server state or clearly document backend boundary.',
			'Provide purposeful skeleton loaders, helpful empty states with recovery CTAs, and inline error feedback.',
		],
		tags: ['cards', 'buttons', 'states', 'empty-state', 'skeleton'],
	},
	{
		id: 'imagery-real-assets',
		topic: 'imagery',
		title: 'Authentic Imagery, Aspect Ratios & Loading Hygiene',
		summary: 'Photography and illustrations must reinforce brand identity, load reliably, and never distort.',
		guidance: [
			'Discover and download verified assets locally (or use verified permissive-license URLs / bespoke SVGs) — never ship broken URLs or gray "placeholder" boxes.',
			'Always set explicit `aspect-ratio` and `object-fit: cover` (`object-position: center top` for portraits) to prevent Cumulative Layout Shift (CLS) and stretching.',
			'Use `loading="lazy"` on below-the-fold images and `fetchpriority="high"` on the hero LCP image.',
			'Place a subtle dark/light contrast scrim behind text overlaid on photography.',
		],
		tags: ['images', 'photography', 'aspect-ratio', 'cls', 'scrim'],
	},
	{
		id: 'icons-craft',
		topic: 'component',
		title: 'Vector Icon Discipline (Never Emoji Substitutes)',
		summary: 'Professional UIs use one coherent SVG icon library with uniform stroke weight and optical alignment.',
		guidance: [
			'Detect and reuse the project’s existing icon library before installing a new one.',
			'Use consistent stroke width (e.g. 1.5px–1.75px) and consistent sizing (16px inline, 20px buttons/nav, 24px feature highlights).',
			'Never substitute raw Unicode emojis (🚀, ⚙️, 🛒) for navigation, toolbar, or button icons.',
			'Icon-only buttons MUST include an `aria-label`.',
		],
		tags: ['icons', 'lucide', 'svg', 'alignment'],
	},
	{
		id: 'motion-purposeful',
		topic: 'motion',
		title: 'Refined, Performant Motion Design',
		summary: 'Motion guides spatial orientation and confirms user intent — it never slows interaction.',
		guidance: [
			'Animate GPU-composited properties (`transform`, `opacity`) instead of layout-triggering properties (`width`, `top`, `left`).',
			'Keep micro-interactions crisp (120–220ms) and modal/drawer entrances smooth (220–320ms cubic-bezier(0.16, 1, 0.3, 1)).',
			'Always wrap animations with `@media (prefers-reduced-motion: reduce)` fallbacks.',
		],
		tags: ['motion', 'animation', 'performance', 'reduced-motion'],
	},
	{
		id: 'anti-patterns-checklist',
		topic: 'anti-pattern',
		title: 'Design Anti-Patterns to Eliminate Automatically',
		summary: 'Common amateur UI flaws Kodia must detect and eliminate before finishing.',
		guidance: [
			'Generic purple-pink gradients slapped onto unrelated corporate/editorial products.',
			'Giant 40px+ rounded corners everywhere combined with muddy drop shadows.',
			'Emoji icons in navigation bars or feature lists.',
			'Broken images, stretched aspect ratios, or unstyled `lorem ipsum` text.',
			'Unreadable white text over bright hero photography without a contrast scrim.',
			'Dead search inputs, nonfunctional filter chips, or cart buttons that do nothing.',
			'Desktop-only fixed pixel widths causing horizontal scrolling on 375px phones.',
		],
		tags: ['anti-patterns', 'qa', 'critique', 'polish'],
	},
];

export function searchDesignKnowledge(query: string, topic?: DesignKnowledgeEntry['topic']): DesignKnowledgeEntry[] {
	const q = query.trim().toLowerCase();
	const words = q.split(/\s+/).filter(Boolean);
	return DESIGN_KNOWLEDGE_ENTRIES.filter(entry => {
		if (topic && entry.topic !== topic) { return false; }
		if (words.length === 0) { return true; }
		const haystack = `${entry.title} ${entry.summary} ${entry.tags.join(' ')} ${entry.guidance.join(' ')}`.toLowerCase();
		return words.some(w => haystack.includes(w));
	});
}
