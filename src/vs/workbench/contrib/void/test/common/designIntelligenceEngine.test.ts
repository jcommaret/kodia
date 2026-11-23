/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	analyzeProductDesignRequirements,
	auditDesignConsistency,
	critiqueInterfaceDesign,
	generateColorPalette,
	generateComponentVariants,
	generateDesignBrief,
	generateDesignTokens,
	generatePageArchitecture,
	generateResponsiveLayout,
	generateVisualDirection,
	inspectExistingDesignSystem,
	planVisualDefectRepairs,
	recommendIconLibrary,
	recommendUiComponents,
} from '../../common/designIntelligenceEngine.js';
import {
	buildTypographyRecommendation,
	ensureContrast,
	getContrastRatio,
	searchDesignKnowledge,
	VISUAL_DIRECTIONS,
} from '../../common/designKnowledgeLibrary.js';
import { builtinTools } from '../../common/prompt/prompts.js';
import { getToolCategory, getToolDisplayTitles } from '../../common/toolDisplayMeta.js';
import { assessRisk } from '../../common/autonomyPolicy.js';

const ALL_25_DESIGN_TOOLS = [
	'analyze_product_design_requirements',
	'generate_design_brief',
	'generate_visual_direction',
	'generate_color_palette',
	'generate_design_tokens',
	'generate_page_architecture',
	'generate_responsive_layout',
	'discover_visual_assets',
	'search_image_providers',
	'download_visual_assets',
	'optimize_visual_assets',
	'discover_icon_library',
	'recommend_typography',
	'recommend_ui_components',
	'generate_component_variants',
	'inspect_existing_design_system',
	'audit_design_consistency',
	'inspect_responsive_layout',
	'capture_application_screenshots',
	'inspect_visual_quality',
	'audit_accessibility',
	'audit_frontend_performance',
	'critique_interface_design',
	'repair_visual_defects',
	'compare_visual_revisions',
] as const;

suite('Kodia - Autonomous UI/UX Design Intelligence Engine', () => {
	test('registers all 25 mandated design tools with schemas, display metadata, category, and autonomy risk', () => {
		for (const toolName of ALL_25_DESIGN_TOOLS) {
			assert.ok(toolName in builtinTools, `Missing tool schema in builtinTools: ${toolName}`);
			const titles = getToolDisplayTitles(toolName);
			assert.ok(titles.done && titles.proposed && titles.running, `Missing display titles for ${toolName}`);
			assert.strictEqual(getToolCategory(toolName), 'design', `Expected design category for ${toolName}`);
			const risk = assessRisk(toolName, {});
			if (toolName === 'download_visual_assets' || toolName === 'optimize_visual_assets') {
				assert.strictEqual(risk, 'medium');
			} else {
				assert.strictEqual(risk, 'low', `Expected low risk for ${toolName}`);
			}
		}
	});

	test('recognizes diverse digital product categories across all 7 domains from short prompts', () => {
		const cases: Array<[string, string, string]> = [
			['Build a modern e-commerce platform for a premium fashion brand', 'ecommerce', 'fashion_store'],
			['Create a fintech banking dashboard for wealth management', 'web_app', 'financial_dashboard'],
			['Design a fine dining Italian restaurant website with table booking', 'website', 'restaurant_website'],
			['Build a calm healthcare telehealth clinic portal for patients', 'website', 'healthcare_website'],
			['Create a real-time analytics BI dashboard for SaaS metrics', 'web_app', 'analytics_platform'],
			['Build a cross-platform iOS and Android fitness habit tracker mobile app', 'mobile_app', 'mobile_lifestyle_app'],
			['Create an Electron desktop productivity notes workspace app', 'desktop_app', 'desktop_productivity'],
			['Build a browser strategy RPG game with HUD and inventory', 'game', 'browser_game'],
			['Design an industrial IoT smart home sensor control panel', 'specialized', 'iot_dashboard'],
		];

		for (const [prompt, expectedDomain, expectedCategory] of cases) {
			const analysis = analyzeProductDesignRequirements({ productDescription: prompt });
			assert.strictEqual(analysis.domain, expectedDomain, `Prompt "${prompt}" domain mismatch`);
			assert.strictEqual(analysis.category, expectedCategory, `Prompt "${prompt}" category mismatch`);
			assert.ok(analysis.requiredPages.length >= 4, `Prompt "${prompt}" should plan complete pages`);
			assert.ok(analysis.interactiveFunctionality.length >= 3, `Prompt "${prompt}" should specify real functionality`);
			assert.ok(analysis.recommendedDirections.length >= 2);
		}
	});

	test('WCAG 2.1 contrast math guarantees AA (>=4.5:1) accessible palettes even from challenging seed colors', () => {
		assert.ok(getContrastRatio('#000000', '#FFFFFF') >= 20.9);
		assert.strictEqual(getContrastRatio('#FFFFFF', '#FFFFFF'), 1);

		const adjustedOnWhite = ensureContrast('#FACC15', '#FFFFFF', 4.5);
		assert.ok(getContrastRatio(adjustedOnWhite, '#FFFFFF') >= 4.5, 'Yellow adjusted on white must reach AA');

		for (const seed of ['#FFEE00', '#9CA3AF', '#18181B', '#6366F1', '#0D6E6E', '#E11D48']) {
			const palette = generateColorPalette({
				productDescription: 'Premium SaaS product',
				brandPrimaryColor: seed,
				harmony: 'split-complementary',
			});
			assert.strictEqual(palette.allContrastChecksPassAA, true, `Seed ${seed} failed AA check: ${JSON.stringify(palette.contrastChecks.filter(c => !c.passesAA))}`);
			assert.strictEqual(palette.contrastChecks.length, 12);
		}
	});

	test('generates complete design brief, 26 visual directions, tokens, typography, page architecture, responsive rules, and component variants', () => {
		assert.strictEqual(Object.keys(VISUAL_DIRECTIONS).length, 26);

		const brief = generateDesignBrief({
			productDescription: 'Build a modern e-commerce platform for a premium fashion brand called Atelier Nord',
		});
		assert.strictEqual(brief.productName, 'Atelier Nord');
		assert.ok(brief.visualDirectionId === 'sophisticated-fashion' || brief.visualDirectionId === 'luxury-editorial');
		assert.ok(brief.avoidList.length >= 4);

		const dir = generateVisualDirection({ productDescription: 'Luxury hotel and spa resort' });
		assert.ok(dir.visualTreatmentsToUse.length > 0 && dir.visualTreatmentsToAvoid.length > 0);

		const tokens = generateDesignTokens({
			productDescription: 'Modern fashion e-commerce platform',
			visualDirection: 'sophisticated-fashion',
		});
		assert.ok(tokens.cssVariables.includes('--color-primary:'));
		assert.ok(tokens.cssVariables.includes('prefers-reduced-motion'));
		assert.ok(tokens.tailwindExtendSnippet.includes('var(--color-primary)'));
		assert.ok(JSON.parse(tokens.w3cTokensJson).direction === 'sophisticated-fashion');

		const typo = buildTypographyRecommendation('luxury-editorial');
		assert.ok(typo.googleFontsUrl.startsWith('https://fonts.googleapis.com/css2?'));
		assert.ok(typo.scale.some(s => s.sizeClamp.includes('clamp(')));

		const arch = generatePageArchitecture({ productDescription: 'Modern e-commerce fashion store' });
		assert.ok(arch.pages.some(p => p.route === '/'));
		assert.ok(arch.pages.length >= 5);

		const resp = generateResponsiveLayout({ productDescription: 'Modern e-commerce fashion store' });
		assert.strictEqual(resp.breakpoints.length, 7);
		assert.ok(resp.cssFoundation.includes('@container'));
		assert.ok(resp.cssFoundation.includes('safe-area-inset-bottom'));

		const comps = recommendUiComponents({ productDescription: 'Online fashion store' });
		assert.ok(comps.some(c => c.category === 'card') && comps.some(c => c.category === 'button'));

		const btnVariants = generateComponentVariants({ componentType: 'button', framework: 'react', stylingSystem: 'tailwind' });
		assert.ok(btnVariants.variants.some(v => v.name === 'primary') && btnVariants.implementationSnippet.includes('focus-visible'));
	});

	test('detects existing icon library & design system, audits consistency defects, critiques, and plans repairs', () => {
		const iconRec = recommendIconLibrary({ existingDependencies: ['react', 'tailwindcss', 'lucide-react'], framework: 'react' });
		assert.strictEqual(iconRec.recommendedLibrary, 'lucide');
		assert.strictEqual(iconRec.reuseExisting, true);
		assert.strictEqual(iconRec.installCommand, undefined);

		const sampleFiles = [
			{
				path: 'package.json',
				content: JSON.stringify({ dependencies: { react: '^19.0.0', tailwindcss: '^4.0.0', 'lucide-react': '^0.500.0', 'framer-motion': '^12.0.0' } }),
			},
			{
				path: 'src/App.tsx',
				content: `
					export function App() {
						return (
							<div>
								<nav><a href="/">🚀 Home</a></nav>
								<img src="https://via.placeholder.com/400x300" />
								<p>Lorem ipsum dolor sit amet</p>
							</div>
						);
					}
				`,
			},
			{
				path: 'src/app.css',
				content: `button:focus { outline: none; } .card { color: #111111; background: #ffffff; }`,
			},
		];

		const existing = inspectExistingDesignSystem(sampleFiles);
		assert.strictEqual(existing.framework, 'react');
		assert.strictEqual(existing.stylingSystem, 'tailwind');
		assert.deepStrictEqual(existing.detectedIconLibraries, ['lucide']);
		assert.deepStrictEqual(existing.detectedAnimationLibraries, ['framer-motion']);

		const audit = auditDesignConsistency(sampleFiles);
		assert.ok(audit.score < 80, `Expected low score for flawed files, got ${audit.score}`);
		assert.ok(audit.findings.some(f => f.title.includes('missing alt')));
		assert.ok(audit.findings.some(f => f.title.includes('placeholder')));
		assert.ok(audit.findings.some(f => f.title.includes('Lorem ipsum')));
		assert.ok(audit.findings.some(f => f.title.includes('Focus outline')));
		assert.ok(audit.findings.some(f => f.title.includes('Emoji')));

		const critique = critiqueInterfaceDesign({ staticAudit: audit });
		assert.strictEqual(critique.readyToShip, false);
		assert.ok(critique.topPriorities.length >= 4);

		const repairPlan = planVisualDefectRepairs(critique.topPriorities);
		assert.ok(repairPlan.totalDefects >= 4);
		assert.ok(repairPlan.actions[0].concreteFix.length > 10);
	});

	test('searches permanent design knowledge library by topic and keywords', () => {
		const a11y = searchDesignKnowledge('contrast keyboard', 'accessibility');
		assert.ok(a11y.length >= 1);
		const resp = searchDesignKnowledge('mobile touch overflow');
		assert.ok(resp.some(e => e.topic === 'responsive'));
	});
});
