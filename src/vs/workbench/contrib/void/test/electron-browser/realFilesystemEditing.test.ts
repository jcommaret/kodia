/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * REAL-DISK integration test for the agent's filesystem tools.
 *
 * Unlike test/common/filesystemToolChain.test.ts (which mocks IFileService and IEditCodeService),
 * this test wires the real ToolsService and the real EditCodeService to a real FileService +
 * DiskFileSystemProvider over a fresh temp directory, then asserts on the bytes that ended up on disk
 * using Node's fs (independent of Kodia's services).
 *
 * The only stand-in is the model layer: IVoidModelService is replaced by a small disk-backed
 * implementation (real TextModel loaded from disk; saveModel writes the full model value via the real
 * FileService), mirroring what ITextFileService.save does in the workbench.
 *
 * Run (electron, needs node integration): scripts\test.bat --runGlob vs/workbench/contrib/void/test/electron-browser/realFilesystemEditing.test.js
 */

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { DiskFileSystemProvider } from '../../../../../platform/files/node/diskFileSystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { Schemas } from '../../../../../base/common/network.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { EditCodeService } from '../../browser/editCodeService.js';
import { ToolsService } from '../../browser/toolsService.js';
import { DIVIDER, FINAL, ORIGINAL } from '../../common/prompt/prompts.js';

class DiskBackedVoidModelService {
	readonly _serviceBrand: undefined;
	private readonly models = new Map<string, TextModel>();
	private readonly savedVersion = new Map<string, number>();
	saveCount = 0;

	constructor(private readonly fileService: IFileService) { }

	initializeModel = async (uri: URI) => {
		if (this.models.has(uri.fsPath)) { return; }
		try {
			const content = await this.fileService.readFile(uri);
			const model = createTextModel(content.value.toString(), null, undefined, uri);
			this.models.set(uri.fsPath, model);
			this.savedVersion.set(uri.fsPath, model.getAlternativeVersionId());
		} catch {
			// file does not exist yet - same as the real service (which logs and continues)
		}
	};
	getModelFromFsPath = (fsPath: string) => ({ model: this.models.get(fsPath) ?? null, editorModel: null });
	getModel = (uri: URI) => this.getModelFromFsPath(uri.fsPath);
	getModelSafe = async (uri: URI) => { await this.initializeModel(uri); return this.getModel(uri); };
	saveModel = async (uri: URI) => {
		const model = this.models.get(uri.fsPath);
		if (!model) { return; }
		const version = model.getAlternativeVersionId();
		if (this.savedVersion.get(uri.fsPath) === version) { return; } // not dirty
		this.saveCount++;
		await this.fileService.writeFile(uri, VSBuffer.fromString(model.getValue()));
		this.savedVersion.set(uri.fsPath, version);
	};
	dispose() { for (const m of this.models.values()) { m.dispose(); } this.models.clear(); }
}

// Returns a no-op function / object for any property access (for services whose effects are purely visual).
const noopService: any = new Proxy(function () { }, {
	get: (_t, p) => p === 'then' ? undefined : noopService,
	apply: () => noopService,
});

suite('Kodia - real filesystem editing (disk)', function () {
	this.timeout(60_000);

	let store: DisposableStore;
	let tmpDir: string;
	let fileService: FileService;
	let voidModelService: DiskBackedVoidModelService;
	let editCodeService: EditCodeService;
	let tools: ToolsService;

	setup(() => {
		store = new DisposableStore();
		// Fresh temp project per test; nothing pre-created by hand.
		tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kodia-fs-e2e-')));
		const logService = new NullLogService();
		fileService = store.add(new FileService(logService));
		store.add(fileService.registerProvider(Schemas.file, store.add(new DiskFileSystemProvider(logService))));

		voidModelService = new DiskBackedVoidModelService(fileService);
		store.add({ dispose: () => voidModelService.dispose() });

		const settingsService = { state: { globalSettings: { autoAcceptLLMChanges: true, includeToolLintErrors: false } } };

		editCodeService = store.add(new EditCodeService(
			{ listCodeEditors: () => [], onCodeEditorAdd: Event.None } as any, // ICodeEditorService
			{ getModels: () => [], onModelAdded: Event.None } as any, // IModelService
			{ pushElement: () => { }, undo: () => { } } as any, // IUndoRedoService (a refused edit undoes its history entry)
			noopService, // ILLMMessageService (not used by instant edits)
			noopService, // IConsistentItemService
			noopService, // IInstantiationService
			noopService, // IConsistentEditorItemService
			noopService, // IMetricsService
			noopService, // INotificationService
			settingsService as any,
			fileService,
			voidModelService as any,
			noopService, // IConvertToLLMMessageService
		));

		const DUMMY = {};
		const mainProcessService = { getChannel: () => ({ call: async () => undefined, listen: () => ({ dispose: () => { } }) }) };
		tools = new ToolsService(
			fileService as any,
			new TestContextService(testWorkspace(URI.file(tmpDir))),
			DUMMY as any, { createInstance: () => ({}) } as any,
			voidModelService as any,
			editCodeService as any,
			DUMMY as any, DUMMY as any, DUMMY as any, DUMMY as any,
			{ getStreamState: () => 'idle-no-changes' } as any,
			DUMMY as any, // IDirectoryStrService
			{ read: () => [] } as any, // IMarkerService (post-edit lint lookup)
			settingsService as any,
			DUMMY as any, DUMMY as any, DUMMY as any,
			mainProcessService as any,
			DUMMY as any, DUMMY as any, DUMMY as any, DUMMY as any,
		);
	});

	teardown(() => {
		store.dispose();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	const p = (...segments: string[]) => path.join(tmpDir, ...segments);

	test('create_file_or_folder creates real nested directories and files from raw LLM params', async () => {
		for (const raw of [p('app', 'src', 'components') + path.sep, p('app', 'src', 'index.ts'), p('app', 'README.md')]) {
			const params = tools.validateParams.create_file_or_folder({ uri: raw });
			await tools.callTool.create_file_or_folder(params);
		}
		assert.ok(fs.statSync(p('app', 'src', 'components')).isDirectory());
		assert.ok(fs.statSync(p('app', 'src', 'index.ts')).isFile());
		assert.ok(fs.statSync(p('app', 'README.md')).isFile());
	});

	test('write_file creates a brand-new file (and parent dirs) with exact content on disk', async () => {
		const content = 'export const answer = 42;\nexport function add(a: number, b: number) {\n\treturn a + b;\n}\n';
		const params = tools.validateParams.write_file({ uri: p('pkg', 'lib', 'math.ts'), new_content: content });
		await tools.callTool.write_file(params);
		assert.strictEqual(fs.readFileSync(p('pkg', 'lib', 'math.ts'), 'utf8'), content);
	});

	test('edit_file (search/replace) persists the WHOLE file, not just the replaced snippet', async () => {
		const original = ['line 1', 'line 2', 'const value = 1;', 'line 4', 'line 5', ''].join('\n');
		fs.mkdirSync(p('src'));
		fs.writeFileSync(p('src', 'a.ts'), original);

		const blocks = `${ORIGINAL}\nconst value = 1;\n${DIVIDER}\nconst value = 2;\n${FINAL}`;
		const params = tools.validateParams.edit_file({ uri: p('src', 'a.ts'), search_replace_blocks: blocks });
		await tools.callTool.edit_file(params);

		assert.strictEqual(fs.readFileSync(p('src', 'a.ts'), 'utf8'), original.replace('const value = 1;', 'const value = 2;'));
	});

	test('edit_file replaces exactly the ORIGINAL text, not the whole lines around it (the rest of the line was silently dropped)', async () => {
		fs.writeFileSync(p('app.js'), 'let n = 0;\n\tdocument.getElementById(\'cart-count\').textContent = `Cart (${n})`;\nend();\n');
		const edit = (orig: string, final: string) => tools.callTool.edit_file(tools.validateParams.edit_file({ uri: p('app.js'), search_replace_blocks: `${ORIGINAL}\n${orig}\n${DIVIDER}\n${final}\n${FINAL}` }));
		await edit('\tdocument.getElementById(\'cart-count\').textContent', '\tdocument.getElementById(\'cartCount\').textContent');
		assert.strictEqual(fs.readFileSync(p('app.js'), 'utf8'), 'let n = 0;\n\tdocument.getElementById(\'cartCount\').textContent = `Cart (${n})`;\nend();\n');
		await edit('= 0', '= 1'); // mid-line
		assert.match(fs.readFileSync(p('app.js'), 'utf8'), /^let n = 1;\n/);
	});

	test('edit_file refuses an ORIGINAL that occurs more than once (the first occurrence was edited silently), and a whitespace-only match of part of a line', async () => {
		const original = 'a = 1;\nb = 1;\nfoo(  x  ) + bar;\n';
		fs.writeFileSync(p('dup.js'), original);
		const edit = (orig: string, final: string) => tools.callTool.edit_file(tools.validateParams.edit_file({ uri: p('dup.js'), search_replace_blocks: `${ORIGINAL}\n${orig}\n${DIVIDER}\n${final}\n${FINAL}` }));
		await assert.rejects(edit(' = 1;', ' = 2;'), /must be unique/);
		await assert.rejects(edit('foo(x)', 'baz(x)'), /only matched part of a line/, 'whitespace-insensitive match of part of a line would drop " + bar;"');
		assert.strictEqual(fs.readFileSync(p('dup.js'), 'utf8'), original, 'nothing was written');
		await edit('foo(x) + bar;', 'baz(x) + bar;'); // whitespace-insensitive, whole line: still allowed
		assert.strictEqual(fs.readFileSync(p('dup.js'), 'utf8'), 'a = 1;\nb = 1;\nbaz(x) + bar;\n');
	});

	test('an edit_file in the wrong format is refused with the exact format to use (seen live: a model sent no blocks)', async () => {
		fs.writeFileSync(p('fmt.js'), 'const a = 1;\n');
		const call = (blocks: string) => tools.callTool.edit_file(tools.validateParams.edit_file({ uri: p('fmt.js'), search_replace_blocks: blocks }));
		const diffErr = await call('--- a/fmt.js\n+++ b/fmt.js\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n').then(() => null, e => String(e?.message ?? e));
		assert.ok(diffErr, 'refused');
		assert.match(diffErr!, /looks like a unified diff/);
		assert.match(diffErr!, new RegExp(`${ORIGINAL}[\\s\\S]*${DIVIDER}[\\s\\S]*${FINAL.replace(/[>]/g, '\\>')}`), 'the exact block format is shown');
		assert.doesNotMatch(diffErr!, /Error: Error/, 'no doubled prefix');
		const plainErr = await call('const a = 2;\n').then(() => null, e => String(e?.message ?? e));
		assert.match(plainErr!, /use write_file with the complete new content/);
		assert.strictEqual(fs.readFileSync(p('fmt.js'), 'utf8'), 'const a = 1;\n', 'nothing was written');
	});

	test('edit_file on a missing file fails instead of reporting success', async () => {
		const blocks = `${ORIGINAL}\nx\n${DIVIDER}\ny\n${FINAL}`;
		const params = tools.validateParams.edit_file({ uri: p('does-not-exist.ts'), search_replace_blocks: blocks });
		await assert.rejects(() => tools.callTool.edit_file(params));
		assert.strictEqual(fs.existsSync(p('does-not-exist.ts')), false);
	});

	test('regression: a partial-range write does not truncate the file on disk', async () => {
		fs.writeFileSync(p('b.txt'), 'alpha\nbeta\ngamma\n');
		const uri = URI.file(p('b.txt'));
		await voidModelService.initializeModel(uri);

		// replace only line 2 (this is what diff-reject / Ctrl+K / fast-apply blocks do)
		await (editCodeService as any)._writeURIText(uri, 'BETA',
			{ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: Number.MAX_SAFE_INTEGER },
			{ shouldRealignDiffAreas: false });

		assert.strictEqual(fs.readFileSync(p('b.txt'), 'utf8'), 'alpha\nBETA\ngamma\n');
	});

	test('burst of unawaited streaming writes ends with disk == model, in order, with coalesced saves', async () => {
		fs.writeFileSync(p('c.txt'), '');
		const uri = URI.file(p('c.txt'));
		await voidModelService.initializeModel(uri);
		const model = voidModelService.getModel(uri).model!;

		const pending: Promise<void>[] = [];
		for (let i = 0; i < 40; i++) {
			const line = model.getLineCount();
			const col = model.getLineMaxColumn(line);
			// streaming code does NOT await these
			pending.push((editCodeService as any)._writeURIText(uri, `chunk${i}\n`,
				{ startLineNumber: line, startColumn: col, endLineNumber: line, endColumn: col },
				{ shouldRealignDiffAreas: false }));
		}
		await Promise.all(pending);

		const expected = Array.from({ length: 40 }, (_, i) => `chunk${i}\n`).join('');
		assert.strictEqual(model.getValue(), expected);
		assert.strictEqual(fs.readFileSync(p('c.txt'), 'utf8'), expected);
		assert.ok(voidModelService.saveCount < 40, `saves should be coalesced, got ${voidModelService.saveCount}`);
	});

	test('partial write to an unloaded file is refused (no snippet overwrite)', async () => {
		fs.writeFileSync(p('d.txt'), 'keep me\nand me\n');
		await assert.rejects(() => (editCodeService as any)._writeURIText(URI.file(p('d.txt')), 'X',
			{ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 },
			{ shouldRealignDiffAreas: false }));
		assert.strictEqual(fs.readFileSync(p('d.txt'), 'utf8'), 'keep me\nand me\n');
	});

	test('delete_file_or_folder removes a real directory tree', async () => {
		fs.mkdirSync(p('gone', 'deep'), { recursive: true });
		fs.writeFileSync(p('gone', 'deep', 'f.txt'), 'x');
		const params = tools.validateParams.delete_file_or_folder({ uri: p('gone'), is_recursive: 'true' });
		await tools.callTool.delete_file_or_folder(params);
		assert.strictEqual(fs.existsSync(p('gone')), false);
	});
});
