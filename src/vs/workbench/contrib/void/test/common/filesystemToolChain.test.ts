/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { TestContextService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { ToolsService } from '../../browser/toolsService.js';

suite('Kodia - filesystemToolChain', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const repo = URI.file('/repo');
	const contextService = new TestContextService(testWorkspace(repo));

	const created: { kind: 'folder' | 'file', fsPath: string }[] = [];
	const written: { fsPath: string, len: number }[] = [];
	const deleted: { fsPath: string, recursive: boolean }[] = [];
	let writeFileDeferredResolve: (() => void) | null = null;

	const commandBarServiceMock = {
		getStreamState: () => 'idle-no-changes',
	};

	const fileService = {
		createFolder: async (uri: URI) => { created.push({ kind: 'folder', fsPath: uri.fsPath }); },
		createFile: async (uri: URI) => { created.push({ kind: 'file', fsPath: uri.fsPath }); },
		del: async (uri: URI, opts: { recursive?: boolean }) => { deleted.push({ fsPath: uri.fsPath, recursive: !!opts?.recursive }); },
		writeFile: async (_uri: URI, buffer: { byteLength: number }) => {
			written.push({ fsPath: _uri.fsPath, len: buffer.byteLength });
			await new Promise<void>(resolve => { writeFileDeferredResolve = resolve });
		},
		stat: async () => ({ type: 1 }),
	};

	const instantiationService = {
		createInstance: () => ({}),
	};

	const mainProcessService = {
		getChannel: () => ({
			call: async () => undefined,
			listen: () => ({ dispose: () => {} }),
		}),
	};

	const DUMMY = {};
	const editCodeService = {
		callBeforeApplyOrEdit: async () => { },
		instantlyRewriteFile: async ({ uri, newContent }: { uri: URI, newContent: string }) => {
			await fileService.writeFile(uri, { byteLength: newContent.length } as { byteLength: number });
		},
		instantlyApplySearchReplaceBlocks: async ({ uri, searchReplaceBlocks }: { uri: URI, searchReplaceBlocks: string }) => {
			await fileService.writeFile(uri, { byteLength: searchReplaceBlocks.length } as { byteLength: number });
		},
	};

	const voidSettingsService = {
		state: { globalSettings: { includeToolLintErrors: false } },
	};

	const voidModelService = {
		initializeModel: async () => { },
		getModelSafe: async () => ({ model: null }),
	};

	const svc = new ToolsService(
		fileService as any,
		contextService,
		DUMMY as any, instantiationService as any,
		voidModelService as any,
		editCodeService as any,
		DUMMY as any, DUMMY as any, DUMMY as any, commandBarServiceMock as any, DUMMY as any, DUMMY as any,
		voidSettingsService as any,
		DUMMY as any, DUMMY as any, DUMMY as any,
		mainProcessService as any,
		DUMMY as any, DUMMY as any, DUMMY as any, // Notebook services
	);

	setup(() => {
		created.length = 0;
		written.length = 0;
		deleted.length = 0;
		writeFileDeferredResolve = null;
	});

	test('create_file_or_folder(folder) validates params and persists to disk', async () => {
		const params = svc.validateParams.create_file_or_folder({ uri: '/repo/newproject/' });
		assert.strictEqual(params.isFolder, true);
		assert.ok(params.uri.fsPath.includes('newproject'));

		created.length = 0;
		await svc.callTool.create_file_or_folder({ uri: URI.joinPath(repo, 'newproject'), isFolder: true });
		assert.strictEqual(created.length, 1);
		assert.strictEqual(created[0].kind, 'folder');
		assert.ok(created[0].fsPath.includes('newproject'));
	});

	test('create_file_or_folder(file) validates params and persists to disk', async () => {
		const params = svc.validateParams.create_file_or_folder({ uri: '/repo/newproject/src/QueryBuilder.php' });
		assert.strictEqual(params.isFolder, false);

		created.length = 0;
		await svc.callTool.create_file_or_folder({ uri: URI.joinPath(repo, 'newproject', 'src', 'QueryBuilder.php'), isFolder: false });
		assert.strictEqual(created.length, 1);
		assert.strictEqual(created[0].kind, 'file');
		assert.ok(created[0].fsPath.includes('QueryBuilder.php'));
	});

	test('delete_file_or_folder persists to disk', async () => {
		deleted.length = 0;
		await svc.callTool.delete_file_or_folder({ uri: repo, isRecursive: true, isFolder: true });
		assert.strictEqual(deleted.length, 1);
		assert.ok(deleted[0].fsPath.includes('repo'));
		assert.strictEqual(deleted[0].recursive, true);
	});

	test('write_file invokes fileService.writeFile and awaits it', async () => {
		written.length = 0;
		writeFileDeferredResolve = null;

		const writePromise = svc.callTool.write_file({
			uri: URI.joinPath(repo, 'newproject', 'src', 'Test.php'),
			newContent: '<?php\n',
		});

		// Allow the synchronous portion to run (writeFile is invoked up to its first await)
		await new Promise(resolve => setTimeout(resolve, 10));

		assert.strictEqual(written.length, 1, 'write_file must invoke fileService.writeFile');
		assert.ok(writeFileDeferredResolve !== null, 'writeFile must be deferred (tool awaiting actual disk write)');

		// Complete the deferred write
		if (writeFileDeferredResolve) {
			(writeFileDeferredResolve as () => void)();
		}
		const result = await writePromise;
		assert.ok(result.result !== undefined, 'write_file must return a result after write completes');
	});

	test('stringOfResult reports created URI', () => {
		const str = svc.stringOfResult.create_file_or_folder({ uri: repo, isFolder: true }, {});
		assert.ok(str.includes('repo'));
	});
});
