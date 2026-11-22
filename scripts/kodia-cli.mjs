#!/usr/bin/env node
/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Kodia Headless CLI (Mandate §2.3 / §2.4 / §12).
 *
 * Run deterministic Kodia workspace intelligence or headless BYOK agent prompts from
 * any terminal or CI pipeline without launching Electron:
 *
 *   node scripts/kodia-cli.mjs health [dir]
 *   node scripts/kodia-cli.mjs arch [dir]
 *   node scripts/kodia-cli.mjs deps [dir]
 *   node scripts/kodia-cli.mjs run "<prompt>" [--dir <path>] [--model <id>] [--base-url <url>]
 *
 * Environment variables for `run`:
 *   KODIA_API_KEY / NVIDIA_API_KEY / OPENAI_API_KEY
 *   KODIA_BASE_URL (default: https://integrate.api.nvidia.com/v1)
 *   KODIA_MODEL    (default: nvidia/nemotron-3.5-super-vl-120b-a12b)
 */

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

const SKIP_DIRS = new Set([
	'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'vendor',
	'target', '__pycache__', '.venv', 'venv', 'coverage', '.cache', '.turbo',
]);

function walkFiles(rootDir, maxFiles = 500) {
	const out = [];
	let skipped = 0;
	const stack = [rootDir];
	while (stack.length > 0 && out.length < maxFiles) {
		const dir = stack.pop();
		let entries;
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
		catch { continue; }
		for (const e of entries) {
			if (out.length >= maxFiles) { skipped++; break; }
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (!SKIP_DIRS.has(e.name)) { stack.push(full); }
			} else if (e.isFile()) {
				try {
					const st = fs.statSync(full);
					if (st.size > 200_000) { skipped++; continue; }
					const buf = fs.readFileSync(full);
					if (buf.subarray(0, 1024).includes(0)) { skipped++; continue; }
					out.push({ relativePath: path.relative(rootDir, full).replace(/\\/g, '/'), content: buf.toString('utf8') });
				} catch { skipped++; }
			}
		}
	}
	return { files: out, skipped };
}

async function loadKodiaHealthModule() {
	const modPath = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../out/vs/workbench/contrib/void/common/projectHealth.js');
	if (!fs.existsSync(modPath)) {
		console.error(`Compiled Kodia modules not found at ${modPath}. Run "npm run transpile-client" first.`);
		process.exit(1);
	}
	return import(pathToFileURL(modPath).href);
}

async function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	if (!cmd || cmd === '--help' || cmd === '-h') {
		console.log([
			'Kodia Headless CLI',
			'',
			'Usage:',
			'  node scripts/kodia-cli.mjs health [dir]     Scan secrets, security risks, stack, and Engineering Quality Score',
			'  node scripts/kodia-cli.mjs arch [dir]       Build module dependency map, cycles, hubs, and Mermaid graph',
			'  node scripts/kodia-cli.mjs run "<prompt>"   Run a headless prompt against your BYOK / NVIDIA OpenAI-compatible endpoint',
		].join('\n'));
		return;
	}

	if (cmd === 'health' || cmd === 'arch') {
		const targetDir = path.resolve(rest[0] || process.cwd());
		const { analyzeProjectHealth, buildArchitectureMap, computeEngineeringQualityScore, formatArchitectureMapForLLM, formatProjectHealthForLLM } = await loadKodiaHealthModule();
		const { files, skipped } = walkFiles(targetDir, 500);
		if (cmd === 'health') {
			const report = analyzeProjectHealth(files, skipped);
			const arch = buildArchitectureMap(files);
			const score = computeEngineeringQualityScore(report, arch);
			console.log(`Kodia Engineering Quality Score: ${score.score}/100 (Grade ${score.grade}) — Security ${score.securityScore}/100 | Architecture ${score.architectureScore}/100 | Maintainability ${score.maintainabilityScore}/100\n`);
			console.log(formatProjectHealthForLLM(report));
		} else {
			const arch = buildArchitectureMap(files);
			console.log(formatArchitectureMapForLLM(arch));
			console.log('\n```mermaid\n' + arch.mermaid + '\n```');
		}
		return;
	}

	if (cmd === 'run') {
		const prompt = rest.filter(a => !a.startsWith('--'))[0];
		if (!prompt) {
			console.error('Usage: node scripts/kodia-cli.mjs run "<prompt>"');
			process.exit(1);
		}
		const apiKey = process.env.KODIA_API_KEY || process.env.NVIDIA_API_KEY || process.env.OPENAI_API_KEY;
		if (!apiKey) {
			console.error('Missing API key. Set KODIA_API_KEY, NVIDIA_API_KEY, or OPENAI_API_KEY.');
			process.exit(1);
		}
		const baseUrl = (process.env.KODIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '');
		const model = process.env.KODIA_MODEL || 'nvidia/nemotron-3.5-super-vl-120b-a12b';

		const res = await fetch(`${baseUrl}/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages: [
					{ role: 'system', content: 'You are Kodia Headless Autonomous Software Engineer. Be concrete, accurate, and concise.' },
					{ role: 'user', content: prompt },
				],
			}),
		});
		if (!res.ok) {
			console.error(`Provider HTTP ${res.status}: ${await res.text()}`);
			process.exit(1);
		}
		const data = await res.json();
		console.log(data?.choices?.[0]?.message?.content ?? '');
		return;
	}

	console.error(`Unknown command: ${cmd}. Run with --help for usage.`);
	process.exit(1);
}

main().catch(err => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
