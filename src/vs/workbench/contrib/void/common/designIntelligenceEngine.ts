/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import {
	AccessibilityTarget,
	AnimationPreference,
	BrandSystemProfile,
	BrowserVisualAuditResult,
	ColorHarmonyStrategy,
	ColorPaletteSpec,
	ComponentRecommendation,
	ComponentVariantSpec,
	DesignAuditFinding,
	DesignBrief,
	DesignConsistencyAuditReport,
	DesignCritiqueDimension,
	DesignCritiqueReport,
	DesignTokensSpec,
	ExistingDesignSystemReport,
	FrontendFramework,
	IconLibraryName,
	IconLibraryRecommendation,
	MultiViewportAuditResult,
	PageArchitectureSpec,
	PageBlueprint,
	ProductDesignAnalysis,
	ResponsiveLayoutSpec,
	StylingSystem,
	VisualDirectionId,
	VisualDirectionSpec,
	VisualRepairAction,
	VisualRepairPlan,
} from './designIntelligenceTypes.js';
import {
	buildThemeTokens,
	buildTypographyRecommendation,
	evaluatePaletteContrast,
	generateHarmonySeeds,
	ICON_LIBRARIES,
	matchProductBlueprint,
	normalizeHex,
	VISUAL_DIRECTIONS,
} from './designKnowledgeLibrary.js';

export interface WorkspaceFileSample {
	readonly path: string;
	readonly content: string;
}

// ============================================================================
// 1. AUTONOMOUS PRODUCT DESIGN ANALYSIS & BRIEF GENERATION
// ============================================================================

function inferProductName(description: string, explicitName?: string): string {
	if (explicitName && explicitName.trim()) {
		return explicitName.trim();
	}
	const quoted = /["']([A-Za-z0-9][A-Za-z0-9\s&.-]{1,36})["']/.exec(description);
	if (quoted) { return quoted[1].trim(); }
	const called = /(?:called|named|for)\s+([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+){0,2})/.exec(description);
	if (called && !/^(A|An|The|Modern|Premium|New|My|Our)\b/.test(called[1])) {
		return called[1].trim();
	}
	return 'Product Studio';
}

function inferDirectionsFromTone(
	description: string,
	defaults: readonly VisualDirectionId[],
	brandProfile?: BrandSystemProfile | null,
	preferredDirection?: VisualDirectionId | 'auto',
): VisualDirectionId[] {
	const d = description.toLowerCase();
	const picks: VisualDirectionId[] = [];
	const push = (id: VisualDirectionId) => {
		if (!picks.includes(id)) { picks.push(id); }
	};

	if (preferredDirection && preferredDirection !== 'auto' && preferredDirection in VISUAL_DIRECTIONS) {
		push(preferredDirection);
	}
	if (brandProfile?.preferredDirection && brandProfile.preferredDirection in VISUAL_DIRECTIONS) {
		push(brandProfile.preferredDirection);
	}
	if (/luxury|couture|atelier|high-end fashion|bespoke/.test(d)) { push('luxury-editorial'); }
	if (/fashion|apparel|clothing|boutique/.test(d)) { push('sophisticated-fashion'); }
	if (/minimal|clean|simple|restraint/.test(d)) { push('premium-minimalism'); }
	if (/brutalist|neo-brutal/.test(d)) { push(d.includes('neo') ? 'neo-brutalism' : 'modern-brutalism'); }
	if (/swiss|grid|typographic/.test(d)) { push('swiss-editorial'); }
	if (/glass|frosted|translucent/.test(d)) { push('glassmorphism'); }
	if (/dark mode|dark theme|obsidian|cyber|futuristic/.test(d)) { push('dark-premium'); }
	if (/enterprise|b2b|erp|crm|admin/.test(d)) { push('modern-enterprise'); }
	if (/dashboard|analytics|metrics|bi\b/.test(d)) { push('modern-dashboard'); }
	if (/bank|finance|fintech|wealth|accounting/.test(d)) { push('financial-authority'); }
	if (/restaurant|hotel|hospitality|cafe|travel/.test(d)) { push('elegant-hospitality'); }
	if (/game|rpg|hud|arcade|esports/.test(d)) { push('gaming-immersive'); }

	for (const def of defaults) { push(def); }
	return picks.slice(0, 4);
}

export function analyzeProductDesignRequirements(opts: {
	productDescription: string;
	productName?: string;
	productCategory?: string;
	targetDevices?: readonly string[];
	brandProfile?: BrandSystemProfile | null;
	preferredDirection?: VisualDirectionId | 'auto';
	accessibilityTarget?: AccessibilityTarget;
}): ProductDesignAnalysis {
	const { blueprint, confidence } = matchProductBlueprint(opts.productDescription, opts.productCategory);
	const productName = inferProductName(opts.productDescription, opts.productName ?? opts.brandProfile?.brandName);
	const directions = inferDirectionsFromTone(
		opts.productDescription,
		blueprint.defaultDirections,
		opts.brandProfile,
		opts.preferredDirection,
	);
	const a11yTarget = opts.accessibilityTarget ?? opts.brandProfile?.accessibilityTarget ?? 'WCAG_AA';
	const d = opts.productDescription.toLowerCase();

	let themeMode: 'light' | 'dark' | 'both' = opts.brandProfile?.themeMode ?? blueprint.defaultThemeMode;
	if (/\bdark mode\b|\bdark theme\b|\bdark ui\b/.test(d)) { themeMode = 'dark'; }
	else if (/\blight mode\b|\blight theme\b/.test(d)) { themeMode = 'light'; }
	else if (/\blight and dark\b|\btheme toggle\b/.test(d)) { themeMode = 'both'; }

	const targetDevices = opts.targetDevices && opts.targetDevices.length > 0
		? [...opts.targetDevices]
		: blueprint.domain === 'mobile_app'
			? ['Small mobile (360–390px)', 'Large mobile (414–430px)', 'Portrait tablet (768px)', 'Touch & safe-area insets']
			: blueprint.domain === 'desktop_app'
				? ['Small laptop (1280px)', 'Desktop monitor (1440px)', 'Large/ultrawide monitor (1920–2560px)', 'Tablet fallback (768px)']
				: ['Small mobile (375px)', 'Large mobile (430px)', 'Tablet portrait & landscape (768–1024px)', 'Laptop (1280px)', 'Desktop & ultrawide (1440–2560px)'];

	const informationArchitecture = [
		`Primary navigation exposing core destinations (${blueprint.requiredPages.slice(0, 5).join(', ')})`,
		'Clear visual hierarchy: primary viewport anchor → discovery/action zone → supporting proof/detail → utility footer',
		'Consistent state architecture: default, loading skeleton, empty state with recovery CTA, and inline error state',
	];

	return {
		productName,
		summary: `${blueprint.label} (${blueprint.industry}) designed for ${blueprint.targetUsers.slice(0, 2).join(' and ')} with a ${VISUAL_DIRECTIONS[directions[0]].name} direction.`,
		domain: blueprint.domain,
		category: blueprint.category,
		industry: opts.brandProfile?.industry || blueprint.industry,
		confidence,
		targetUsers: blueprint.targetUsers,
		primaryGoals: blueprint.primaryGoals,
		userJourneys: blueprint.userJourneys,
		informationArchitecture,
		requiredPages: blueprint.requiredPages,
		coreComponents: blueprint.coreComponents,
		interactiveFunctionality: blueprint.interactiveFunctionality,
		assetNeeds: blueprint.assetNeeds,
		targetDevices,
		accessibilityRequirements: [
			`Meet ${a11yTarget === 'WCAG_AAA' ? 'WCAG 2.1 AAA (>=7:1 body, >=4.5:1 large)' : 'WCAG 2.1 AA (>=4.5:1 body, >=3:1 large & UI)'} color contrast.`,
			'Full keyboard navigation with visible :focus-visible rings and logical tab order.',
			'Semantic landmarks (<header>, <nav>, <main>, <footer>), single <h1> per view, descriptive alt text, and labeled inputs.',
			'Minimum 44x44px touch targets on mobile viewports and @media (prefers-reduced-motion: reduce) compliance.',
		],
		performanceRequirements: [
			'Zero Cumulative Layout Shift (explicit aspect-ratio / width & height on all media).',
			'Fast First Contentful Paint with font-display: swap and lazy loading on below-the-fold images.',
			'GPU-composited animations only (transform, opacity); avoid unnecessary large runtime libraries.',
		],
		motionRequirements: [
			`Match ${VISUAL_DIRECTIONS[directions[0]].name} motion discipline: ${VISUAL_DIRECTIONS[directions[0]].motionCharacter}`,
			'Provide immediate feedback for interactive controls (hover, active, loading, success) without gimmicks.',
		],
		recommendedDirections: directions,
		recommendedThemeMode: themeMode,
		brandPersonality: blueprint.brandPersonality,
	};
}

export function generateVisualDirection(opts: {
	productDescription: string;
	productCategory?: string;
	requestedDirection?: VisualDirectionId | 'auto';
	brandProfile?: BrandSystemProfile | null;
}): VisualDirectionSpec {
	const analysis = analyzeProductDesignRequirements({
		productDescription: opts.productDescription,
		productCategory: opts.productCategory,
		brandProfile: opts.brandProfile,
		preferredDirection: opts.requestedDirection,
	});
	const id = (opts.requestedDirection && opts.requestedDirection !== 'auto' && opts.requestedDirection in VISUAL_DIRECTIONS)
		? opts.requestedDirection
		: analysis.recommendedDirections[0];
	return VISUAL_DIRECTIONS[id];
}

export function generateDesignBrief(opts: {
	productDescription: string;
	productName?: string;
	productCategory?: string;
	requestedDirection?: VisualDirectionId | 'auto';
	brandProfile?: BrandSystemProfile | null;
	accessibilityTarget?: AccessibilityTarget;
	animationPreference?: AnimationPreference;
}): DesignBrief {
	const analysis = analyzeProductDesignRequirements({
		productDescription: opts.productDescription,
		productName: opts.productName,
		productCategory: opts.productCategory,
		brandProfile: opts.brandProfile,
		preferredDirection: opts.requestedDirection,
		accessibilityTarget: opts.accessibilityTarget,
	});
	const direction = VISUAL_DIRECTIONS[analysis.recommendedDirections[0]];
	const motionNote = opts.animationPreference === 'reduced-motion'
		? 'Minimize motion to instant or subtle opacity fades; honor prefers-reduced-motion strictly.'
		: opts.animationPreference === 'minimal'
			? 'Restrict transitions to crisp 120–160ms state feedback (hover, focus, disclosure).'
			: direction.motionCharacter;

	const restrictions = opts.brandProfile?.restrictions ?? [];
	const avoidList = [
		...direction.visualTreatmentsToAvoid,
		'Emoji characters substituted for professional vector UI icons',
		'Broken image links, distorted aspect ratios, or unstyled placeholder boxes',
		'Dead buttons or non-functional search/filter/form controls',
		...restrictions,
	];

	return {
		id: `brief-${Date.now().toString(36)}`,
		createdAt: new Date().toISOString(),
		productName: analysis.productName,
		category: analysis.category,
		domain: analysis.domain,
		executiveSummary: `Design and engineer ${analysis.productName}, a production-grade ${analysis.summary} Every screen must feel intentionally art-directed, functionally complete, and effortlessly responsive from 375px phones to 2560px monitors.`,
		audienceAndContext: `Primary users: ${analysis.targetUsers.join(', ')}. Industry: ${analysis.industry}. Primary goals: ${analysis.primaryGoals.join('; ')}.`,
		creativeDirection: `${direction.name} — ${direction.rationale} Surface: ${direction.surfaceTreatment} Typography: ${direction.typographyCharacter}`,
		visualDirectionId: direction.id,
		layoutStrategy: `${direction.layoutPhilosophy} Required pages/views: ${analysis.requiredPages.join(', ')}.`,
		contentAndImageryDirection: analysis.assetNeeds.length > 0
			? `Proactively acquire and verify ${analysis.assetNeeds.length} real visual asset group(s): ${analysis.assetNeeds.map(a => `${a.slot} (${a.aspectRatio}, ${a.style})`).join('; ')}.${opts.brandProfile?.imageStyleNotes ? ` Brand imagery guidance: ${opts.brandProfile.imageStyleNotes}` : ''}`
			: 'Prioritize crisp typography, structured vector icons, custom data visualizations, and clean tonal surfaces without decorative filler photography.',
		interactionAndMotionDirection: motionNote,
		functionalIntegrityPlan: analysis.interactiveFunctionality,
		qualityBenchmarks: [
			...analysis.accessibilityRequirements.slice(0, 3),
			'Zero horizontal overflow across 375px, 768px, and 1440px rendered Chromium viewports.',
			'All images verified loaded (naturalWidth > 0) with clean aspect ratios and descriptive alt attributes.',
		],
		avoidList,
	};
}

// ============================================================================
// 2. COLOR PALETTE & COMPLETE DESIGN TOKENS GENERATION
// ============================================================================

export function generateColorPalette(opts: {
	productDescription?: string;
	productCategory?: string;
	visualDirection?: VisualDirectionId;
	harmony?: ColorHarmonyStrategy;
	brandPrimaryColor?: string;
	brandSecondaryColor?: string;
	brandAccentColor?: string;
	brandProfile?: BrandSystemProfile | null;
	accessibilityTarget?: AccessibilityTarget;
}): ColorPaletteSpec {
	const { blueprint } = matchProductBlueprint(opts.productDescription ?? '', opts.productCategory);
	const direction = opts.visualDirection ?? opts.brandProfile?.preferredDirection ?? blueprint.defaultDirections[0];
	const harmony = opts.harmony ?? blueprint.defaultHarmony;
	const primarySeed = normalizeHex(
		opts.brandPrimaryColor || opts.brandProfile?.primaryColor || blueprint.defaultPrimaryHex,
		blueprint.defaultPrimaryHex,
	);
	const baseSeeds = generateHarmonySeeds(primarySeed, harmony);
	const seeds = {
		primary: primarySeed,
		secondary: opts.brandSecondaryColor ? normalizeHex(opts.brandSecondaryColor, baseSeeds.secondary)
			: opts.brandProfile?.secondaryColor ? normalizeHex(opts.brandProfile.secondaryColor, baseSeeds.secondary)
				: baseSeeds.secondary,
		accent: opts.brandAccentColor ? normalizeHex(opts.brandAccentColor, baseSeeds.accent)
			: opts.brandProfile?.accentColor ? normalizeHex(opts.brandProfile.accentColor, baseSeeds.accent)
				: baseSeeds.accent,
		neutral: opts.brandProfile?.neutralBase ? normalizeHex(opts.brandProfile.neutralBase, baseSeeds.neutral) : baseSeeds.neutral,
	};

	const warmSurface = harmony === 'warm-editorial'
		|| direction === 'luxury-editorial'
		|| direction === 'sophisticated-fashion'
		|| direction === 'elegant-hospitality'
		|| direction === 'editorial-magazine'
		|| direction === 'soft-minimalism';

	const target = opts.accessibilityTarget ?? opts.brandProfile?.accessibilityTarget ?? 'WCAG_AA';
	const light = buildThemeTokens(seeds, 'light', target, warmSurface);
	const dark = buildThemeTokens(seeds, 'dark', target, warmSurface);
	const contrastChecks = evaluatePaletteContrast(light, dark);
	const defaultTheme: 'light' | 'dark' =
		direction === 'dark-premium' || direction === 'futuristic-tech' || direction === 'gaming-immersive'
			? 'dark'
			: blueprint.defaultThemeMode === 'dark' ? 'dark' : 'light';

	return {
		name: `${VISUAL_DIRECTIONS[direction].name} (${harmony})`,
		harmony,
		direction,
		defaultTheme,
		seedColors: seeds,
		light,
		dark,
		contrastChecks,
		allContrastChecksPassAA: contrastChecks.every(c => c.passesAA),
		usageGuidelines: [
			`60% canvas & surfaces (${defaultTheme === 'dark' ? dark.background : light.background} / ${defaultTheme === 'dark' ? dark.surface : light.surface}), 30% ink & borders, 10% primary/accent emphasis.`,
			'Use --color-primary exclusively for primary CTAs, active tabs, and focus rings; avoid coloring every card border with primary.',
			'Pair semantic status colors (--color-success, --color-warning, --color-error) with explicit text/icons so meaning never relies on color alone.',
		],
	};
}

function radiiForDirection(direction: VisualDirectionId): Record<string, string> {
	if (direction === 'luxury-editorial' || direction === 'sophisticated-fashion' || direction === 'modern-brutalism' || direction === 'swiss-editorial' || direction === 'high-contrast-editorial') {
		return { none: '0px', sm: '2px', md: '4px', lg: '6px', xl: '8px', full: '9999px' };
	}
	if (direction === 'glassmorphism' || direction === 'soft-minimalism' || direction === 'soft-neumorphism' || direction === 'apple-restraint' || direction === 'material-inspired') {
		return { none: '0px', sm: '8px', md: '12px', lg: '16px', xl: '24px', full: '9999px' };
	}
	return { none: '0px', sm: '4px', md: '8px', lg: '12px', xl: '16px', full: '9999px' };
}

export function generateDesignTokens(opts: {
	name?: string;
	productDescription?: string;
	productCategory?: string;
	visualDirection?: VisualDirectionId;
	harmony?: ColorHarmonyStrategy;
	brandPrimaryColor?: string;
	brandProfile?: BrandSystemProfile | null;
	accessibilityTarget?: AccessibilityTarget;
	animationPreference?: AnimationPreference;
}): DesignTokensSpec {
	const palette = generateColorPalette(opts);
	const direction = palette.direction;
	const typography = buildTypographyRecommendation(direction, {
		headingFont: opts.brandProfile?.headingFont,
		bodyFont: opts.brandProfile?.bodyFont,
		monoFont: opts.brandProfile?.monoFont,
	});
	const radii = radiiForDirection(direction);
	const spacing: Record<string, string> = {
		'0': '0px',
		'1': '0.25rem',
		'2': '0.5rem',
		'3': '0.75rem',
		'4': '1rem',
		'5': '1.25rem',
		'6': '1.5rem',
		'8': '2rem',
		'10': '2.5rem',
		'12': '3rem',
		'16': '4rem',
		'20': '5rem',
		'24': '6rem',
		'section-y': 'clamp(3rem, 7vw, 6.5rem)',
		'container-x': 'clamp(1rem, 4vw, 2.5rem)',
	};
	const breakpoints: Record<string, string> = {
		xs: '375px',
		sm: '640px',
		md: '768px',
		lg: '1024px',
		xl: '1280px',
		'2xl': '1536px',
	};
	const reduced = opts.animationPreference === 'reduced-motion';
	const motion = {
		durationFast: reduced ? '0ms' : '140ms',
		durationNormal: reduced ? '0ms' : '220ms',
		durationSlow: reduced ? '0ms' : '360ms',
		easingStandard: 'cubic-bezier(0.2, 0, 0, 1)',
		easingEmphasized: 'cubic-bezier(0.16, 1, 0.3, 1)',
		reducedMotionRule: '@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important; } }',
	};
	const zIndex: Record<string, number> = {
		base: 0,
		dropdown: 20,
		sticky: 30,
		drawer: 40,
		modal: 50,
		toast: 60,
	};

	const renderThemeVars = (t: typeof palette.light) => [
		`  --color-bg: ${t.background};`,
		`  --color-bg-subtle: ${t.backgroundSubtle};`,
		`  --color-surface: ${t.surface};`,
		`  --color-surface-elevated: ${t.surfaceElevated};`,
		`  --color-surface-hover: ${t.surfaceHover};`,
		`  --color-border: ${t.border};`,
		`  --color-border-strong: ${t.borderStrong};`,
		`  --color-text: ${t.text};`,
		`  --color-text-secondary: ${t.textSecondary};`,
		`  --color-text-muted: ${t.textMuted};`,
		`  --color-primary: ${t.primary};`,
		`  --color-primary-hover: ${t.primaryHover};`,
		`  --color-primary-fg: ${t.primaryForeground};`,
		`  --color-secondary: ${t.secondary};`,
		`  --color-secondary-fg: ${t.secondaryForeground};`,
		`  --color-accent: ${t.accent};`,
		`  --color-accent-fg: ${t.accentForeground};`,
		`  --color-focus-ring: ${t.focusRing};`,
		`  --color-success: ${t.success};`,
		`  --color-warning: ${t.warning};`,
		`  --color-error: ${t.error};`,
		`  --color-info: ${t.info};`,
		`  --gradient-hero: ${t.heroGradient};`,
		`  --shadow-sm: ${t.shadowSm};`,
		`  --shadow-md: ${t.shadowMd};`,
		`  --shadow-lg: ${t.shadowLg};`,
	].join('\n');

	const defaultTokens = palette.defaultTheme === 'dark' ? palette.dark : palette.light;
	const altSelector = palette.defaultTheme === 'dark' ? '[data-theme="light"], .light' : '[data-theme="dark"], .dark';
	const altTokens = palette.defaultTheme === 'dark' ? palette.light : palette.dark;

	const cssVariables = [
		`/* Kodia Design System Tokens — ${opts.name || palette.name} (${direction}) */`,
		`:root {`,
		renderThemeVars(defaultTokens),
		`  --font-display: ${typography.fontStacks.display};`,
		`  --font-body: ${typography.fontStacks.body};`,
		`  --font-mono: ${typography.fontStacks.mono};`,
		...typography.scale.map(s => `  ${s.token}: ${s.sizeClamp};`),
		...Object.entries(radii).map(([k, v]) => `  --radius-${k}: ${v};`),
		`  --space-section-y: ${spacing['section-y']};`,
		`  --space-container-x: ${spacing['container-x']};`,
		`  --duration-fast: ${motion.durationFast};`,
		`  --duration-normal: ${motion.durationNormal};`,
		`  --duration-slow: ${motion.durationSlow};`,
		`  --ease-standard: ${motion.easingStandard};`,
		`  --ease-emphasized: ${motion.easingEmphasized};`,
		`}`,
		``,
		`${altSelector} {`,
		renderThemeVars(altTokens),
		`}`,
		``,
		motion.reducedMotionRule,
	].join('\n');

	const tailwindExtendSnippet = JSON.stringify({
		theme: {
			extend: {
				colors: {
					bg: 'var(--color-bg)',
					surface: 'var(--color-surface)',
					border: 'var(--color-border)',
					text: 'var(--color-text)',
					muted: 'var(--color-text-muted)',
					primary: { DEFAULT: 'var(--color-primary)', foreground: 'var(--color-primary-fg)' },
					accent: { DEFAULT: 'var(--color-accent)', foreground: 'var(--color-accent-fg)' },
				},
				fontFamily: {
					display: ['var(--font-display)'],
					sans: ['var(--font-body)'],
					mono: ['var(--font-mono)'],
				},
				borderRadius: radii,
			},
		},
	}, null, 2);

	const w3cTokensJson = JSON.stringify({
		$schema: 'https://tr.designtokens.org/format/',
		name: opts.name || palette.name,
		direction,
		color: { light: palette.light, dark: palette.dark },
		typography: { fontStacks: typography.fontStacks, scale: typography.scale },
		spacing,
		borderRadius: radii,
		breakpoints,
		motion,
		zIndex,
	}, null, 2);

	return {
		name: opts.name || palette.name,
		visualDirection: direction,
		palette,
		typography,
		spacing,
		radii,
		breakpoints,
		motion,
		zIndex,
		cssVariables,
		tailwindExtendSnippet,
		w3cTokensJson,
	};
}

// ============================================================================
// 3. PAGE ARCHITECTURE & RESPONSIVE LAYOUT GENERATION
// ============================================================================

export function generatePageArchitecture(opts: {
	productDescription: string;
	productName?: string;
	productCategory?: string;
	brandProfile?: BrandSystemProfile | null;
}): PageArchitectureSpec {
	const analysis = analyzeProductDesignRequirements(opts);
	const pages: PageBlueprint[] = analysis.requiredPages.map((pageTitle, idx) => {
		const slug = idx === 0
			? '/'
			: '/' + pageTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 3).join('-');
		const isHome = idx === 0;
		const isAdmin = /admin|inventory|merchant/i.test(pageTitle);
		const sections = isHome
			? [
				{
					id: 'hero',
					name: 'Primary Hero & Value Anchor',
					purpose: `Immediately establish ${analysis.productName}'s identity, core promise, and primary user action above the fold.`,
					layoutPattern: 'Asymmetric split or full-bleed art-directed hero with clear focal CTA',
					components: ['Display H1', 'Lead subcopy', 'Primary & Secondary CTAs', 'Hero visual/preview'],
					dataAndInteractions: ['Primary CTA routes or triggers live core action'],
					assetSlots: analysis.assetNeeds.filter(a => a.priority === 'essential').slice(0, 1).map(a => a.slot),
				},
				{
					id: 'discovery',
					name: 'Core Discovery / Showcase Grid',
					purpose: `Deliver immediate interactive utility for ${analysis.primaryGoals[0] ?? 'primary goal'}.`,
					layoutPattern: 'Responsive auto-fit CSS Grid (1 col mobile → 2 col tablet → 3–4 col desktop)',
					components: analysis.coreComponents.slice(0, 4),
					dataAndInteractions: analysis.interactiveFunctionality.slice(0, 3),
					assetSlots: analysis.assetNeeds.slice(1).map(a => a.slot),
				},
				{
					id: 'trust-and-action',
					name: 'Proof, Details & Conversion Band',
					purpose: 'Reinforce trust, answer key objections, and guide users smoothly to the next journey step.',
					layoutPattern: 'Structured 2-column or 3-column proof band + focused conversion band',
					components: ['Testimonials / Metrics / Trust signals', 'FAQ / Details', 'Validated action form'],
					dataAndInteractions: ['Form validation with inline error & confirmation states'],
					assetSlots: [],
				},
			]
			: [
				{
					id: 'page-header',
					name: `${pageTitle} Header & Controls`,
					purpose: `Orient the user within ${pageTitle} with breadcrumb/title and primary controls.`,
					layoutPattern: 'Flex header bar collapsing cleanly on mobile',
					components: ['H1 title', 'Search / Filter / Action controls'],
					dataAndInteractions: ['Real filtering, search, or navigation state'],
					assetSlots: [],
				},
				{
					id: 'main-content',
					name: `${pageTitle} Main Workspace`,
					purpose: `Complete functional implementation of ${pageTitle}.`,
					layoutPattern: 'Responsive grid or master-detail layout with clear state feedback',
					components: analysis.coreComponents.slice(0, 3),
					dataAndInteractions: analysis.interactiveFunctionality.slice(0, 3),
					assetSlots: analysis.assetNeeds.slice(0, 1).map(a => a.slot),
				},
			];

		return {
			name: pageTitle,
			route: slug,
			purpose: `Enable users to accomplish: ${analysis.primaryGoals[idx % analysis.primaryGoals.length] ?? analysis.primaryGoals[0]}`,
			primaryCta: isHome ? 'Explore / Get Started' : isAdmin ? 'Manage Records' : `Complete ${pageTitle}`,
			navigationRole: isAdmin ? 'admin' : idx < 5 ? 'primary' : 'secondary',
			sections,
			statesRequired: ['default', 'loading', 'empty', 'error', 'filtered'],
		};
	});

	const isAppShell = analysis.domain === 'web_app' || analysis.domain === 'desktop_app' || analysis.domain === 'specialized';
	const isMobile = analysis.domain === 'mobile_app';

	return {
		productName: analysis.productName,
		category: analysis.category,
		navigationPattern: isMobile
			? 'Persistent bottom tab bar (4–5 primary destinations) + compact contextual top bar'
			: isAppShell
				? 'Collapsible left workspace sidebar (240px desktop) + sticky top utility bar with search & account'
				: 'Sticky top navigation bar with brand mark, primary links (<=6), search/cart utility, and primary CTA',
		mobileNavigationPattern: isMobile
			? 'Fixed bottom navigation bar with safe-area-inset-bottom + swipe/bottom-sheet modals'
			: 'Compact mobile header with accessible slide-over navigation drawer (44px touch targets, Escape & backdrop close)',
		pages,
		sharedShellComponents: ['Skip-to-main-content link', 'Accessible Header / Navigation', 'Toast Notification Region (aria-live)', 'Modal / Drawer Focus Trap', 'Footer / Status Bar'],
		stateAndDataFlows: analysis.interactiveFunctionality,
	};
}

export function generateResponsiveLayout(opts: {
	productDescription?: string;
	productCategory?: string;
	maxContentWidth?: string;
}): ResponsiveLayoutSpec {
	const { blueprint } = matchProductBlueprint(opts.productDescription ?? '', opts.productCategory);
	const isDashboard = blueprint.domain === 'web_app' || blueprint.domain === 'desktop_app' || blueprint.domain === 'specialized';
	const maxContentWidth = opts.maxContentWidth || (isDashboard ? '1600px' : '1280px');

	const cssFoundation = `/* Kodia Responsive Layout Foundation */
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; overflow-x: clip; }
body { margin: 0; min-height: 100dvh; overflow-x: clip; }
img, picture, video, canvas, svg { display: block; max-width: 100%; }
img { height: auto; }

.kodia-container {
  width: min(100% - 2 * clamp(1rem, 4vw, 2.5rem), ${maxContentWidth});
  margin-inline: auto;
}

.kodia-grid-auto {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr));
  gap: clamp(1rem, 2.2vw, 1.75rem);
}

.kodia-card-container { container-type: inline-size; }
@container (min-width: 460px) {
  .kodia-card-responsive { display: grid; grid-template-columns: 180px 1fr; gap: 1.25rem; align-items: center; }
}

.kodia-table-wrap { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }

@media (pointer: coarse) {
  button, a, input, select, [role="button"] { min-height: 44px; }
}

.kodia-safe-bottom { padding-bottom: max(1rem, env(safe-area-inset-bottom)); }`;

	return {
		strategy: 'Mobile-first fluid architecture combining CSS Grid auto-fit, Container Queries, clamp() typography, and purposeful mobile layout transformations.',
		maxContentWidth,
		breakpoints: [
			{ name: 'mobile-sm', minWidthPx: 320, maxWidthPx: 479, columns: 4, containerPadding: '16px', gutter: '12px', navigationBehavior: 'Compact top bar + slide-over drawer or bottom tabs', layoutTransformations: ['Single-column stack', 'Full-width primary CTAs', 'Filter bar collapses to Filter Drawer button', 'Tables transform to stacked cards or horizontally scrollable container'] },
			{ name: 'mobile-lg', minWidthPx: 480, maxWidthPx: 767, columns: 4, containerPadding: '20px', gutter: '16px', navigationBehavior: 'Compact top bar + drawer/bottom tabs', layoutTransformations: ['2-column compact product/stat grids where readable', 'Full-width forms with side-by-side short fields (e.g. City/ZIP)'] },
			{ name: 'tablet-portrait', minWidthPx: 768, maxWidthPx: 1023, columns: 8, containerPadding: '24px', gutter: '20px', navigationBehavior: 'Condensed horizontal nav or collapsible icon rail', layoutTransformations: ['2-column feature/card grids', 'Slide-over detail drawers instead of full page jumps'] },
			{ name: 'tablet-landscape', minWidthPx: 1024, maxWidthPx: 1279, columns: 12, containerPadding: '32px', gutter: '24px', navigationBehavior: 'Full desktop nav or persistent collapsible sidebar', layoutTransformations: ['3-column grids', 'Side-by-side filter sidebar + catalog grid'] },
			{ name: 'laptop', minWidthPx: 1280, maxWidthPx: 1439, columns: 12, containerPadding: '32px', gutter: '24px', navigationBehavior: 'Full navigation + inline utilities', layoutTransformations: ['3–4 column grids', 'Full split-screen hero & master-detail panes'] },
			{ name: 'desktop', minWidthPx: 1440, maxWidthPx: 1919, columns: 12, containerPadding: '40px', gutter: '28px', navigationBehavior: 'Full navigation with balanced whitespace', layoutTransformations: ['Max-width centered container prevents stretched unreadable lines'] },
			{ name: 'ultrawide', minWidthPx: 1920, columns: 12, containerPadding: '48px', gutter: '32px', navigationBehavior: 'Centered max-width container or fluid multi-pane workbench', layoutTransformations: ['Constrained prose measure (<=72ch)', 'Optional extra dashboard pane only when data benefits'] },
		],
		cssFoundation,
		mobileTransformations: [
			'Convert horizontal filter rows into a sticky "Filter & Sort" trigger opening a full-height sheet/drawer.',
			'Convert dense multi-column pricing/comparison tables into clean stacked cards on <640px.',
			'Keep sticky checkout/booking CTA reachable in the lower thumb zone with `env(safe-area-inset-bottom)`.',
			'Hide decorative secondary chrome on mobile while preserving 100% of core user functionality.',
		],
		touchAndSafeAreaRules: [
			'All interactive controls >= 44x44px touch area on coarse pointers with >= 8px gap.',
			'Dialogs/modals constrain `max-width: calc(100vw - 2rem)` and `max-height: calc(100dvh - 2rem)` with internal scrolling.',
			'Use `100dvh` instead of `100vh` to prevent mobile browser address bar clipping.',
		],
		containerQueryPatterns: [
			'Place `container-type: inline-size` on card wrappers so components adapt inside both sidebars and main grids.',
		],
		overflowPreventionChecklist: [
			'Never assign fixed widths > 300px without `max-width: 100%`.',
			'Apply `min-width: 0` on flex/grid children containing long text, URLs, or code.',
			'Apply `overflow-wrap: anywhere` on user-generated titles/emails and `overflow-x: auto` on table/code wrappers.',
		],
	};
}

// ============================================================================
// 4. ICON LIBRARY & COMPONENT RECOMMENDATIONS / VARIANTS
// ============================================================================

export function recommendIconLibrary(opts: {
	existingDependencies?: readonly string[];
	framework?: FrontendFramework;
	visualDirection?: VisualDirectionId;
}): IconLibraryRecommendation {
	const deps = (opts.existingDependencies ?? []).map(d => d.toLowerCase());
	const detected: IconLibraryName[] = [];
	for (const lib of ICON_LIBRARIES) {
		if (lib.packageNames.some(pkg => deps.includes(pkg.toLowerCase()))) {
			detected.push(lib.name);
		}
	}

	let recommended: IconLibraryName = detected[0] ?? 'lucide';
	if (detected.length === 0) {
		if (opts.visualDirection === 'luxury-editorial' || opts.visualDirection === 'sophisticated-fashion') {
			recommended = 'phosphor';
		} else if (opts.visualDirection === 'material-inspired') {
			recommended = 'material-symbols';
		} else if (opts.visualDirection === 'modern-dashboard' || opts.visualDirection === 'modern-enterprise') {
			recommended = 'lucide';
		}
	}

	const meta = ICON_LIBRARIES.find(l => l.name === recommended) ?? ICON_LIBRARIES[0];
	const fw = opts.framework ?? 'react';
	let packageName = meta.defaultPackage;
	if (recommended === 'lucide') {
		packageName = fw === 'vue' || fw === 'nuxt' ? 'lucide-vue-next'
			: fw === 'svelte' || fw === 'sveltekit' ? 'lucide-svelte'
				: fw === 'html-css-js' ? 'lucide'
					: 'lucide-react';
	} else if (recommended === 'phosphor') {
		packageName = fw === 'vue' || fw === 'nuxt' ? '@phosphor-icons/vue'
			: fw === 'html-css-js' ? '@phosphor-icons/web'
				: '@phosphor-icons/react';
	}

	return {
		detectedExistingLibraries: detected,
		recommendedLibrary: recommended,
		reuseExisting: detected.length > 0,
		packageName,
		installCommand: detected.length > 0 ? undefined : `npm install ${packageName}`,
		strokeWidth: meta.defaultStrokeWidth,
		sizingScale: { xs: '14px', sm: '16px', md: '20px', lg: '24px', xl: '32px' },
		recommendedIconsBySlot: {
			search: 'Search',
			menu: 'Menu / X',
			cart: 'ShoppingBag',
			wishlist: 'Heart',
			user: 'User',
			filter: 'SlidersHorizontal',
			sort: 'ArrowUpDown',
			chevron: 'ChevronRight / ChevronDown',
			check: 'Check / CheckCircle2',
			alert: 'AlertCircle / AlertTriangle',
			loading: 'Loader2 (animate-spin)',
			theme: 'Sun / Moon',
			settings: 'Settings',
			external: 'ArrowUpRight',
		},
		accessibilityRules: [
			'Decorative icons next to visible text MUST set `aria-hidden="true"`.',
			'Icon-only buttons MUST set an explicit `aria-label` (e.g. `aria-label="Open shopping bag"`).',
			'Never use raw emoji characters as UI navigation, button, or status icons.',
			'Do not install a second overlapping icon library when one is already installed in package.json.',
		],
	};
}

export function recommendUiComponents(opts: {
	productDescription: string;
	productCategory?: string;
	visualDirection?: VisualDirectionId;
}): ComponentRecommendation[] {
	const analysis = analyzeProductDesignRequirements(opts);
	const dir = VISUAL_DIRECTIONS[opts.visualDirection ?? analysis.recommendedDirections[0]];
	const base: ComponentRecommendation[] = [
		{
			name: 'Button System',
			category: 'button',
			priority: 'essential',
			variants: ['primary', 'secondary', 'outline', 'ghost', 'destructive', 'icon', 'loading'],
			interactiveStates: ['default', 'hover', 'focus-visible', 'active', 'disabled', 'loading'],
			visualTreatment: `${dir.borderRadiusStyle} with ${dir.motionCharacter}`,
			accessibilityRequirements: ['Native <button type="button|submit">', 'Visible focus ring', 'aria-busy on loading', 'aria-label on icon-only'],
			responsiveBehavior: 'Minimum 44px height on touch devices; stack or full-width primary CTA on mobile.',
		},
		{
			name: 'Card System',
			category: 'card',
			priority: 'essential',
			variants: analysis.domain === 'ecommerce'
				? ['product-card', 'editorial-card', 'category-card', 'testimonial-card']
				: analysis.domain === 'web_app'
					? ['kpi-stat-card', 'dashboard-card', 'data-card', 'compact-mobile-card']
					: ['editorial-card', 'image-led-card', 'pricing-card', 'testimonial-card'],
			interactiveStates: ['default', 'hover', 'focus-within', 'selected', 'loading-skeleton'],
			visualTreatment: `${dir.surfaceTreatment} Elevation: ${dir.elevationStrategy}`,
			accessibilityRequirements: ['Use semantic heading inside card', 'Avoid nested interactive elements inside clickable cards'],
			responsiveBehavior: 'Container-query ready; 1 col mobile → 2 col tablet → 3–4 col desktop.',
		},
		{
			name: 'Adaptive Navigation Shell',
			category: 'navigation',
			priority: 'essential',
			variants: ['sticky-topbar', 'mobile-drawer', 'breadcrumbs', ...(analysis.domain === 'web_app' ? ['collapsible-sidebar'] : []), ...(analysis.domain === 'mobile_app' ? ['bottom-tab-bar'] : [])],
			interactiveStates: ['default', 'active-route', 'hover', 'focus-visible', 'drawer-open'],
			visualTreatment: 'Clean translucent or solid header with hairline bottom border and unmistakable active state.',
			accessibilityRequirements: ['<nav aria-label="Primary">', 'aria-current="page"', 'aria-expanded on drawer toggle', 'Escape closes drawer'],
			responsiveBehavior: 'Desktop horizontal links/sidebar transform into touch-friendly drawer or bottom tab bar on <768px.',
		},
		{
			name: 'Form, Search & Filter Controls',
			category: 'form',
			priority: 'essential',
			variants: ['text-input', 'search-bar', 'select', 'filter-chips', 'checkbox-radio', 'inline-validation'],
			interactiveStates: ['default', 'hover', 'focus-visible', 'invalid', 'disabled', 'submitting'],
			visualTreatment: 'Clear 1px border, >=44px height, crisp focus ring, readable placeholder & label contrast.',
			accessibilityRequirements: ['Explicit <label for>', 'aria-invalid & aria-describedby for error messages'],
			responsiveBehavior: '16px minimum input font size on iOS to prevent unwanted zoom; single-column mobile form stacking.',
		},
		{
			name: 'Feedback & Async States',
			category: 'feedback',
			priority: 'essential',
			variants: ['loading-skeleton', 'empty-state', 'error-banner', 'toast-notification', 'status-badge'],
			interactiveStates: ['loading', 'empty', 'error', 'success'],
			visualTreatment: 'Restrained semantic tokens paired with vector icons and helpful recovery actions.',
			accessibilityRequirements: ['role="status" / aria-live="polite" for toasts', 'role="alert" for errors'],
			responsiveBehavior: 'Toasts anchor safely above mobile bottom bars.',
		},
	];

	if (analysis.domain === 'ecommerce') {
		base.push(
			{
				name: 'Slide-Over Cart & Product Gallery',
				category: 'overlay',
				priority: 'essential',
				variants: ['cart-drawer', 'image-gallery-zoom', 'size-color-swatch', 'checkout-summary'],
				interactiveStates: ['empty', 'populated', 'updating-qty', 'promo-applied'],
				visualTreatment: 'Crisp studio framing, tabular prices, live subtotal updates.',
				accessibilityRequirements: ['role="dialog" aria-modal="true"', 'Focus trap & Escape close', 'Live cart count announcement'],
				responsiveBehavior: 'Full-width drawer on mobile with sticky bottom checkout bar and safe-area padding.',
			}
		);
	} else if (analysis.domain === 'web_app' || analysis.domain === 'specialized') {
		base.push(
			{
				name: 'Data Table, Charts & Detail Drawer',
				category: 'data-display',
				priority: 'essential',
				variants: ['sortable-data-table', 'responsive-chart-card', 'detail-drawer', 'pagination'],
				interactiveStates: ['sorted-asc', 'sorted-desc', 'filtered', 'row-selected', 'empty'],
				visualTreatment: 'Tabular numerals, crisp row dividers, colorblind-safe chart series.',
				accessibilityRequirements: ['<th scope="col">', 'aria-sort on sortable headers', 'Keyboard-accessible tooltips'],
				responsiveBehavior: 'Horizontal scroll wrapper or mobile stacked key-value cards on <640px.',
			}
		);
	}

	return base;
}

export function generateComponentVariants(opts: {
	componentType: string;
	framework?: FrontendFramework;
	stylingSystem?: StylingSystem;
	visualDirection?: VisualDirectionId;
}): ComponentVariantSpec {
	const componentType = opts.componentType.trim().toLowerCase();
	const framework = opts.framework ?? 'react';
	const stylingSystem = opts.stylingSystem ?? 'tailwind';
	const visualDirection = opts.visualDirection ?? 'high-end-saas';
	const dir = VISUAL_DIRECTIONS[visualDirection];
	const radiusClass = visualDirection === 'luxury-editorial' || visualDirection === 'sophisticated-fashion' || visualDirection === 'swiss-editorial'
		? 'rounded-sm'
		: visualDirection === 'glassmorphism' || visualDirection === 'soft-minimalism'
			? 'rounded-2xl'
			: 'rounded-lg';

	if (componentType.includes('button')) {
		const variants = [
			{ name: 'primary', usage: 'Single primary action per viewport/card', classesOrTokens: `bg-[var(--color-primary)] text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] ${radiusClass}`, states: ['default', 'hover', 'focus-visible', 'active', 'disabled', 'loading'] },
			{ name: 'secondary', usage: 'Supporting action alongside primary CTA', classesOrTokens: `bg-[var(--color-secondary)] text-[var(--color-secondary-fg)] hover:bg-[var(--color-surface-hover)] ${radiusClass}`, states: ['default', 'hover', 'focus-visible', 'active', 'disabled'] },
			{ name: 'outline', usage: 'Crisp bordered action on clean surfaces', classesOrTokens: `border border-[var(--color-border-strong)] bg-transparent text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] ${radiusClass}`, states: ['default', 'hover', 'focus-visible', 'active', 'disabled'] },
			{ name: 'ghost', usage: 'Low-emphasis toolbar/inline action', classesOrTokens: `bg-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] ${radiusClass}`, states: ['default', 'hover', 'focus-visible', 'active'] },
			{ name: 'destructive', usage: 'Irreversible delete/remove confirmation', classesOrTokens: `bg-[var(--color-error)] text-white hover:opacity-90 ${radiusClass}`, states: ['default', 'hover', 'focus-visible', 'disabled'] },
		];
		const snippet = framework === 'html-css-js'
			? `<button type="button" class="btn btn--primary" aria-busy="false">Primary Action</button>
<style>
.btn { display:inline-flex; align-items:center; justify-content:center; gap:.5rem; min-height:44px; padding:.625rem 1.25rem; font-weight:600; font-size:var(--text-sm); border-radius:var(--radius-md); border:1px solid transparent; cursor:pointer; transition:background-color var(--duration-fast) var(--ease-standard), transform var(--duration-fast) var(--ease-standard); }
.btn:focus-visible { outline:2px solid var(--color-focus-ring); outline-offset:2px; }
.btn:active:not(:disabled) { transform:translateY(1px); }
.btn:disabled { opacity:.5; cursor:not-allowed; }
.btn--primary { background:var(--color-primary); color:var(--color-primary-fg); }
.btn--primary:hover:not(:disabled) { background:var(--color-primary-hover); }
</style>`
			: `export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive';
export function Button({ variant = 'primary', loading = false, className = '', children, disabled, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; loading?: boolean }) {
  const styles: Record<ButtonVariant, string> = {
    primary: 'bg-[var(--color-primary)] text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)]',
    secondary: 'bg-[var(--color-secondary)] text-[var(--color-secondary-fg)] hover:bg-[var(--color-surface-hover)]',
    outline: 'border border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]',
    ghost: 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]',
    destructive: 'bg-[var(--color-error)] text-white hover:opacity-90',
  };
  return (
    <button type="button" disabled={disabled || loading} aria-busy={loading} className={\`inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2 text-sm font-medium ${radiusClass} transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)] disabled:opacity-50 disabled:pointer-events-none \${styles[variant]} \${className}\`} {...props}>
      {loading ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}`;
		return {
			componentType: 'button',
			framework,
			stylingSystem,
			visualDirection,
			variants,
			implementationSnippet: snippet,
			accessibilityChecklist: ['Explicit type="button" unless submitting a form', 'Visible :focus-visible outline', '44px minimum touch height', 'aria-busy when loading'],
		};
	}

	// Default: polished Card system (product / editorial / dashboard / pricing)
	const variants = [
		{ name: 'product-card', usage: 'E-commerce catalog card with 3:4/1:1 image, swatches, price & quick-add', classesOrTokens: `group bg-[var(--color-surface)] border border-[var(--color-border)] ${radiusClass} overflow-hidden transition-all`, states: ['default', 'hover', 'focus-within', 'out-of-stock'] },
		{ name: 'dashboard-kpi-card', usage: 'Executive metric card with tabular numerals and delta pill', classesOrTokens: `bg-[var(--color-surface)] border border-[var(--color-border)] ${radiusClass} p-5 shadow-[var(--shadow-sm)]`, states: ['default', 'loading-skeleton', 'positive-delta', 'negative-delta'] },
		{ name: 'editorial-card', usage: 'Storytelling / article / case-study card with crisp framing', classesOrTokens: `group flex flex-col gap-3 bg-transparent ${radiusClass}`, states: ['default', 'hover', 'focus-within'] },
		{ name: 'pricing-card', usage: 'Tier comparison card with single highlighted recommended tier', classesOrTokens: `flex flex-col justify-between bg-[var(--color-surface)] border border-[var(--color-border)] ${radiusClass} p-6`, states: ['default', 'featured', 'current-plan'] },
	];
	const snippet = `<!-- ${dir.name} Card Pattern -->
<article class="group bg-[var(--color-surface)] border border-[var(--color-border)] ${radiusClass} overflow-hidden transition-shadow hover:shadow-[var(--shadow-md)]">
  <div class="aspect-[4/3] overflow-hidden bg-[var(--color-bg-subtle)]">
    <img src="/images/item.jpg" alt="Descriptive product or feature image" loading="lazy" class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
  </div>
  <div class="p-5 flex flex-col gap-2">
    <span class="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Category</span>
    <h3 class="text-lg font-semibold text-[var(--color-text)] leading-snug">Card Title</h3>
    <p class="text-sm text-[var(--color-text-secondary)] leading-relaxed">Concise value-focused supporting copy.</p>
  </div>
</article>`;

	return {
		componentType,
		framework,
		stylingSystem,
		visualDirection,
		variants,
		implementationSnippet: snippet,
		accessibilityChecklist: ['One semantic heading per card', 'Explicit aspect-ratio to prevent CLS', 'Descriptive alt text on card imagery', 'Sufficient >=4.5:1 contrast for metadata and muted captions'],
	};
}

// ============================================================================
// 5. STATIC EXISTING DESIGN SYSTEM INSPECTION & CONSISTENCY AUDIT
// ============================================================================

export function inspectExistingDesignSystem(files: readonly WorkspaceFileSample[]): ExistingDesignSystemReport {
	let framework: FrontendFramework = 'unknown';
	let stylingSystem: StylingSystem = 'unknown';
	const detectedIcons = new Set<IconLibraryName>();
	const detectedAnimations = new Set<string>();
	const detectedFonts = new Set<string>();
	const cssVars = new Set<string>();
	const hexColors = new Set<string>();
	const designTokenFiles: string[] = [];
	let tailwindConfigPath: string | undefined;
	let componentFilesCount = 0;
	let imageAssetsCount = 0;
	let hasDarkThemeSupport = false;
	let hasReducedMotionSupport = false;

	const pkgFile = files.find(f => /(?:^|\/)package\.json$/i.test(f.path));
	if (pkgFile) {
		try {
			const pkg = JSON.parse(pkgFile.content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
			const allDeps = new Set([
				...Object.keys(pkg.dependencies ?? {}),
				...Object.keys(pkg.devDependencies ?? {}),
			].map(d => d.toLowerCase()));

			if (allDeps.has('next')) { framework = 'nextjs'; }
			else if (allDeps.has('nuxt')) { framework = 'nuxt'; }
			else if (allDeps.has('@sveltejs/kit')) { framework = 'sveltekit'; }
			else if (allDeps.has('astro')) { framework = 'astro'; }
			else if (allDeps.has('react-native')) { framework = 'react-native'; }
			else if (allDeps.has('react')) { framework = 'react'; }
			else if (allDeps.has('vue')) { framework = 'vue'; }
			else if (allDeps.has('svelte')) { framework = 'svelte'; }
			else if (allDeps.has('@angular/core')) { framework = 'angular'; }

			if (allDeps.has('tailwindcss') || allDeps.has('@tailwindcss/vite') || allDeps.has('@tailwindcss/postcss')) { stylingSystem = 'tailwind'; }
			else if (allDeps.has('styled-components')) { stylingSystem = 'styled-components'; }
			else if (allDeps.has('@emotion/react')) { stylingSystem = 'emotion'; }
			else if (allDeps.has('sass') || allDeps.has('scss')) { stylingSystem = 'scss'; }

			for (const lib of ICON_LIBRARIES) {
				if (lib.packageNames.some(p => allDeps.has(p.toLowerCase()))) {
					detectedIcons.add(lib.name);
				}
			}
			for (const anim of ['framer-motion', 'motion', 'gsap', '@react-spring/web', 'lottie-react', 'lenis']) {
				if (allDeps.has(anim)) { detectedAnimations.add(anim); }
			}
		} catch { /* ignore invalid package.json */ }
	}

	for (const f of files) {
		const normPath = f.path.replace(/\\/g, '/');
		if (/tailwind\.config\./i.test(normPath)) { tailwindConfigPath = normPath; stylingSystem = 'tailwind'; }
		if (/tokens|theme|variables|design-system/i.test(normPath) && /\.(css|scss|ts|js|json)$/i.test(normPath)) {
			designTokenFiles.push(normPath);
		}
		if (/\.(tsx|jsx|vue|svelte)$/i.test(normPath)) { componentFilesCount++; }
		if (/\.(png|jpe?g|webp|avif|svg|gif)$/i.test(normPath)) { imageAssetsCount++; continue; }
		if (framework === 'unknown' && /\.html?$/i.test(normPath)) { framework = 'html-css-js'; }
		if (stylingSystem === 'unknown' && /\.module\.css$/i.test(normPath)) { stylingSystem = 'css-modules'; }
		else if (stylingSystem === 'unknown' && /\.css$/i.test(normPath)) { stylingSystem = 'vanilla-css'; }

		if (!/\.(css|scss|html?|tsx|jsx|vue|svelte|ts|js)$/i.test(normPath)) { continue; }
		const text = f.content;
		if (/prefers-color-scheme:\s*dark|\[data-theme=['"]dark['"]\]|\.dark\b/i.test(text)) { hasDarkThemeSupport = true; }
		if (/prefers-reduced-motion/i.test(text)) { hasReducedMotionSupport = true; }
		if (/@import\s+["']tailwindcss["']|@tailwind\s+base/i.test(text)) { stylingSystem = 'tailwind'; }

		const varMatches = text.match(/--[a-zA-Z0-9_-]{2,40}\s*:/g);
		if (varMatches) {
			for (const m of varMatches) { cssVars.add(m.replace(/\s*:$/, '')); }
		}
		const hexMatches = text.match(/#[0-9a-fA-F]{6}\b/g);
		if (hexMatches) {
			for (const m of hexMatches) { hexColors.add(m.toUpperCase()); }
		}
		const fontMatches = text.match(/font-family\s*:\s*([^;}{]+)/gi);
		if (fontMatches) {
			for (const m of fontMatches) {
				const primaryFont = m.replace(/font-family\s*:\s*/i, '').split(',')[0].replace(/['"]/g, '').trim();
				if (primaryFont && !primaryFont.startsWith('var(')) { detectedFonts.add(primaryFont); }
			}
		}
		const gFontMatches = text.match(/fonts\.googleapis\.com\/css2\?[^"'\s)]+/gi);
		if (gFontMatches) {
			for (const url of gFontMatches) {
				const famMatches = url.match(/family=([^:&]+)/g);
				if (famMatches) {
					for (const fm of famMatches) {
						detectedFonts.add(decodeURIComponent(fm.replace('family=', '').replace(/\+/g, ' ')));
					}
				}
			}
		}
	}

	const summary = `Detected ${framework} + ${stylingSystem} | Icons: ${[...detectedIcons].join(', ') || 'none detected'} | ${cssVars.size} CSS token(s), ${hexColors.size} unique hex color(s), ${componentFilesCount} component file(s), ${imageAssetsCount} image asset(s), Dark theme: ${hasDarkThemeSupport ? 'yes' : 'no'}, Reduced motion: ${hasReducedMotionSupport ? 'yes' : 'no'}.`;

	return {
		framework,
		stylingSystem,
		detectedIconLibraries: [...detectedIcons],
		detectedAnimationLibraries: [...detectedAnimations],
		detectedFonts: [...detectedFonts].slice(0, 12),
		cssVariablesCount: cssVars.size,
		sampleCssVariables: [...cssVars].slice(0, 24),
		detectedColors: [...hexColors].slice(0, 24),
		tailwindConfigPath,
		designTokenFiles: designTokenFiles.slice(0, 12),
		componentFilesCount,
		imageAssetsCount,
		hasDarkThemeSupport,
		hasReducedMotionSupport,
		summary,
	};
}

export function auditDesignConsistency(files: readonly WorkspaceFileSample[]): DesignConsistencyAuditReport {
	const findings: DesignAuditFinding[] = [];
	const strengths: string[] = [];
	const uniqueHex = new Set<string>();
	let cssVarUsageCount = 0;
	let hardcodedColorCount = 0;
	let hasMediaQueryOrResponsive = false;
	let hasReducedMotion = false;
	let hasFocusVisible = false;
	let uiFileCount = 0;

	const addFinding = (f: Omit<DesignAuditFinding, 'id'>) => {
		findings.push({ id: `AUDIT-${String(findings.length + 1).padStart(3, '0')}`, ...f });
	};

	const uiFiles = files.filter(f => /\.(css|scss|html?|tsx|jsx|vue|svelte)$/i.test(f.path));
	for (const f of uiFiles) {
		uiFileCount++;
		const content = f.content;

		const varUses = content.match(/var\(--[a-zA-Z0-9_-]+\)/g);
		if (varUses) { cssVarUsageCount += varUses.length; }

		const hexes = content.match(/#[0-9a-fA-F]{6}\b/g);
		if (hexes) {
			for (const h of hexes) { uniqueHex.add(h.toUpperCase()); }
			// Hardcoded hexes outside token definition files
			if (!/tokens|theme|variables|styles\.css/i.test(f.path)) {
				hardcodedColorCount += hexes.length;
			}
		}

		if (/@media\b|\bsm:|\bmd:|\blg:|\bxl:|clamp\(|auto-fit|auto-fill|@container/i.test(content)) {
			hasMediaQueryOrResponsive = true;
		}
		if (/prefers-reduced-motion/i.test(content)) { hasReducedMotion = true; }
		if (/:focus-visible|focus-visible:/i.test(content)) { hasFocusVisible = true; }

		// Missing alt on <img>
		const imgTags = content.match(/<img\b[^>]*>/gi) ?? [];
		for (const tag of imgTags) {
			if (!/\balt\s*=/i.test(tag)) {
				addFinding({
					severity: 'major',
					category: 'accessibility',
					title: 'Image missing alt attribute',
					detail: `Found <img> tag without an alt attribute in ${f.path}.`,
					location: f.path,
					fixRecommendation: 'Add descriptive alt="..." text (or alt="" if purely decorative).',
				});
				break;
			}
			if (/via\.placeholder\.com|placehold\.it|placeholder\.com|dummyimage\.com/i.test(tag)) {
				addFinding({
					severity: 'major',
					category: 'imagery',
					title: 'Generic placeholder image service detected',
					detail: `Found placeholder URL in ${f.path}.`,
					location: f.path,
					fixRecommendation: 'Replace with a real discovered/downloaded visual asset or bespoke SVG illustration via discover_visual_assets + download_visual_assets.',
				});
				break;
			}
		}

		// Lorem ipsum check
		if (/lorem\s+ipsum/i.test(content)) {
			addFinding({
				severity: 'major',
				category: 'hierarchy',
				title: 'Lorem ipsum placeholder text found',
				detail: `Unfinished placeholder copy detected in ${f.path}.`,
				location: f.path,
				fixRecommendation: 'Replace with realistic domain-specific copy tailored to the product.',
			});
		}

		// outline: none without replacement
		if (/outline\s*:\s*(?:none|0)\b/i.test(content) && !/:focus-visible|box-shadow/i.test(content)) {
			addFinding({
				severity: 'major',
				category: 'accessibility',
				title: 'Focus outline removed without accessible replacement',
				detail: `${f.path} sets outline: none/0 without a visible focus-visible indicator.`,
				location: f.path,
				fixRecommendation: 'Provide a crisp :focus-visible { outline: 2px solid var(--color-focus-ring); outline-offset: 2px; } rule.',
			});
		}

		// Emoji used inside buttons/nav links as UI icons
		if (/<(?:button|a|nav)\b[^>]*>[^<]*[🚀🔥✨⚙️🛒🔍🏠👤❤️⭐🎉💡📊]/u.test(content)) {
			addFinding({
				severity: 'minor',
				category: 'icons',
				title: 'Emoji used as UI icon in interactive control',
				detail: `${f.path} uses raw emoji characters inside a button/link/nav instead of vector icons.`,
				location: f.path,
				fixRecommendation: 'Replace emoji UI icons with consistent vector icons from the project icon library (e.g. Lucide or inline accessible SVG).',
			});
		}
	}

	if (uiFileCount > 0) {
		if (uniqueHex.size > 24 && cssVarUsageCount < 5) {
			addFinding({
				severity: 'major',
				category: 'consistency',
				title: 'Color sprawl with minimal design-token adoption',
				detail: `Found ${uniqueHex.size} unique hex colors across UI files with only ${cssVarUsageCount} CSS variable usages.`,
				fixRecommendation: 'Consolidate palette into semantic CSS custom properties (--color-bg, --color-surface, --color-text, --color-primary, --color-border) via generate_design_tokens.',
			});
		} else if (cssVarUsageCount >= 8) {
			strengths.push(`Consistent design token adoption (${cssVarUsageCount} CSS variable references).`);
		}

		if (!hasMediaQueryOrResponsive) {
			addFinding({
				severity: 'critical',
				category: 'responsive',
				title: 'No responsive breakpoints or fluid layout primitives detected',
				detail: 'Scanned UI files contain no @media queries, responsive utility classes, container queries, or clamp() expressions.',
				fixRecommendation: 'Apply responsive grid/flex/media rules from generate_responsive_layout so mobile, tablet, and desktop layouts adapt cleanly.',
			});
		} else {
			strengths.push('Responsive layout primitives (media queries, fluid sizing, or responsive grid utilities) are present.');
		}

		if (!hasReducedMotion) {
			addFinding({
				severity: 'minor',
				category: 'accessibility',
				title: 'Missing prefers-reduced-motion accessibility rule',
				detail: 'No @media (prefers-reduced-motion: reduce) fallback detected in stylesheets.',
				fixRecommendation: 'Add the prefers-reduced-motion rule from generate_design_tokens.',
			});
		} else {
			strengths.push('Respects prefers-reduced-motion user accessibility preference.');
		}

		if (hasFocusVisible) {
			strengths.push('Uses :focus-visible keyboard focus styling.');
		}
	}

	let score = 100;
	for (const f of findings) {
		if (f.severity === 'critical') { score -= 22; }
		else if (f.severity === 'major') { score -= 12; }
		else if (f.severity === 'minor') { score -= 5; }
	}
	score = Math.max(10, Math.min(100, score));

	return {
		score,
		filesScanned: uiFileCount,
		uniqueHexColors: uniqueHex.size,
		cssVariableUsageCount: cssVarUsageCount,
		hardcodedColorCount,
		findings,
		strengths,
		summary: `Design consistency score: ${score}/100 across ${uiFileCount} UI file(s) (${findings.length} finding(s): ${findings.filter(f => f.severity === 'critical').length} critical, ${findings.filter(f => f.severity === 'major').length} major, ${findings.filter(f => f.severity === 'minor').length} minor).`,
	};
}

// ============================================================================
// 6. INTERFACE DESIGN CRITIQUE & DEFECT REPAIR PLANNER
// ============================================================================

export function critiqueInterfaceDesign(opts: {
	staticAudit?: DesignConsistencyAuditReport | null;
	visualAudit?: BrowserVisualAuditResult | null;
	multiViewport?: MultiViewportAuditResult | null;
	productDescription?: string;
}): DesignCritiqueReport {
	const findings: DesignAuditFinding[] = [];
	const strengths: string[] = [...(opts.staticAudit?.strengths ?? [])];

	if (opts.staticAudit) {
		findings.push(...opts.staticAudit.findings);
	}

	let visualScore = 88;
	let typographyScore = 88;
	let colorContrastScore = 92;
	let responsiveScore = 92;
	let imageryScore = 92;
	let accessibilityScore = 92;
	let performanceScore = 90;

	const pushFinding = (f: Omit<DesignAuditFinding, 'id'>) => {
		findings.push({ id: `CRIT-${String(findings.length + 1).padStart(3, '0')}`, ...f });
	};

	const va = opts.visualAudit ?? opts.multiViewport?.captures[0]?.audit ?? null;

	if (va) {
		if (va.loadError) {
			visualScore -= 45;
			pushFinding({
				severity: 'critical',
				category: 'layout',
				title: 'Page failed to load cleanly',
				detail: va.loadError,
				fixRecommendation: 'Fix the server route or rendering error and reload.',
			});
		}
		if (va.consoleErrors > 0) {
			visualScore -= Math.min(25, va.consoleErrors * 10);
			pushFinding({
				severity: 'major',
				category: 'interaction',
				title: `${va.consoleErrors} runtime browser console error(s)`,
				detail: 'JavaScript errors in the browser often break interactive controls or state updates.',
				fixRecommendation: 'Inspect browser_console output, fix runtime exceptions, and re-verify.',
			});
		}
		if (va.brokenImages.length > 0) {
			imageryScore -= Math.min(55, va.brokenImages.length * 25);
			for (const img of va.brokenImages.slice(0, 5)) {
				pushFinding({
					severity: 'critical',
					category: 'imagery',
					title: 'Broken image failed to render',
					detail: `Image ${img.src} rendered with naturalWidth=0.`,
					selector: img.selector,
					fixRecommendation: 'Replace with a verified local asset downloaded via download_visual_assets or fix the asset path.',
				});
			}
		} else {
			strengths.push('All rendered images loaded cleanly (0 broken images).');
		}
		if (va.distortedImages.length > 0) {
			imageryScore -= Math.min(30, va.distortedImages.length * 12);
			for (const img of va.distortedImages.slice(0, 3)) {
				pushFinding({
					severity: 'major',
					category: 'imagery',
					title: 'Distorted / stretched image aspect ratio',
					detail: `Image ${img.src} has natural ratio ${img.naturalRatio} vs rendered ratio ${img.renderedRatio}.`,
					selector: img.selector,
					fixRecommendation: 'Apply object-fit: cover and match container aspect-ratio to prevent distortion.',
				});
			}
		}
		if (va.contrastViolations.length > 0) {
			colorContrastScore -= Math.min(45, va.contrastViolations.length * 12);
			accessibilityScore -= Math.min(35, va.contrastViolations.length * 10);
			for (const c of va.contrastViolations.slice(0, 5)) {
				pushFinding({
					severity: 'major',
					category: 'color-contrast',
					title: `Low text contrast (${c.ratio}:1 < ${c.required}:1)`,
					detail: `"${c.textSample}" has foreground ${c.foreground} on ${c.background}.`,
					selector: c.selector,
					fixRecommendation: 'Adjust foreground/background tokens using WCAG AA (>=4.5:1) colors from generate_color_palette.',
				});
			}
		} else {
			strengths.push('Measured rendered text contrast passes WCAG AA checks.');
		}
		if (va.accessibilityIssues.length > 0) {
			for (const a of va.accessibilityIssues.slice(0, 8)) {
				accessibilityScore -= a.severity === 'critical' ? 18 : a.severity === 'major' ? 10 : 4;
				pushFinding({
					severity: a.severity,
					category: 'accessibility',
					title: `Accessibility: ${a.rule}`,
					detail: a.detail,
					selector: a.selector,
					fixRecommendation: `Resolve WCAG rule "${a.rule}" on ${a.selector}.`,
				});
			}
		}
		if (va.typographyMetrics.bodyFontSizePx !== null && va.typographyMetrics.bodyFontSizePx < 14) {
			typographyScore -= 18;
			pushFinding({
				severity: 'major',
				category: 'typography',
				title: `Body font size too small (${va.typographyMetrics.bodyFontSizePx}px)`,
				detail: 'Body text below 14px reduces readability across desktop and mobile.',
				fixRecommendation: 'Set base body font-size to 16px (1rem) with 1.55–1.65 line-height.',
			});
		}
		if (va.typographyMetrics.h1FontSizePx !== null && va.typographyMetrics.bodyFontSizePx !== null) {
			const ratio = va.typographyMetrics.h1FontSizePx / Math.max(1, va.typographyMetrics.bodyFontSizePx);
			if (ratio < 1.5) {
				typographyScore -= 14;
				pushFinding({
					severity: 'minor',
					category: 'typography',
					title: 'Weak headline-to-body typographic scale contrast',
					detail: `H1 (${va.typographyMetrics.h1FontSizePx}px) is only ${ratio.toFixed(2)}x body size (${va.typographyMetrics.bodyFontSizePx}px).`,
					fixRecommendation: 'Increase display/H1 scale to at least 2x body size using clamp() from recommend_typography.',
				});
			} else {
				strengths.push(`Clear typographic scale (H1 ${va.typographyMetrics.h1FontSizePx}px vs body ${va.typographyMetrics.bodyFontSizePx}px).`);
			}
		}
		if (!va.typographyMetrics.headingHierarchyValid) {
			typographyScore -= 10;
			accessibilityScore -= 8;
		}
		if (va.layoutIssues.length > 0) {
			visualScore -= Math.min(40, va.layoutIssues.length * 14);
			for (const li of va.layoutIssues.slice(0, 6)) {
				pushFinding({
					severity: li.kind === 'horizontal-overflow' || li.kind === 'covered' ? 'critical' : 'major',
					category: 'layout',
					title: `Rendered layout defect: ${li.kind}`,
					detail: li.detail,
					selector: li.selector,
					fixRecommendation: li.kind === 'horizontal-overflow'
						? 'Constrain overflowing element with max-width: 100%, min-width: 0, or responsive CSS Grid wrapping.'
						: li.kind === 'covered'
							? 'Fix z-index / sticky header offset / padding so interactive control is unobstructed.'
							: 'Remove restrictive fixed height or overflow: hidden clipping live text.',
				});
			}
		}
		if (va.performanceMetrics.domNodeCount > 2500) {
			performanceScore -= 15;
			pushFinding({
				severity: 'minor',
				category: 'performance',
				title: `Large DOM tree (${va.performanceMetrics.domNodeCount} nodes)`,
				detail: 'High DOM node counts slow style recalculations and mobile scrolling.',
				fixRecommendation: 'Paginate or virtualize long lists and simplify redundant wrapper divs.',
			});
		}
		if (va.performanceMetrics.totalTransferBytes > 3_000_000) {
			performanceScore -= 18;
			pushFinding({
				severity: 'major',
				category: 'performance',
				title: `Heavy page payload (${(va.performanceMetrics.totalTransferBytes / 1_048_576).toFixed(2)} MB)`,
				detail: 'Excessive transfer weight degrades mobile load times.',
				fixRecommendation: 'Optimize images (WebP/AVIF, proper dimensions, lazy loading) and trim unused bundles.',
			});
		}
	}

	if (opts.multiViewport) {
		for (const cap of opts.multiViewport.captures) {
			if (cap.hasHorizontalOverflow) {
				responsiveScore -= 25;
				pushFinding({
					severity: 'critical',
					category: 'responsive',
					title: `Horizontal overflow on ${cap.label} (${cap.width}x${cap.height})`,
					detail: `Document scrollWidth (${cap.audit.pageMetrics.scrollWidth}px) exceeds viewport width (${cap.width}px).`,
					fixRecommendation: 'Fix overflowing grid/flex items, large images, or fixed-width containers for this breakpoint.',
				});
			}
			if (cap.width <= 480 && cap.smallTouchTargetCount > 0) {
				responsiveScore -= Math.min(20, cap.smallTouchTargetCount * 4);
				pushFinding({
					severity: 'major',
					category: 'responsive',
					title: `${cap.smallTouchTargetCount} undersized touch target(s) on ${cap.label}`,
					detail: `Interactive controls smaller than 44x44px hurt mobile usability.`,
					fixRecommendation: 'Ensure buttons, nav links, and form controls have at least 44x44px hit area on mobile viewports.',
				});
			}
		}
		if (opts.multiViewport.allViewportsClean) {
			strengths.push(`Verified clean layout across all ${opts.multiViewport.captures.length} tested viewports (${opts.multiViewport.captures.map(c => `${c.label} ${c.width}px`).join(', ')}).`);
		}
	}

	// Blend static consistency audit if present
	if (opts.staticAudit) {
		visualScore = Math.round((visualScore + opts.staticAudit.score) / 2);
		for (const f of opts.staticAudit.findings) {
			if (f.category === 'responsive') { responsiveScore -= f.severity === 'critical' ? 25 : 10; }
			if (f.category === 'accessibility') { accessibilityScore -= f.severity === 'major' ? 10 : 4; }
			if (f.category === 'imagery') { imageryScore -= 15; }
		}
	}

	const clampScore = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
	const statusOf = (s: number): DesignCritiqueDimension['status'] =>
		s >= 90 ? 'excellent' : s >= 78 ? 'good' : s >= 60 ? 'needs-work' : 'critical';

	const dimensions: DesignCritiqueDimension[] = [
		{ name: 'Visual Hierarchy & Craft', score: clampScore(visualScore), status: statusOf(clampScore(visualScore)), observations: [va ? `Checked ${va.pageMetrics.interactiveElementCount} interactive elements & ${va.layoutIssues.length} layout defect(s).` : 'Evaluated via static design system signals.'] },
		{ name: 'Typography & Readability', score: clampScore(typographyScore), status: statusOf(clampScore(typographyScore)), observations: [va ? `Fonts: ${va.typographyMetrics.fontFamilies.slice(0, 4).join(', ') || 'system'}; body ${va.typographyMetrics.bodyFontSizePx ?? '?'}px, H1 ${va.typographyMetrics.h1FontSizePx ?? '?'}px.` : 'Check rendered font loading in browser for full verification.'] },
		{ name: 'Color & Contrast', score: clampScore(colorContrastScore), status: statusOf(clampScore(colorContrastScore)), observations: [va ? `${va.contrastViolations.length} rendered WCAG contrast violation(s).` : 'Static token check completed.'] },
		{ name: 'Imagery & Visual Assets', score: clampScore(imageryScore), status: statusOf(clampScore(imageryScore)), observations: [va ? `${va.brokenImages.length} broken, ${va.distortedImages.length} distorted, ${va.missingAltImages.length} missing alt.` : 'Static image hygiene checked.'] },
		{ name: 'Responsive Craft', score: clampScore(responsiveScore), status: statusOf(clampScore(responsiveScore)), observations: [opts.multiViewport ? opts.multiViewport.summary : 'Run inspect_responsive_layout across mobile/tablet/desktop for rendered proof.'] },
		{ name: 'Accessibility (WCAG 2.1)', score: clampScore(accessibilityScore), status: statusOf(clampScore(accessibilityScore)), observations: [va ? `${va.accessibilityIssues.length} structural a11y issue(s), ${va.contrastViolations.length} contrast issue(s).` : 'Run audit_accessibility on rendered page for full proof.'] },
		{ name: 'Frontend Performance', score: clampScore(performanceScore), status: statusOf(clampScore(performanceScore)), observations: [va ? `${va.performanceMetrics.domNodeCount} DOM nodes, ${(va.performanceMetrics.totalTransferBytes / 1024).toFixed(0)} KB transferred.` : 'Run audit_frontend_performance for runtime timings.'] },
	];

	const overallScore = Math.round(dimensions.reduce((sum, d) => sum + d.score, 0) / dimensions.length);
	const criticalCount = findings.filter(f => f.severity === 'critical').length;
	const majorCount = findings.filter(f => f.severity === 'major').length;
	const grade: DesignCritiqueReport['grade'] =
		overallScore >= 94 && criticalCount === 0 ? 'A+' :
			overallScore >= 86 && criticalCount === 0 ? 'A' :
				overallScore >= 76 ? 'B' :
					overallScore >= 64 ? 'C' :
						overallScore >= 50 ? 'D' : 'F';
	const readyToShip = overallScore >= 82 && criticalCount === 0 && majorCount <= 1;

	const severityRank: Record<DesignAuditFinding['severity'], number> = { critical: 0, major: 1, minor: 2, info: 3 };
	const topPriorities = [...findings].sort((a, b) => severityRank[a.severity] - severityRank[b.severity]).slice(0, 12);

	return {
		overallScore,
		grade,
		readyToShip,
		dimensions,
		topPriorities,
		strengths: [...new Set(strengths)].slice(0, 8),
		verdict: readyToShip
			? `Ready to ship (Grade ${grade}, ${overallScore}/100): visually coherent, responsive, and free of critical defects.`
			: `Refinement required before shipping (Grade ${grade}, ${overallScore}/100): ${criticalCount} critical and ${majorCount} major defect(s) must be repaired and re-verified.`,
	};
}

export function planVisualDefectRepairs(findings: readonly DesignAuditFinding[]): VisualRepairPlan {
	const severityRank: Record<DesignAuditFinding['severity'], number> = { critical: 0, major: 1, minor: 2, info: 3 };
	const sorted = [...findings].sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

	const actions: VisualRepairAction[] = sorted.map((f, idx) => ({
		priority: idx + 1,
		defectId: f.id,
		severity: f.severity,
		target: f.location || f.selector || f.category,
		rootCause: `${f.title}: ${f.detail}`,
		concreteFix: f.fixRecommendation,
		verificationStep: f.category === 'responsive'
			? 'Re-run inspect_responsive_layout across 375px, 768px, and 1440px viewports and confirm 0 horizontal overflow.'
			: f.category === 'accessibility' || f.category === 'color-contrast'
				? 'Re-run audit_accessibility and verify 0 contrast/WCAG violations.'
				: 'Reload rendered app, re-run inspect_visual_quality, and compare_visual_revisions against baseline.',
	}));

	return {
		totalDefects: actions.length,
		criticalCount: actions.filter(a => a.severity === 'critical').length,
		majorCount: actions.filter(a => a.severity === 'major').length,
		actions,
		recheckSequence: [
			'1. Apply targeted CSS/component/asset edits with edit_file or write_file.',
			'2. Reload the live browser page (browser_reload).',
			'3. Re-run inspect_responsive_layout + inspect_visual_quality + audit_accessibility.',
			'4. Run compare_visual_revisions to verify the visual delta and confirm critique_interface_design passes.',
		],
	};
}

// ============================================================================
// 7. CONCISE, HIGH-SIGNAL LLM FORMATTERS
// ============================================================================

export function formatProductAnalysisForLLM(a: ProductDesignAnalysis): string {
	return [
		`# Autonomous Product Design Analysis: ${a.productName}`,
		`Domain: ${a.domain} | Category: ${a.category} | Industry: ${a.industry} (confidence ${Math.round(a.confidence * 100)}%)`,
		`Recommended Visual Directions: ${a.recommendedDirections.join(', ')} | Theme: ${a.recommendedThemeMode}`,
		`Brand Personality: ${a.brandPersonality.join(', ')}`,
		``,
		`## Target Users & Primary Goals`,
		`- Users: ${a.targetUsers.join('; ')}`,
		`- Goals: ${a.primaryGoals.join('; ')}`,
		``,
		`## Required Pages / Views (${a.requiredPages.length})`,
		...a.requiredPages.map(p => `- ${p}`),
		``,
		`## Core Components & Real Interactive Functionality`,
		`- Components: ${a.coreComponents.join(', ')}`,
		...a.interactiveFunctionality.map(fn => `- Real behavior: ${fn}`),
		``,
		`## Visual Asset Needs (${a.assetNeeds.length})`,
		...(a.assetNeeds.length === 0
			? ['- No stock photography required; rely on typography, vector icons, and data visualizations.']
			: a.assetNeeds.map(n => `- [${n.priority}] ${n.slot} (${n.aspectRatio}, ${n.orientation}): query="${n.subjectQuery}" | style=${n.style}`)),
		``,
		`## Accessibility & Responsive Targets`,
		`- Devices: ${a.targetDevices.join(', ')}`,
		...a.accessibilityRequirements.slice(0, 3).map(r => `- ${r}`),
	].join('\n');
}

export function formatDesignBriefForLLM(b: DesignBrief): string {
	return [
		`# Creative Design Brief: ${b.productName} (${b.visualDirectionId})`,
		`Summary: ${b.executiveSummary}`,
		`Audience: ${b.audienceAndContext}`,
		`Creative Direction: ${b.creativeDirection}`,
		`Layout Strategy: ${b.layoutStrategy}`,
		`Imagery Direction: ${b.contentAndImageryDirection}`,
		`Motion & Interaction: ${b.interactionAndMotionDirection}`,
		`Real Functionality Plan:\n${b.functionalIntegrityPlan.map(x => `- ${x}`).join('\n')}`,
		`Quality Benchmarks:\n${b.qualityBenchmarks.map(x => `- ${x}`).join('\n')}`,
		`Avoid:\n${b.avoidList.map(x => `- ${x}`).join('\n')}`,
	].join('\n\n');
}

export function formatColorPaletteForLLM(p: ColorPaletteSpec): string {
	const failed = p.contrastChecks.filter(c => !c.passesAA);
	return [
		`# Color Palette: ${p.name} (default: ${p.defaultTheme})`,
		`Seeds: primary=${p.seedColors.primary}, secondary=${p.seedColors.secondary}, accent=${p.seedColors.accent}, neutral=${p.seedColors.neutral}`,
		`Light Theme: bg=${p.light.background}, surface=${p.light.surface}, text=${p.light.text}, muted=${p.light.textMuted}, primary=${p.light.primary} (fg ${p.light.primaryForeground}), accent=${p.light.accent}, border=${p.light.border}`,
		`Dark Theme: bg=${p.dark.background}, surface=${p.dark.surface}, text=${p.dark.text}, muted=${p.dark.textMuted}, primary=${p.dark.primary} (fg ${p.dark.primaryForeground}), accent=${p.dark.accent}, border=${p.dark.border}`,
		`WCAG Contrast Verification: ${p.allContrastChecksPassAA ? 'ALL 12 PAIRS PASS AA (>=4.5:1)' : `${failed.length} pair(s) below AA`}`,
		...p.contrastChecks.slice(0, 8).map(c => `- ${c.pair}: ${c.ratio}:1 (${c.passesAAA ? 'AAA' : c.passesAA ? 'AA' : 'FAIL'})`),
		`Usage:\n${p.usageGuidelines.map(g => `- ${g}`).join('\n')}`,
	].join('\n');
}

export function formatBrowserVisualAuditForLLM(a: BrowserVisualAuditResult): string {
	return [
		`# Live Browser Visual & Quality Audit: ${a.url} (${a.viewport.width}x${a.viewport.height})`,
		`Title: ${a.title || '(empty)'}${a.loadError ? ` | LOAD ERROR: ${a.loadError}` : ''}`,
		`Runtime Signals: ${a.consoleErrors} console error(s), ${a.networkFailures} network failure(s)`,
		`Layout: overflow=${a.pageMetrics.hasHorizontalOverflow ? `YES (${a.pageMetrics.scrollWidth}px > ${a.viewport.width}px)` : 'NO'}, layoutIssues=${a.layoutIssues.length}, smallTouchTargets=${a.smallTouchTargets.length}`,
		`Imagery: broken=${a.brokenImages.length}, distorted=${a.distortedImages.length}, missingAlt=${a.missingAltImages.length}`,
		`Typography: fonts=[${a.typographyMetrics.fontFamilies.slice(0, 5).join(', ')}], body=${a.typographyMetrics.bodyFontSizePx ?? '?'}px, h1=${a.typographyMetrics.h1FontSizePx ?? '?'}px, headingOrder=${a.typographyMetrics.headingHierarchyValid ? 'valid' : 'INVALID'}`,
		`Accessibility: contrastViolations=${a.contrastViolations.length}, structuralIssues=${a.accessibilityIssues.length}, reducedMotionRule=${a.pageMetrics.hasReducedMotionMediaRule ? 'yes' : 'no'}`,
		`Performance: ${a.performanceMetrics.domNodeCount} DOM nodes (maxDepth ${a.performanceMetrics.maxDomDepth}), ${a.performanceMetrics.resourceCount} resources (${(a.performanceMetrics.totalTransferBytes / 1024).toFixed(1)} KB), DCL=${a.performanceMetrics.domContentLoadedMs ?? '?'}ms, Load=${a.performanceMetrics.loadCompleteMs ?? '?'}ms, CLS=${a.performanceMetrics.cumulativeLayoutShift ?? 0}`,
		...(a.brokenImages.length ? [`Broken Images:\n${a.brokenImages.slice(0, 6).map(i => `- ${i.selector}: ${i.src}`).join('\n')}`] : []),
		...(a.layoutIssues.length ? [`Layout Issues:\n${a.layoutIssues.slice(0, 8).map(i => `- [${i.kind}] ${i.selector}: ${i.detail}`).join('\n')}`] : []),
		...(a.contrastViolations.length ? [`Contrast Violations:\n${a.contrastViolations.slice(0, 6).map(c => `- ${c.selector} ("${c.textSample}"): ${c.ratio}:1 < ${c.required}:1 (${c.foreground} on ${c.background})`).join('\n')}`] : []),
		...(a.accessibilityIssues.length ? [`Accessibility Issues:\n${a.accessibilityIssues.slice(0, 8).map(i => `- [${i.severity}] ${i.rule} (${i.selector}): ${i.detail}`).join('\n')}`] : []),
	].join('\n');
}

export function formatDesignCritiqueForLLM(c: DesignCritiqueReport): string {
	return [
		`# Interface Design Critique: ${c.overallScore}/100 (Grade ${c.grade}) — ${c.readyToShip ? 'READY TO SHIP' : 'NEEDS REFINEMENT'}`,
		c.verdict,
		``,
		`## Dimension Scores`,
		...c.dimensions.map(d => `- ${d.name}: ${d.score}/100 [${d.status}] — ${d.observations.join(' ')}`),
		...(c.topPriorities.length ? [``, `## Priority Defects to Repair (${c.topPriorities.length})`, ...c.topPriorities.map(p => `- [${p.severity.toUpperCase()}][${p.category}] ${p.title}: ${p.detail} -> Fix: ${p.fixRecommendation}`)] : []),
		...(c.strengths.length ? [``, `## Strengths`, ...c.strengths.map(s => `- ${s}`)] : []),
	].join('\n');
}
