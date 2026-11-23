/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const KODIA_DESIGN_CHANNEL = 'void-channel-design';

// ============================================================================
// Product Categories & Visual Directions
// ============================================================================

export type ProductDomain =
	| 'website'
	| 'ecommerce'
	| 'web_app'
	| 'mobile_app'
	| 'desktop_app'
	| 'game'
	| 'specialized';

export type ProductCategory =
	// Websites
	| 'corporate_website'
	| 'business_website'
	| 'agency_website'
	| 'portfolio_website'
	| 'personal_brand'
	| 'landing_page'
	| 'marketing_website'
	| 'saas_website'
	| 'startup_website'
	| 'educational_website'
	| 'government_website'
	| 'nonprofit_website'
	| 'news_media_website'
	| 'blog_publishing'
	| 'documentation_website'
	| 'community_website'
	| 'membership_website'
	| 'event_website'
	| 'real_estate_website'
	| 'travel_hospitality_website'
	| 'restaurant_website'
	| 'healthcare_website'
	| 'financial_services_website'
	| 'entertainment_website'
	// E-commerce
	| 'online_store'
	| 'fashion_store'
	| 'electronics_store'
	| 'grocery_store'
	| 'beauty_cosmetics_store'
	| 'furniture_store'
	| 'digital_product_store'
	| 'multi_vendor_marketplace'
	| 'b2b_commerce'
	| 'subscription_commerce'
	| 'booking_ordering_platform'
	| 'product_comparison'
	| 'merchant_dashboard'
	// Web applications
	| 'saas_application'
	| 'crm_system'
	| 'erp_system'
	| 'project_management'
	| 'accounting_software'
	| 'hr_platform'
	| 'analytics_platform'
	| 'bi_dashboard'
	| 'admin_system'
	| 'customer_portal'
	| 'financial_dashboard'
	| 'workflow_tool'
	| 'collaboration_platform'
	| 'communication_app'
	| 'ai_application'
	| 'developer_tool'
	| 'enterprise_internal_app'
	// Mobile applications
	| 'mobile_social_app'
	| 'mobile_banking_app'
	| 'mobile_shopping_app'
	| 'mobile_fitness_app'
	| 'mobile_healthcare_app'
	| 'mobile_education_app'
	| 'mobile_travel_app'
	| 'mobile_delivery_app'
	| 'mobile_productivity_app'
	| 'mobile_messaging_app'
	| 'mobile_lifestyle_app'
	// Desktop applications
	| 'desktop_developer_tool'
	| 'desktop_code_editor'
	| 'desktop_productivity'
	| 'desktop_enterprise'
	| 'desktop_creative'
	| 'desktop_financial'
	| 'desktop_media'
	| 'desktop_utility'
	// Games & interactive experiences
	| 'browser_game'
	| 'mobile_game'
	| 'desktop_game'
	| 'strategy_game'
	| 'simulation_game'
	| 'rpg_game'
	| 'action_game'
	| 'puzzle_game'
	| 'educational_game'
	| 'game_launcher_store'
	| 'game_hud_menu'
	// Specialized interfaces
	| 'data_visualization'
	| 'maps_geospatial'
	| 'scientific_app'
	| 'iot_dashboard'
	| 'smart_device_ui'
	| 'automotive_ui'
	| 'industrial_control_panel'
	| 'kiosk_interface'
	| 'tv_application'
	| 'wearable_interface'
	| 'ar_vr_interface'
	| 'accessibility_first_app'
	// Custom / open-ended
	| (string & {});

export type VisualDirectionId =
	| 'premium-minimalism'
	| 'luxury-editorial'
	| 'modern-enterprise'
	| 'high-end-saas'
	| 'contemporary-commerce'
	| 'swiss-editorial'
	| 'editorial-magazine'
	| 'modern-brutalism'
	| 'neo-brutalism'
	| 'glassmorphism'
	| 'soft-neumorphism'
	| 'soft-minimalism'
	| 'dark-premium'
	| 'light-premium'
	| 'material-inspired'
	| 'fluent-inspired'
	| 'apple-restraint'
	| 'high-contrast-editorial'
	| 'modern-dashboard'
	| 'immersive-storytelling'
	| 'experimental-creative'
	| 'futuristic-tech'
	| 'financial-authority'
	| 'elegant-hospitality'
	| 'sophisticated-fashion'
	| 'gaming-immersive';

export type ColorHarmonyStrategy =
	| 'monochromatic'
	| 'neutral-accent'
	| 'complementary'
	| 'analogous'
	| 'split-complementary'
	| 'triadic'
	| 'warm-editorial'
	| 'cool-technical'
	| 'dark-premium';

export type ImageProviderName =
	| 'wikimedia'
	| 'openverse'
	| 'unsplash'
	| 'pexels'
	| 'pixabay'
	| 'local';

export type IconLibraryName =
	| 'lucide'
	| 'heroicons'
	| 'tabler'
	| 'phosphor'
	| 'material-symbols'
	| 'react-icons'
	| 'fontawesome';

export type FrontendFramework =
	| 'react'
	| 'nextjs'
	| 'vue'
	| 'nuxt'
	| 'svelte'
	| 'sveltekit'
	| 'angular'
	| 'astro'
	| 'html-css-js'
	| 'react-native'
	| 'flutter'
	| 'unknown';

export type StylingSystem =
	| 'tailwind'
	| 'css-modules'
	| 'styled-components'
	| 'emotion'
	| 'scss'
	| 'vanilla-css'
	| 'unknown';

export type AccessibilityTarget = 'WCAG_AA' | 'WCAG_AAA';
export type AnimationPreference = 'refined' | 'minimal' | 'expressive' | 'reduced-motion';
export type ImageDownloadPreference = 'download-local' | 'remote-verified' | 'svg-only';
export type AssetLicensePreference = 'permissive-commercial' | 'attribution-ok' | 'any-verified';

// ============================================================================
// Settings & Persistent Brand System
// ============================================================================

export interface DesignIntelligenceSettings {
	readonly autoDesignIntelligence: boolean;
	readonly autoAssetDiscovery: boolean;
	readonly imageDownloadPreference: ImageDownloadPreference;
	readonly approvedImageProviders: readonly ImageProviderName[];
	readonly imageProviderApiKeys: Partial<Record<'unsplash' | 'pexels' | 'pixabay', string>>;
	readonly preferredStyleDirection: VisualDirectionId | 'auto';
	readonly enableVisualQualityChecks: boolean;
	readonly enableResponsiveTesting: boolean;
	readonly enableVisualRegression: boolean;
	readonly enableAccessibilityChecks: boolean;
	readonly accessibilityTarget: AccessibilityTarget;
	readonly animationPreference: AnimationPreference;
	readonly assetLicensePreference: AssetLicensePreference;
}

export const DEFAULT_DESIGN_INTELLIGENCE_SETTINGS: DesignIntelligenceSettings = {
	autoDesignIntelligence: true,
	autoAssetDiscovery: true,
	imageDownloadPreference: 'download-local',
	approvedImageProviders: ['local', 'wikimedia', 'openverse', 'unsplash', 'pexels', 'pixabay'],
	imageProviderApiKeys: {},
	preferredStyleDirection: 'auto',
	enableVisualQualityChecks: true,
	enableResponsiveTesting: true,
	enableVisualRegression: true,
	enableAccessibilityChecks: true,
	accessibilityTarget: 'WCAG_AA',
	animationPreference: 'refined',
	assetLicensePreference: 'attribution-ok',
};

export interface BrandSystemProfile {
	readonly brandName: string;
	readonly tagline?: string;
	readonly industry?: string;
	readonly preferredDirection?: VisualDirectionId;
	readonly primaryColor?: string;
	readonly secondaryColor?: string;
	readonly accentColor?: string;
	readonly neutralBase?: string;
	readonly headingFont?: string;
	readonly bodyFont?: string;
	readonly monoFont?: string;
	readonly logoPath?: string;
	readonly themeMode?: 'light' | 'dark' | 'both';
	readonly accessibilityTarget?: AccessibilityTarget;
	readonly imageStyleNotes?: string;
	readonly componentStandards?: string;
	readonly restrictions?: readonly string[];
	readonly updatedAt: string;
}

// ============================================================================
// Autonomous Design Analysis, Brief, Direction, Color, Tokens, Layout
// ============================================================================

export interface UserJourneySpec {
	readonly name: string;
	readonly actor: string;
	readonly steps: readonly string[];
	readonly conversionOrOutcome: string;
}

export interface RequiredAssetNeed {
	readonly slot: string;
	readonly purpose: string;
	readonly subjectQuery: string;
	readonly style: string;
	readonly aspectRatio: string;
	readonly orientation: 'landscape' | 'portrait' | 'square';
	readonly altTextTemplate: string;
	readonly priority: 'essential' | 'recommended';
}

export interface ProductDesignAnalysis {
	readonly productName: string;
	readonly summary: string;
	readonly domain: ProductDomain;
	readonly category: ProductCategory;
	readonly industry: string;
	readonly confidence: number;
	readonly targetUsers: readonly string[];
	readonly primaryGoals: readonly string[];
	readonly userJourneys: readonly UserJourneySpec[];
	readonly informationArchitecture: readonly string[];
	readonly requiredPages: readonly string[];
	readonly coreComponents: readonly string[];
	readonly interactiveFunctionality: readonly string[];
	readonly assetNeeds: readonly RequiredAssetNeed[];
	readonly targetDevices: readonly string[];
	readonly accessibilityRequirements: readonly string[];
	readonly performanceRequirements: readonly string[];
	readonly motionRequirements: readonly string[];
	readonly recommendedDirections: readonly VisualDirectionId[];
	readonly recommendedThemeMode: 'light' | 'dark' | 'both';
	readonly brandPersonality: readonly string[];
}

export interface DesignBrief {
	readonly id: string;
	readonly createdAt: string;
	readonly productName: string;
	readonly category: ProductCategory;
	readonly domain: ProductDomain;
	readonly executiveSummary: string;
	readonly audienceAndContext: string;
	readonly creativeDirection: string;
	readonly visualDirectionId: VisualDirectionId;
	readonly layoutStrategy: string;
	readonly contentAndImageryDirection: string;
	readonly interactionAndMotionDirection: string;
	readonly functionalIntegrityPlan: readonly string[];
	readonly qualityBenchmarks: readonly string[];
	readonly avoidList: readonly string[];
}

export interface VisualDirectionSpec {
	readonly id: VisualDirectionId;
	readonly name: string;
	readonly rationale: string;
	readonly aestheticKeywords: readonly string[];
	readonly colorMood: string;
	readonly typographyCharacter: string;
	readonly layoutPhilosophy: string;
	readonly surfaceTreatment: string;
	readonly elevationStrategy: string;
	readonly borderRadiusStyle: string;
	readonly motionCharacter: string;
	readonly visualTreatmentsToUse: readonly string[];
	readonly visualTreatmentsToAvoid: readonly string[];
	readonly appropriateFor: readonly string[];
	readonly unsuitableFor: readonly string[];
}

export interface ContrastCheckResult {
	readonly pair: string;
	readonly foreground: string;
	readonly background: string;
	readonly ratio: number;
	readonly passesAA: boolean;
	readonly passesAALarge: boolean;
	readonly passesAAA: boolean;
}

export interface ThemeColorTokens {
	readonly background: string;
	readonly backgroundSubtle: string;
	readonly surface: string;
	readonly surfaceElevated: string;
	readonly surfaceHover: string;
	readonly border: string;
	readonly borderStrong: string;
	readonly text: string;
	readonly textSecondary: string;
	readonly textMuted: string;
	readonly primary: string;
	readonly primaryHover: string;
	readonly primaryForeground: string;
	readonly secondary: string;
	readonly secondaryForeground: string;
	readonly accent: string;
	readonly accentForeground: string;
	readonly focusRing: string;
	readonly success: string;
	readonly warning: string;
	readonly error: string;
	readonly info: string;
	readonly heroGradient: string;
	readonly surfaceGlow: string;
	readonly shadowSm: string;
	readonly shadowMd: string;
	readonly shadowLg: string;
}

export interface ColorPaletteSpec {
	readonly name: string;
	readonly harmony: ColorHarmonyStrategy;
	readonly direction: VisualDirectionId;
	readonly defaultTheme: 'light' | 'dark';
	readonly seedColors: {
		readonly primary: string;
		readonly secondary: string;
		readonly accent: string;
		readonly neutral: string;
	};
	readonly light: ThemeColorTokens;
	readonly dark: ThemeColorTokens;
	readonly contrastChecks: readonly ContrastCheckResult[];
	readonly allContrastChecksPassAA: boolean;
	readonly usageGuidelines: readonly string[];
}

export interface TypographyScaleStep {
	readonly token: string;
	readonly role: string;
	readonly sizeClamp: string;
	readonly lineHeight: string;
	readonly weight: number;
	readonly letterSpacing: string;
}

export interface TypographyRecommendation {
	readonly id: string;
	readonly pairingName: string;
	readonly displayFont: string;
	readonly bodyFont: string;
	readonly monoFont: string;
	readonly googleFontsUrl: string;
	readonly fontStacks: {
		readonly display: string;
		readonly body: string;
		readonly mono: string;
	};
	readonly scale: readonly TypographyScaleStep[];
	readonly rationale: string;
	readonly bestPractices: readonly string[];
}

export interface DesignTokensSpec {
	readonly name: string;
	readonly visualDirection: VisualDirectionId;
	readonly palette: ColorPaletteSpec;
	readonly typography: TypographyRecommendation;
	readonly spacing: Readonly<Record<string, string>>;
	readonly radii: Readonly<Record<string, string>>;
	readonly breakpoints: Readonly<Record<string, string>>;
	readonly motion: {
		readonly durationFast: string;
		readonly durationNormal: string;
		readonly durationSlow: string;
		readonly easingStandard: string;
		readonly easingEmphasized: string;
		readonly reducedMotionRule: string;
	};
	readonly zIndex: Readonly<Record<string, number>>;
	readonly cssVariables: string;
	readonly tailwindExtendSnippet: string;
	readonly w3cTokensJson: string;
}

export interface PageSectionSpec {
	readonly id: string;
	readonly name: string;
	readonly purpose: string;
	readonly layoutPattern: string;
	readonly components: readonly string[];
	readonly dataAndInteractions: readonly string[];
	readonly assetSlots: readonly string[];
}

export interface PageBlueprint {
	readonly name: string;
	readonly route: string;
	readonly purpose: string;
	readonly primaryCta: string;
	readonly navigationRole: 'primary' | 'secondary' | 'utility' | 'admin';
	readonly sections: readonly PageSectionSpec[];
	readonly statesRequired: readonly ('default' | 'loading' | 'empty' | 'error' | 'filtered')[];
}

export interface PageArchitectureSpec {
	readonly productName: string;
	readonly category: ProductCategory;
	readonly navigationPattern: string;
	readonly mobileNavigationPattern: string;
	readonly pages: readonly PageBlueprint[];
	readonly sharedShellComponents: readonly string[];
	readonly stateAndDataFlows: readonly string[];
}

export interface ResponsiveBreakpointRule {
	readonly name: 'mobile-sm' | 'mobile-lg' | 'tablet-portrait' | 'tablet-landscape' | 'laptop' | 'desktop' | 'ultrawide';
	readonly minWidthPx: number;
	readonly maxWidthPx?: number;
	readonly columns: number;
	readonly containerPadding: string;
	readonly gutter: string;
	readonly navigationBehavior: string;
	readonly layoutTransformations: readonly string[];
}

export interface ResponsiveLayoutSpec {
	readonly strategy: string;
	readonly maxContentWidth: string;
	readonly breakpoints: readonly ResponsiveBreakpointRule[];
	readonly cssFoundation: string;
	readonly mobileTransformations: readonly string[];
	readonly touchAndSafeAreaRules: readonly string[];
	readonly containerQueryPatterns: readonly string[];
	readonly overflowPreventionChecklist: readonly string[];
}

export interface IconLibraryRecommendation {
	readonly detectedExistingLibraries: readonly IconLibraryName[];
	readonly recommendedLibrary: IconLibraryName;
	readonly reuseExisting: boolean;
	readonly packageName: string;
	readonly installCommand?: string;
	readonly strokeWidth: string;
	readonly sizingScale: Readonly<Record<string, string>>;
	readonly recommendedIconsBySlot: Readonly<Record<string, string>>;
	readonly accessibilityRules: readonly string[];
}

export interface ComponentRecommendation {
	readonly name: string;
	readonly category: 'card' | 'button' | 'navigation' | 'form' | 'data-display' | 'overlay' | 'feedback' | 'media' | 'layout';
	readonly priority: 'essential' | 'recommended' | 'optional';
	readonly variants: readonly string[];
	readonly interactiveStates: readonly string[];
	readonly visualTreatment: string;
	readonly accessibilityRequirements: readonly string[];
	readonly responsiveBehavior: string;
}

export interface ComponentVariantSpec {
	readonly componentType: string;
	readonly framework: FrontendFramework;
	readonly stylingSystem: StylingSystem;
	readonly visualDirection: VisualDirectionId;
	readonly variants: readonly {
		readonly name: string;
		readonly usage: string;
		readonly classesOrTokens: string;
		readonly states: readonly string[];
	}[];
	readonly implementationSnippet: string;
	readonly accessibilityChecklist: readonly string[];
}

// ============================================================================
// Visual Assets (Discovery, Download, Optimization)
// ============================================================================

export interface VisualAssetCandidate {
	readonly id: string;
	readonly provider: ImageProviderName | 'generated-svg';
	readonly title: string;
	readonly url: string;
	readonly thumbnailUrl?: string;
	readonly width?: number;
	readonly height?: number;
	readonly aspectRatio?: string;
	readonly mimeType?: string;
	readonly license: string;
	readonly licenseUrl?: string;
	readonly attribution?: string;
	readonly author?: string;
	readonly sourcePageUrl?: string;
	readonly isLocal: boolean;
	readonly localPath?: string;
	readonly altTextSuggestion: string;
	readonly verified: boolean;
}

export interface ProviderSearchStatus {
	readonly provider: ImageProviderName;
	readonly status: 'succeeded' | 'skipped_no_key' | 'skipped_disabled' | 'failed';
	readonly count: number;
	readonly message?: string;
}

export interface VisualAssetSearchResult {
	readonly query: string;
	readonly orientation?: 'landscape' | 'portrait' | 'square';
	readonly assets: readonly VisualAssetCandidate[];
	readonly providerStatuses: readonly ProviderSearchStatus[];
	readonly fallbackRecommendation?: string;
}

export interface DownloadedVisualAsset {
	readonly sourceUrl: string;
	readonly localPath: string;
	readonly relativePath: string;
	readonly provider: ImageProviderName | 'generated-svg';
	readonly mimeType: string;
	readonly sizeBytes: number;
	readonly width?: number;
	readonly height?: number;
	readonly license: string;
	readonly attribution?: string;
	readonly altText: string;
	readonly verifiedOnDisk: boolean;
	readonly error?: string;
}

export interface AssetOptimizationEntry {
	readonly filePath: string;
	readonly originalBytes: number;
	readonly optimizedBytes: number;
	readonly savedBytes: number;
	readonly format: string;
	readonly width?: number;
	readonly height?: number;
	readonly action: 'minified-svg' | 'verified-optimal' | 'needs-resize-warning' | 'missing-or-unreadable';
	readonly recommendation?: string;
	readonly responsiveMarkupHint?: string;
}

export interface AssetOptimizationReport {
	readonly scannedCount: number;
	readonly optimizedCount: number;
	readonly totalSavedBytes: number;
	readonly warnings: readonly string[];
	readonly entries: readonly AssetOptimizationEntry[];
}

// ============================================================================
// Static Design System Inspection, Consistency Audit & Live Browser Visual QA
// ============================================================================

export interface ExistingDesignSystemReport {
	readonly framework: FrontendFramework;
	readonly stylingSystem: StylingSystem;
	readonly detectedIconLibraries: readonly IconLibraryName[];
	readonly detectedAnimationLibraries: readonly string[];
	readonly detectedFonts: readonly string[];
	readonly cssVariablesCount: number;
	readonly sampleCssVariables: readonly string[];
	readonly detectedColors: readonly string[];
	readonly tailwindConfigPath?: string;
	readonly designTokenFiles: readonly string[];
	readonly componentFilesCount: number;
	readonly imageAssetsCount: number;
	readonly hasDarkThemeSupport: boolean;
	readonly hasReducedMotionSupport: boolean;
	readonly summary: string;
}

export interface DesignAuditFinding {
	readonly id: string;
	readonly severity: 'critical' | 'major' | 'minor' | 'info';
	readonly category: 'hierarchy' | 'color-contrast' | 'typography' | 'spacing' | 'responsive' | 'accessibility' | 'imagery' | 'icons' | 'consistency' | 'performance' | 'interaction' | 'layout';
	readonly title: string;
	readonly detail: string;
	readonly location?: string;
	readonly selector?: string;
	readonly fixRecommendation: string;
}

export interface DesignConsistencyAuditReport {
	readonly score: number;
	readonly filesScanned: number;
	readonly uniqueHexColors: number;
	readonly cssVariableUsageCount: number;
	readonly hardcodedColorCount: number;
	readonly findings: readonly DesignAuditFinding[];
	readonly strengths: readonly string[];
	readonly summary: string;
}

export interface BrowserVisualAuditResult {
	readonly url: string;
	readonly title: string;
	readonly viewport: { readonly width: number; readonly height: number };
	readonly loadError?: string;
	readonly consoleErrors: number;
	readonly networkFailures: number;
	readonly brokenImages: readonly { readonly src: string; readonly alt: string; readonly selector: string }[];
	readonly distortedImages: readonly { readonly src: string; readonly naturalRatio: number; readonly renderedRatio: number; readonly selector: string }[];
	readonly missingAltImages: readonly { readonly src: string; readonly selector: string }[];
	readonly contrastViolations: readonly { readonly selector: string; readonly textSample: string; readonly foreground: string; readonly background: string; readonly ratio: number; readonly required: number }[];
	readonly accessibilityIssues: readonly { readonly rule: string; readonly severity: 'critical' | 'major' | 'minor'; readonly selector: string; readonly detail: string }[];
	readonly layoutIssues: readonly { readonly kind: string; readonly selector: string; readonly detail: string }[];
	readonly smallTouchTargets: readonly { readonly selector: string; readonly width: number; readonly height: number; readonly label: string }[];
	readonly typographyMetrics: {
		readonly fontFamilies: readonly string[];
		readonly loadedFontCount: number;
		readonly bodyFontSizePx: number | null;
		readonly h1FontSizePx: number | null;
		readonly headingHierarchyValid: boolean;
		readonly headingCounts: Readonly<Record<string, number>>;
	};
	readonly performanceMetrics: {
		readonly domNodeCount: number;
		readonly maxDomDepth: number;
		readonly ttfbMs: number | null;
		readonly domContentLoadedMs: number | null;
		readonly loadCompleteMs: number | null;
		readonly resourceCount: number;
		readonly totalTransferBytes: number;
		readonly largestResources: readonly { readonly name: string; readonly type: string; readonly bytes: number; readonly durationMs: number }[];
		readonly cumulativeLayoutShift: number | null;
	};
	readonly pageMetrics: {
		readonly scrollWidth: number;
		readonly scrollHeight: number;
		readonly hasHorizontalOverflow: boolean;
		readonly visibleTextLength: number;
		readonly interactiveElementCount: number;
		readonly hasReducedMotionMediaRule: boolean;
	};
}

export interface ViewportScreenshotCapture {
	readonly label: string;
	readonly width: number;
	readonly height: number;
	readonly path: string;
	readonly dataUrl: string;
	readonly hasHorizontalOverflow: boolean;
	readonly layoutIssueCount: number;
	readonly brokenImageCount: number;
	readonly smallTouchTargetCount: number;
	readonly audit: BrowserVisualAuditResult;
}

export interface MultiViewportAuditResult {
	readonly url: string;
	readonly title: string;
	readonly capturedAt: string;
	readonly captures: readonly ViewportScreenshotCapture[];
	readonly allViewportsClean: boolean;
	readonly summary: string;
}

export interface DesignCritiqueDimension {
	readonly name: string;
	readonly score: number;
	readonly status: 'excellent' | 'good' | 'needs-work' | 'critical';
	readonly observations: readonly string[];
}

export interface DesignCritiqueReport {
	readonly overallScore: number;
	readonly grade: 'A+' | 'A' | 'B' | 'C' | 'D' | 'F';
	readonly readyToShip: boolean;
	readonly dimensions: readonly DesignCritiqueDimension[];
	readonly topPriorities: readonly DesignAuditFinding[];
	readonly strengths: readonly string[];
	readonly verdict: string;
}

export interface VisualRepairAction {
	readonly priority: number;
	readonly defectId: string;
	readonly severity: 'critical' | 'major' | 'minor' | 'info';
	readonly target: string;
	readonly rootCause: string;
	readonly concreteFix: string;
	readonly verificationStep: string;
}

export interface VisualRepairPlan {
	readonly totalDefects: number;
	readonly criticalCount: number;
	readonly majorCount: number;
	readonly actions: readonly VisualRepairAction[];
	readonly recheckSequence: readonly string[];
}

export interface VisualRevisionComparison {
	readonly baselinePath: string;
	readonly currentPath: string;
	readonly diffImagePath?: string;
	readonly baselineSize: { readonly width: number; readonly height: number };
	readonly currentSize: { readonly width: number; readonly height: number };
	readonly dimensionsMatch: boolean;
	readonly totalPixelsCompared: number;
	readonly changedPixels: number;
	readonly diffPercentage: number;
	readonly changedRegion?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
	readonly verdict: 'identical' | 'minor-change' | 'moderate-change' | 'major-change' | 'dimension-mismatch' | 'error';
	readonly summary: string;
	readonly error?: string;
}

// ============================================================================
// Design Knowledge Library Search Entry
// ============================================================================

export interface DesignKnowledgeEntry {
	readonly id: string;
	readonly topic: 'principle' | 'industry' | 'layout' | 'component' | 'responsive' | 'accessibility' | 'typography' | 'color' | 'imagery' | 'interaction' | 'motion' | 'anti-pattern' | 'framework';
	readonly title: string;
	readonly summary: string;
	readonly guidance: readonly string[];
	readonly tags: readonly string[];
}

// ============================================================================
// Electron Main-Process Design Asset & Visual Comparison IPC Service
// ============================================================================

export interface IDesignAssetMainService {
	readonly _serviceBrand: undefined;

	searchImageProviders(opts: {
		query: string;
		workspaceRoot?: string;
		providers?: readonly ImageProviderName[];
		apiKeys?: Partial<Record<'unsplash' | 'pexels' | 'pixabay', string>>;
		orientation?: 'landscape' | 'portrait' | 'square';
		limit?: number;
		licensePreference?: AssetLicensePreference;
	}): Promise<VisualAssetSearchResult>;

	downloadVisualAssets(opts: {
		workspaceRoot: string;
		targetDir?: string;
		assets: readonly {
			url?: string;
			filename?: string;
			altText: string;
			provider?: ImageProviderName | 'generated-svg';
			license?: string;
			attribution?: string;
			generateSvgFallback?: {
				subject: string;
				primaryColor?: string;
				secondaryColor?: string;
				accentColor?: string;
				width?: number;
				height?: number;
				style?: 'abstract' | 'editorial' | 'product-backdrop' | 'mesh-gradient' | 'geometric';
			};
		}[];
	}): Promise<{ downloaded: DownloadedVisualAsset[]; attributionManifestPath?: string }>;

	optimizeVisualAssets(opts: {
		workspaceRoot: string;
		targetPaths?: readonly string[];
		minifySvgs?: boolean;
	}): Promise<AssetOptimizationReport>;

	compareVisualRevisions(opts: {
		baselinePath: string;
		currentPath: string;
		diffOutputPath?: string;
		pixelThreshold?: number;
	}): Promise<VisualRevisionComparison>;
}

export const IDesignAssetMainService = createDecorator<IDesignAssetMainService>('kodiaDesignAssetMainService');
