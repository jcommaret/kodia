/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Full end-to-end execution-chain integration test for Kodia's Autonomous UI/UX Design Engine:
 *   MODEL REQUEST -> DESIGN TOOL CALL -> ARGUMENT VALIDATION -> TOOL DISPATCH ->
 *   REAL ASSET/DESIGN OPERATION -> VERIFIED RESULT -> MODEL CONTINUATION ->
 *   IMPLEMENTATION -> LIVE CHROMIUM BROWSER RENDERING -> VISUAL/RESPONSIVE/A11Y INSPECTION ->
 *   DEFECT REPAIR -> VISUAL REVISION COMPARISON -> VERIFIED COMPLETION.
 */

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { KODIA_DESIGN_CHANNEL } from '../../common/designIntelligenceTypes.js';
import { KodiaDesignAssetMainService } from '../../electron-main/designAssetMainService.js';
import { createHarness, RecordedRequest, runTurn, ScriptedLLMService, ScriptStep } from './agentHarness.js';
import { startBrowserServiceProcess } from './browserServiceProcess.js';

suite('Kodia - End-to-End Autonomous UI/UX Design Agent Loop', function () {
	this.timeout(90_000);

	let store: DisposableStore;
	let dir: string;
	const p = (rel: string) => path.join(dir, rel);

	setup(() => {
		store = new DisposableStore();
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-design-e2e-')));
	});

	teardown(() => {
		store.dispose();
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	});

	test('full autonomous chain: brief -> palette -> tokens -> bespoke asset -> build storefront -> render -> detect defect -> repair -> visual diff', async () => {
		const { service: browser, stop: stopBrowser } = await startBrowserServiceProcess();
		const designAssets = store.add(new KodiaDesignAssetMainService());
		const appUrl = pathToFileURL(p('index.html')).toString();

		let step = 0;
		let sessionId = '';
		let tabId = '';
		let baselineMobileShot = '';
		let revisedMobileShot = '';

		const lastToolContent = (req: RecordedRequest): string => {
			const last = req.messages[req.messages.length - 1] as { content?: string } | undefined;
			return typeof last?.content === 'string' ? last.content : JSON.stringify(last ?? '');
		};
		const extract = (text: string, regex: RegExp): string => {
			const m = regex.exec(text);
			return m ? m[1] : '';
		};

		const llm = new ScriptedLLMService((_i, req: RecordedRequest): ScriptStep => {
			const payload = JSON.stringify(req.messages);
			// Verify system prompt includes Autonomous UI/UX Design default guidance (in separateSystemMessage or messages[0])
			if (step === 0) {
				const sysCombined = `${req.separateSystemMessage ?? ''}\n${payload}`;
				assert.ok(
					sysCombined.includes('AUTONOMOUS UI/UX DESIGN'),
					'System prompt must include autonomous UI/UX design engineering guidance by default',
				);
			}

			switch (step++) {
				case 0:
					return {
						text: 'Analyzing product requirements and generating creative brief and tokens.',
						toolCalls: [
							{ name: 'analyze_product_design_requirements', params: { product_description: 'Build a modern e-commerce platform for a premium fashion brand called Maison Verve' } },
						],
					};
				case 1:
					assert.match(payload, /fashion_store/, 'Analysis must detect fashion_store');
					return {
						text: '',
						toolCalls: [
							{ name: 'generate_design_tokens', params: { name: 'Maison Verve', product_description: 'Premium fashion brand e-commerce', visual_direction: 'sophisticated-fashion' } },
						],
					};
				case 2:
					assert.match(payload, /ALL 12 CHECKS PASS AA/, 'Generated design tokens must verify WCAG AA contrast');
					return {
						text: '',
						toolCalls: [
							{
								name: 'download_visual_assets',
								params: {
									target_dir: 'images',
									assets: JSON.stringify([
										{ filename: 'hero-coat.svg', alt_text: 'Maison Verve tailored wool coat campaign', svg_subject: 'Maison Verve Editorial', primary_color: '#18181B', secondary_color: '#27272A', accent_color: '#C8A97E', width: 1200, height: 675, svg_style: 'editorial' },
									]),
								},
							},
						],
					};
				case 3:
					assert.match(payload, /\[VERIFIED\] images\/hero-coat\.svg/, 'Downloaded bespoke SVG asset must be verified on disk');
					// Intentionally write v1 with a real mobile overflow defect (width: 900px) so the QA loop detects & repairs it!
					return {
						text: '',
						toolCalls: [
							{
								name: 'write_file',
								params: {
									uri: p('index.html'),
									new_content: `<!DOCTYPE html>
<html lang="en">
<head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Maison Verve</title><style>
body { margin: 0; background: #FAF9F6; color: #111827; font-family: system-ui, sans-serif; font-size: 16px; }
main { width: 900px; margin: 0 auto; padding: 24px 16px; }
h1 { font-size: 2.5rem; }
img { display: block; max-width: 100%; height: auto; aspect-ratio: 16/9; object-fit: cover; }
button { min-height: 44px; padding: 10px 18px; background: #18181B; color: #FFF; border: none; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style></head>
<body>
  <main>
    <h1>Maison Verve</h1>
    <img src="./images/hero-coat.svg" alt="Maison Verve tailored wool coat campaign">
    <button type="button" id="add-bag" onclick="document.getElementById('bag-count').textContent='1'">Add to Bag</button>
    <p>Bag items: <span id="bag-count">0</span></p>
  </main>
</body></html>`,
								},
							},
						],
					};
				case 4:
					return {
						text: '',
						toolCalls: [{ name: 'browser_launch', params: { headless: 'true' } }],
					};
				case 5:
					sessionId = extract(lastToolContent(req), /session ([0-9a-f-]{36})/i);
					assert.ok(sessionId, `Must capture browser sessionId from: ${lastToolContent(req)}`);
					return {
						text: '',
						toolCalls: [{ name: 'browser_new_tab', params: { session_id: sessionId, url: appUrl } }],
					};
				case 6:
					tabId = extract(lastToolContent(req), /Opened tab ([0-9a-f-]{36})/i);
					assert.ok(tabId, `Must capture browser tabId from: ${lastToolContent(req)}`);
					return {
						text: '',
						toolCalls: [{
							name: 'inspect_responsive_layout',
							params: {
								session_id: sessionId,
								tab_id: tabId,
								viewports: JSON.stringify([{ label: 'mobile', width: 375, height: 812 }, { label: 'desktop', width: 1280, height: 800 }]),
							},
						}],
					};
				case 7:
					assert.match(lastToolContent(req), /RESPONSIVE DEFECTS DETECTED/, 'Live Chromium must detect the 900px mobile overflow');
					baselineMobileShot = extract(lastToolContent(req), /mobile \(375x812\)\*\*: screenshot=([^\s|]+?\.png)/);
					assert.ok(baselineMobileShot && fs.existsSync(baselineMobileShot), `Must capture real baseline screenshot path, got "${baselineMobileShot}"`);
					return {
						text: '',
						toolCalls: [{ name: 'repair_visual_defects', params: { session_id: sessionId, tab_id: tabId } }],
					};
				case 8:
					assert.match(lastToolContent(req), /Visual Defect Repair Plan/, 'repair_visual_defects must return prioritized repair plan');
					return {
						text: '',
						toolCalls: [{
							name: 'edit_file',
							params: {
								uri: p('index.html'),
								search_replace_blocks: `<<<<<<< ORIGINAL\nmain { width: 900px; margin: 0 auto; padding: 24px 16px; }\n=======\nmain { max-width: 1120px; width: 100%; box-sizing: border-box; margin: 0 auto; padding: 24px 16px; }\n>>>>>>> UPDATED`,
							},
						}],
					};
				case 9:
					return {
						text: '',
						toolCalls: [{ name: 'browser_reload', params: { session_id: sessionId, tab_id: tabId } }],
					};
				case 10:
					return {
						text: '',
						toolCalls: [{
							name: 'inspect_responsive_layout',
							params: {
								session_id: sessionId,
								tab_id: tabId,
								viewports: JSON.stringify([{ label: 'mobile', width: 375, height: 812 }, { label: 'desktop', width: 1280, height: 800 }]),
							},
						}],
					};
				case 11:
					assert.match(lastToolContent(req), /ALL VIEWPORTS CLEAN/, 'Repaired storefront must pass all viewports with 0 overflow');
					revisedMobileShot = extract(lastToolContent(req), /mobile \(375x812\)\*\*: screenshot=([^\s|]+?\.png)/);
					assert.ok(revisedMobileShot && fs.existsSync(revisedMobileShot), `Must capture real revised screenshot path, got "${revisedMobileShot}"`);
					return {
						text: '',
						toolCalls: [{
							name: 'compare_visual_revisions',
							params: { baseline_path: baselineMobileShot, current_path: revisedMobileShot },
						}],
					};
				case 12:
					assert.match(lastToolContent(req), /Visual comparison \[/, 'compare_visual_revisions must report verified pixel comparison');
					return {
						text: '',
						toolCalls: [{ name: 'critique_interface_design', params: { session_id: sessionId, tab_id: tabId } }],
					};
				default:
					assert.match(lastToolContent(req), /READY TO SHIP/, `Final critique must confirm repaired storefront is ready to ship: ${lastToolContent(req)}`);
					return { text: 'Maison Verve fashion storefront built, verified across mobile and desktop viewports, repaired for overflow, and visually diffed.' };
			}
		});

		try {
			const base = createHarness(dir, llm, store, {
				modelSelection: { providerName: 'openAICompatible', modelName: 'kodia-design-test-model' },
				overridesOfModel: { openAICompatible: { 'kodia-design-test-model': { contextWindow: 128_000, specialToolFormat: 'openai-style' } } },
				globalSettings: { verifyBeforeFinishing: false },
				mainProcessServices: {
					'void-channel-browser': browser,
					[KODIA_DESIGN_CHANNEL]: designAssets,
				},
			});

			await runTurn(base.chat, 'Build a modern e-commerce platform for a premium fashion brand.', 60_000);
			assert.deepStrictEqual(llm.scriptErrors, [], `Script errors: ${llm.scriptErrors.join('\n')}`);
			assert.ok(fs.existsSync(p('index.html')));
			assert.ok(fs.existsSync(p('images/hero-coat.svg')));
			assert.ok(fs.existsSync(p('images/ASSETS_ATTRIBUTION.json')));
		} finally {
			await stopBrowser();
		}
	});
});
