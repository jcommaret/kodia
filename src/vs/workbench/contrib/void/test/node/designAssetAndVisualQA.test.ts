/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
	decodePngToRgba,
	encodeRgbaToPng,
	inspectImageDimensions,
	KodiaDesignAssetMainService,
} from '../../electron-main/designAssetMainService.js';
import { KodiaBrowserMainService } from '../../electron-main/browserMainService.js';
import { critiqueInterfaceDesign, planVisualDefectRepairs } from '../../common/designIntelligenceEngine.js';

function createSolidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
	const buf = new Uint8Array(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		buf[i * 4] = rgba[0];
		buf[i * 4 + 1] = rgba[1];
		buf[i * 4 + 2] = rgba[2];
		buf[i * 4 + 3] = rgba[3];
	}
	return encodeRgbaToPng(width, height, buf);
}

suite('Kodia - Design Asset Main Service & Real Browser Visual QA', function () {
	this.timeout(90_000);

	let dir: string;
	let assetService: KodiaDesignAssetMainService;

	setup(() => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-design-qa-')));
		assetService = new KodiaDesignAssetMainService();
	});

	teardown(() => {
		assetService.dispose();
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	});

	test('generates bespoke SVG assets, writes attribution manifest, scans local assets, and optimizes SVGs', async () => {
		const res = await assetService.downloadVisualAssets({
			workspaceRoot: dir,
			targetDir: 'public/images',
			assets: [
				{
					filename: 'hero-atelier.svg',
					altText: 'Atelier Nord autumn collection editorial backdrop',
					generateSvgFallback: {
						subject: 'Atelier Nord editorial collection',
						primaryColor: '#18181B',
						secondaryColor: '#3F3F46',
						accentColor: '#D4A373',
						width: 1200,
						height: 675,
						style: 'editorial',
					},
				},
			],
		});

		assert.strictEqual(res.downloaded.length, 1);
		assert.strictEqual(res.downloaded[0].verifiedOnDisk, true);
		assert.strictEqual(res.downloaded[0].width, 1200);
		assert.strictEqual(res.downloaded[0].height, 675);
		assert.ok(fs.existsSync(res.downloaded[0].localPath));
		assert.ok(res.attributionManifestPath && fs.existsSync(res.attributionManifestPath));

		// Also verify local provider search discovers the generated asset
		const search = await assetService.searchImageProviders({
			query: 'atelier hero',
			workspaceRoot: dir,
			providers: ['local'],
		});
		assert.strictEqual(search.assets.length, 1);
		assert.strictEqual(search.assets[0].provider, 'local');
		assert.strictEqual(search.assets[0].verified, true);

		// Add XML comment & whitespace so optimizeVisualAssets proves real byte savings
		const svgPath = res.downloaded[0].localPath;
		fs.writeFileSync(svgPath, `<?xml version="1.0"?><!-- editor metadata comment -->\n   ${fs.readFileSync(svgPath, 'utf8')}   `, 'utf8');
		const opt = await assetService.optimizeVisualAssets({ workspaceRoot: dir, minifySvgs: true });
		assert.strictEqual(opt.scannedCount, 1);
		assert.strictEqual(opt.optimizedCount, 1);
		assert.ok(opt.totalSavedBytes > 30, `Expected real SVG byte savings, saved ${opt.totalSavedBytes}`);
	});

	test('performs exact pixel-by-pixel PNG visual revision comparison and writes diff highlight PNG', async () => {
		const basePath = path.join(dir, 'v1.png');
		const samePath = path.join(dir, 'v1-copy.png');
		const changedPath = path.join(dir, 'v2.png');
		const diffOut = path.join(dir, 'diff.png');

		const baseBuf = createSolidPng(40, 40, [24, 24, 27, 255]);
		fs.writeFileSync(basePath, baseBuf);
		fs.writeFileSync(samePath, baseBuf);

		const dims = inspectImageDimensions(baseBuf, 'image/png');
		assert.strictEqual(dims.width, 40);
		assert.strictEqual(dims.height, 40);

		const identical = await assetService.compareVisualRevisions({ baselinePath: basePath, currentPath: samePath });
		assert.strictEqual(identical.verdict, 'identical');
		assert.strictEqual(identical.changedPixels, 0);
		assert.strictEqual(identical.diffPercentage, 0);

		// Paint a 10x10 bright rectangle at (5,5)-(14,14) -> exactly 100 changed pixels out of 1600 (6.25%)
		const decoded = decodePngToRgba(baseBuf);
		for (let y = 5; y < 15; y++) {
			for (let x = 5; x < 15; x++) {
				const idx = (y * 40 + x) * 4;
				decoded.rgba[idx] = 250;
				decoded.rgba[idx + 1] = 250;
				decoded.rgba[idx + 2] = 250;
			}
		}
		fs.writeFileSync(changedPath, encodeRgbaToPng(40, 40, decoded.rgba));

		const cmp = await assetService.compareVisualRevisions({
			baselinePath: basePath,
			currentPath: changedPath,
			diffOutputPath: diffOut,
		});
		assert.strictEqual(cmp.verdict, 'moderate-change');
		assert.strictEqual(cmp.changedPixels, 100);
		assert.strictEqual(cmp.diffPercentage, 6.25);
		assert.deepStrictEqual(cmp.changedRegion, { x: 5, y: 5, width: 10, height: 10 });
		assert.ok(fs.existsSync(diffOut));
	});

	test('runs live Chromium auditDesignVisuals & captureMultiViewportAudit to catch real defects and verify repairs', async () => {
		const validSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" width="800" height="600"><rect width="800" height="600" fill="#18181B"/><circle cx="400" cy="300" r="160" fill="#D4A373"/></svg>`;
		fs.writeFileSync(path.join(dir, 'hero.svg'), validSvg, 'utf8');

		const brokenHtml = `<!DOCTYPE html>
<html>
<head><title>Broken UI</title><style>
body { margin: 0; background: #FFFFFF; font-family: sans-serif; font-size: 12px; }
.wide-box { width: 980px; background: #EEE; padding: 12px; }
.faint { color: #D4D4D8; background: #FFFFFF; }
.tiny-btn { width: 20px; height: 20px; padding: 0; }
</style></head>
<body>
  <div class="wide-box">
    <p class="faint">Low contrast unreadable text sample</p>
    <img src="./missing-photo.jpg">
    <input type="text" placeholder="Search">
    <button class="tiny-btn"></button>
  </div>
</body></html>`;

		const fixedHtml = `<!DOCTYPE html>
<html lang="en">
<head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Atelier Nord</title><style>
:root { --bg: #FAF9F6; --ink: #111827; --primary: #18181B; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font-family: system-ui, sans-serif; font-size: 16px; line-height: 1.6; }
main { max-width: 1120px; margin: 0 auto; padding: 24px 16px; }
h1 { font-size: clamp(2rem, 4vw, 3.25rem); margin: 0 0 16px; }
img { display: block; max-width: 100%; height: auto; aspect-ratio: 4 / 3; object-fit: cover; border-radius: 4px; }
.controls { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 16px; }
input, button { min-height: 44px; min-width: 44px; padding: 10px 16px; font-size: 16px; }
button { background: var(--primary); color: #FFFFFF; border: none; border-radius: 4px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style></head>
<body>
  <main>
    <h1>Atelier Nord Autumn Collection</h1>
    <p>Refined architectural outerwear crafted for longevity.</p>
    <img src="./hero.svg" alt="Atelier Nord editorial collection visual">
    <div class="controls">
      <label for="q">Search collection</label>
      <input id="q" type="search" placeholder="Coat, knitwear...">
      <button type="button">Explore Collection</button>
    </div>
  </main>
</body></html>`;

		const pageFile = path.join(dir, 'index.html');
		fs.writeFileSync(pageFile, brokenHtml, 'utf8');
		const url = pathToFileURL(pageFile).toString();

		const browser = new KodiaBrowserMainService();
		try {
			const launched = await browser.launchBrowser({ headless: true });
			const tab = await browser.newTab(launched.sessionId, { url });

			// 1. Inspect broken UI across mobile & desktop
			const beforeMulti = await browser.captureMultiViewportAudit(launched.sessionId, tab.tabId, {
				viewports: [
					{ label: 'mobile', width: 375, height: 812 },
					{ label: 'desktop', width: 1280, height: 800 },
				],
			});
			assert.strictEqual(beforeMulti.allViewportsClean, false);
			const mobileBefore = beforeMulti.captures[0];
			assert.strictEqual(mobileBefore.hasHorizontalOverflow, true, 'Must detect real horizontal overflow at 375px');
			assert.ok(mobileBefore.brokenImageCount >= 1, 'Must detect broken image');
			assert.ok(mobileBefore.audit.contrastViolations.length >= 1, 'Must detect low contrast text');
			assert.ok(mobileBefore.audit.accessibilityIssues.some(i => i.rule === 'html-has-lang'));
			assert.ok(mobileBefore.audit.accessibilityIssues.some(i => i.rule === 'form-label'));
			assert.ok(mobileBefore.audit.accessibilityIssues.some(i => i.rule === 'interactive-accessible-name'));

			const critiqueBefore = critiqueInterfaceDesign({ visualAudit: mobileBefore.audit, multiViewport: beforeMulti });
			assert.strictEqual(critiqueBefore.readyToShip, false);
			const repairPlan = planVisualDefectRepairs(critiqueBefore.topPriorities);
			assert.ok(repairPlan.criticalCount >= 1);

			// 2. Write fixed UI to disk, reload, re-audit, and compare visual revisions
			fs.writeFileSync(pageFile, fixedHtml, 'utf8');
			await browser.reload(launched.sessionId, tab.tabId);
			const afterMulti = await browser.captureMultiViewportAudit(launched.sessionId, tab.tabId, {
				viewports: [
					{ label: 'mobile', width: 375, height: 812 },
					{ label: 'desktop', width: 1280, height: 800 },
				],
			});
			assert.strictEqual(afterMulti.allViewportsClean, true, `Expected clean viewports after repair: ${afterMulti.summary}`);
			const mobileAfter = afterMulti.captures[0];
			assert.strictEqual(mobileAfter.audit.brokenImages.length, 0);
			assert.strictEqual(mobileAfter.audit.contrastViolations.length, 0);
			assert.strictEqual(mobileAfter.audit.accessibilityIssues.length, 0);
			assert.strictEqual(mobileAfter.audit.pageMetrics.hasReducedMotionMediaRule, true);

			const critiqueAfter = critiqueInterfaceDesign({ visualAudit: mobileAfter.audit, multiViewport: afterMulti });
			assert.strictEqual(critiqueAfter.readyToShip, true, `Expected fixed UI readyToShip, got ${critiqueAfter.verdict}`);
			assert.ok(critiqueAfter.overallScore > critiqueBefore.overallScore);

			// Real PNG pixel diff between before and after mobile screenshots!
			const diff = await assetService.compareVisualRevisions({
				baselinePath: mobileBefore.path,
				currentPath: mobileAfter.path,
			});
			assert.ok(diff.changedPixels > 0 && diff.diffPercentage > 0, 'Expected measurable pixel difference after repair');
			assert.ok(diff.diffImagePath && fs.existsSync(diff.diffImagePath));
		} finally {
			await browser.shutdown();
		}
	});
});
