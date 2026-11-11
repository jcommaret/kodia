/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { env } from '../../../../../base/common/process.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileSystemProviderCapabilities } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import product from '../../../../../platform/product/common/product.js';
import { ExtensionTransferService, TransferProductNames, transferTheseFilesOfOS } from '../../browser/extensionTransferService.js';
import { TransferEditorType } from '../../browser/extensionTransferTypes.js';

const stable: TransferProductNames = { nameShort: 'Kodia', dataFolderName: '.kodia' };
// as prepare_vscode.sh in kodia-builder sets them for the insiders build
const insiders: TransferProductNames = { nameShort: 'Kodia - Insiders', dataFolderName: '.kodia-insiders' };

const editors: TransferEditorType[] = ['VS Code', 'Cursor', 'Windsurf'];
const envVariables = ['HOME', 'APPDATA', 'USERPROFILE', 'XDG_CONFIG_HOME', 'VSCODE_DEV'];

// a file service over an in-memory disk, where deleting to the trash is allowed
class DiskWithTrash extends InMemoryFileSystemProvider {
	override get capabilities() { return super.capabilities | FileSystemProviderCapabilities.Trash; }
}

suite('Kodia - transfer from another editor', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let savedEnv: (string | undefined)[];
	setup(() => {
		savedEnv = envVariables.map(name => env[name]);
		envVariables.forEach(name => delete env[name]);
	});
	teardown(() => {
		envVariables.forEach((name, i) => {
			const value = savedEnv[i];
			if (value === undefined) { delete env[name]; } else { env[name] = value; }
		});
	});

	const targetsOf = (os: 'mac' | 'windows' | 'linux', fromEditor: TransferEditorType, names: TransferProductNames) =>
		transferTheseFilesOfOS(os, fromEditor, names).map(({ to, isExtensions }) => ({ to: to.path, isExtensions }));

	const expectedTargets = (userDataFolder: string, extensionsFolder: string) => [
		{ to: `${userDataFolder}/User/settings.json`, isExtensions: undefined },
		{ to: `${userDataFolder}/User/keybindings.json`, isExtensions: undefined },
		{ to: `${extensionsFolder}/extensions`, isExtensions: true },
	];

	for (const names of [stable, insiders]) {
		for (const fromEditor of editors) {
			test(`${fromEditor} to ${names.nameShort}, on macOS`, () => {
				env.HOME = '/Users/me';
				assert.deepStrictEqual(targetsOf('mac', fromEditor, names), expectedTargets(
					`/Users/me/Library/Application Support/${names.nameShort}`,
					`/Users/me/${names.dataFolderName}`,
				));
			});

			test(`${fromEditor} to ${names.nameShort}, on Linux`, () => {
				env.HOME = '/home/me';
				assert.deepStrictEqual(targetsOf('linux', fromEditor, names), expectedTargets(
					`/home/me/.config/${names.nameShort}`,
					`/home/me/${names.dataFolderName}`,
				));
			});

			test(`${fromEditor} to ${names.nameShort}, on Windows`, () => {
				env.APPDATA = 'C:/Users/me/AppData/Roaming';
				env.USERPROFILE = 'C:/Users/me';
				assert.deepStrictEqual(targetsOf('windows', fromEditor, names), expectedTargets(
					`/C:/Users/me/AppData/Roaming/${names.nameShort}`,
					`/C:/Users/me/${names.dataFolderName}`,
				));
			});
		}
	}

	test('reads from the other editor\'s folders', () => {
		env.HOME = '/Users/me';
		assert.deepStrictEqual(transferTheseFilesOfOS('mac', 'Cursor', stable).map(({ from }) => from.path), [
			'/Users/me/Library/Application Support/Cursor/User/settings.json',
			'/Users/me/Library/Application Support/Cursor/User/keybindings.json',
			'/Users/me/.cursor/extensions',
		]);
	});

	test('on Linux, both sides follow XDG_CONFIG_HOME, as these editors all do', () => {
		env.HOME = '/home/me';
		env.XDG_CONFIG_HOME = '/home/me/.xdg';
		const files = transferTheseFilesOfOS('linux', 'VS Code', stable);
		assert.strictEqual(files[0].from.path, '/home/me/.xdg/Code/User/settings.json');
		assert.strictEqual(files[0].to.path, '/home/me/.xdg/Kodia/User/settings.json');
		assert.strictEqual(files[2].to.path, '/home/me/.kodia/extensions'); // not under the config folder
	});

	test('out of sources, uses the user data folder the app runs from', () => {
		env.HOME = '/Users/me';
		env.VSCODE_DEV = '1';
		assert.deepStrictEqual(targetsOf('mac', 'VS Code', { nameShort: 'Kodia Dev', dataFolderName: '.kodia-dev' }), expectedTargets(
			'/Users/me/Library/Application Support/code-oss-dev',
			'/Users/me/.kodia-dev',
		));
	});

	test('fails clearly when the OS is unknown', () => {
		assert.throws(() => transferTheseFilesOfOS(null, 'VS Code', stable), /not possible/);
	});

	suite('on disk', () => {
		const home = '/Users/me';
		const uri = (path: string) => URI.file(`${home}/${path}`);

		let store: DisposableStore;
		let fileService: FileService;
		let service: ExtensionTransferService;

		const write = (path: string, content: string) => fileService.writeFile(uri(path), VSBuffer.fromString(content));
		const read = async (path: string) => (await fileService.readFile(uri(path))).value.toString();
		const exists = (path: string) => fileService.exists(uri(path));

		setup(() => {
			env.HOME = home;
			store = disposables.add(new DisposableStore());
			fileService = store.add(new FileService(new NullLogService()));
			store.add(fileService.registerProvider('file', store.add(new DiskWithTrash())));
			service = store.add(new ExtensionTransferService(fileService, { _serviceBrand: undefined, ...product, ...stable }));
		});

		test('an import lands in the folders Kodia reads, and leaves no folder named after Void', async () => {
			await write('Library/Application Support/Code/User/settings.json', '{"from":"code"}');
			await write('Library/Application Support/Code/User/keybindings.json', '[]');
			await write('.vscode/extensions/esbenp.prettier-1.0.0/package.json', '{}');
			await write('.vscode/extensions/github.copilot-1.0.0/package.json', '{}');
			await write('.vscode/extensions/extensions.json', JSON.stringify([
				{ identifier: { id: 'esbenp.prettier' } },
				{ identifier: { id: 'github.copilot' } },
			]));

			assert.strictEqual(await service.transferExtensions('mac', 'VS Code'), undefined);

			assert.strictEqual(await read('Library/Application Support/Kodia/User/settings.json'), '{"from":"code"}');
			assert.strictEqual(await read('Library/Application Support/Kodia/User/keybindings.json'), '[]');
			assert.strictEqual(await exists('.kodia/extensions/esbenp.prettier-1.0.0/package.json'), true);
			assert.strictEqual(await exists('.kodia/extensions/github.copilot-1.0.0'), false);
			assert.deepStrictEqual(JSON.parse(await read('.kodia/extensions/extensions.json')), [{ identifier: { id: 'esbenp.prettier' } }]);

			assert.strictEqual(await exists('.void-editor'), false);
			assert.strictEqual(await exists('Library/Application Support/Void'), false);
		});

		// the contents of the backups kept next to a file
		const backupsOf = async (path: string) => {
			const folder = path.slice(0, path.lastIndexOf('/'));
			const name = path.slice(path.lastIndexOf('/') + 1);
			const children = (await fileService.resolve(uri(folder))).children ?? [];
			return Promise.all(children.filter(c => c.name.startsWith(`${name}.`) && c.name.endsWith('.bak')).map(c => read(`${folder}/${c.name}`)));
		};

		test('keeps the files an import replaces, from one import to the next', async () => {
			await write('Library/Application Support/Kodia/User/settings.json', '{"mine":true}');
			await write('.kodia/extensions/extensions.json', '[{"identifier":{"id":"mine.ext"}}]');
			await write('Library/Application Support/Code/User/settings.json', '{"from":"code"}');
			await write('Library/Application Support/Code/User/keybindings.json', '[]');
			await write('.vscode/extensions/extensions.json', '[]');

			assert.strictEqual(await service.transferExtensions('mac', 'VS Code'), undefined);
			assert.strictEqual(await read('Library/Application Support/Kodia/User/settings.json'), '{"from":"code"}');
			assert.deepStrictEqual(await backupsOf('Library/Application Support/Kodia/User/settings.json'), ['{"mine":true}']);
			assert.deepStrictEqual(await backupsOf('.kodia/extensions/extensions.json'), ['[{"identifier":{"id":"mine.ext"}}]']);
			// nothing to keep where Kodia had no file yet
			assert.deepStrictEqual(await backupsOf('Library/Application Support/Kodia/User/keybindings.json'), []);

			await write('Library/Application Support/Code/User/settings.json', '{"from":"code, again"}');
			assert.strictEqual(await service.transferExtensions('mac', 'VS Code'), undefined);
			assert.strictEqual(await read('Library/Application Support/Kodia/User/settings.json'), '{"from":"code, again"}');
			assert.deepStrictEqual((await backupsOf('Library/Application Support/Kodia/User/settings.json')).sort(), ['{"from":"code"}', '{"mine":true}']);
		});

		test('removing blacklisted extensions works on Kodia\'s folder, and leaves Void\'s alone', async () => {
			await write('.kodia/extensions/github.copilot-1.0.0/package.json', '{}');
			await write('.kodia/extensions/esbenp.prettier-1.0.0/package.json', '{}');
			await write('.void-editor/extensions/github.copilot-1.0.0/package.json', '{}');

			await service.deleteBlacklistExtensions('mac');

			assert.strictEqual(await exists('.kodia/extensions/github.copilot-1.0.0'), false);
			assert.strictEqual(await exists('.kodia/extensions/esbenp.prettier-1.0.0'), true);
			assert.strictEqual(await exists('.void-editor/extensions/github.copilot-1.0.0'), true);
		});
	});
});
