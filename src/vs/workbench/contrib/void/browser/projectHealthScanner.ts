/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Browser-safe workspace file scanner for Project Health & Architecture Mapping.
 * Shared by ToolsService (agent tools) and ProjectHealthPanel (Command Center UI).
 */

import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import {
	analyzeProjectHealth,
	ArchitectureMapReport,
	buildArchitectureMap,
	ProjectHealthReport,
	ScannedSourceFile,
} from '../common/projectHealth.js';

const SKIP_DIRS: ReadonlySet<string> = new Set([
	'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'out-build', 'out-vscode',
	'.build', '.next', '.nuxt', '.venv', 'venv', '__pycache__', 'target', 'vendor', '.kodia',
	'coverage', '.cache', '.turbo',
]);

const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
	'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro', '.py', '.go', '.rs', '.java', '.cs', '.php',
	'.rb', '.c', '.cpp', '.h', '.hpp', '.sql', '.json', '.yaml', '.yml', '.toml', '.ini',
	'.env', '.html', '.css', '.scss', '.md', '.sh', '.ps1', '.dockerfile',
]);

const ALWAYS_INCLUDE_NAMES: ReadonlySet<string> = new Set([
	'Dockerfile', 'Makefile', 'package.json', 'tsconfig.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt', 'composer.json',
]);

const MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES = 400;
const HARD_MAX_FILES = 1000;

export async function scanWorkspaceSourceFiles(
	fileService: IFileService,
	workspaceContextService: IWorkspaceContextService,
	maxFiles = DEFAULT_MAX_FILES,
): Promise<{ files: ScannedSourceFile[]; skippedFiles: number; rootUri?: URI }> {
	const limit = Math.max(10, Math.min(HARD_MAX_FILES, Math.round(maxFiles)));
	const folders = workspaceContextService.getWorkspace().folders;
	if (folders.length === 0) {
		return { files: [], skippedFiles: 0 };
	}

	const files: ScannedSourceFile[] = [];
	let skippedFiles = 0;

	const walk = async (dirUri: URI, relPrefix: string, depth: number): Promise<void> => {
		if (depth > 8 || files.length >= limit) { return; }
		let stat;
		try {
			stat = await fileService.resolve(dirUri, { resolveMetadata: true });
		} catch {
			return;
		}
		if (!stat.isDirectory || !stat.children) { return; }

		for (const child of stat.children) {
			if (files.length >= limit) {
				skippedFiles++;
				continue;
			}
			const name = child.name;
			if (child.isDirectory) {
				if (SKIP_DIRS.has(name)) { continue; }
				await walk(child.resource, relPrefix ? `${relPrefix}/${name}` : name, depth + 1);
				continue;
			}

			const lower = name.toLowerCase();
			const dotIdx = lower.lastIndexOf('.');
			const ext = dotIdx >= 0 ? lower.slice(dotIdx) : '';
			if (!ALWAYS_INCLUDE_NAMES.has(name) && !TEXT_EXTENSIONS.has(ext)) {
				skippedFiles++;
				continue;
			}
			if (lower.endsWith('.min.js') || lower.endsWith('.min.css') || lower === 'package-lock.json' || lower === 'yarn.lock' || lower === 'pnpm-lock.yaml') {
				if (lower === 'package-lock.json' || lower === 'yarn.lock' || lower === 'pnpm-lock.yaml') {
					files.push({ relativePath: relPrefix ? `${relPrefix}/${name}` : name, content: '' });
				} else {
					skippedFiles++;
				}
				continue;
			}
			if (typeof child.size === 'number' && child.size > MAX_FILE_BYTES) {
				skippedFiles++;
				continue;
			}

			try {
				const buf = await fileService.readFile(child.resource);
				if (buf.value.byteLength > MAX_FILE_BYTES) {
					skippedFiles++;
					continue;
				}
				const content = buf.value.toString();
				if (content.includes('\u0000')) {
					skippedFiles++;
					continue;
				}
				files.push({
					relativePath: relPrefix ? `${relPrefix}/${name}` : name,
					content,
				});
			} catch {
				skippedFiles++;
			}
		}
	};

	for (const folder of folders) {
		const prefix = folders.length > 1 ? folder.name : '';
		await walk(folder.uri, prefix, 0);
	}

	return { files, skippedFiles, rootUri: folders[0].uri };
}

export async function runProjectHealthScan(
	fileService: IFileService,
	workspaceContextService: IWorkspaceContextService,
	maxFiles?: number,
): Promise<ProjectHealthReport> {
	const { files, skippedFiles } = await scanWorkspaceSourceFiles(fileService, workspaceContextService, maxFiles);
	return analyzeProjectHealth(files, skippedFiles);
}

export async function runArchitectureMap(
	fileService: IFileService,
	workspaceContextService: IWorkspaceContextService,
	maxFiles?: number,
): Promise<ArchitectureMapReport> {
	const { files } = await scanWorkspaceSourceFiles(fileService, workspaceContextService, maxFiles);
	return buildArchitectureMap(files);
}

export async function collectWorkspaceProjectFiles(
	fileService: IFileService,
	workspaceContextService: IWorkspaceContextService,
	options?: { subPath?: string; maxFiles?: number },
): Promise<ScannedSourceFile[]> {
	const { files } = await scanWorkspaceSourceFiles(fileService, workspaceContextService, options?.maxFiles);
	if (!options?.subPath) { return files; }
	const norm = options.subPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
	if (!norm) { return files; }
	return files.filter(f => f.relativePath.replace(/\\/g, '/').toLowerCase().startsWith(norm));
}
