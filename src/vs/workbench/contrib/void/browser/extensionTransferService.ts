/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { env } from '../../../../base/common/process.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { TransferEditorType, TransferFilesInfo } from './extensionTransferTypes.js';


export interface IExtensionTransferService {
	readonly _serviceBrand: undefined; // services need this, just leave it undefined
	transferExtensions(os: 'mac' | 'windows' | 'linux' | null, fromEditor: TransferEditorType): Promise<string | undefined>
	deleteBlacklistExtensions(os: 'mac' | 'windows' | 'linux' | null): Promise<void>

}

export const IExtensionTransferService = createDecorator<IExtensionTransferService>('ExtensionTransferService');





// Define extensions to skip when transferring
const extensionBlacklist = [
	// ignore extensions
	'ms-vscode-remote.remote', // ms-vscode-remote.remote-ssh, ms-vscode-remote.remote-wsl
	'ms-vscode.remote', // ms-vscode.remote-explorer
	// ignore other AI copilots that could conflict with Void keybindings
	'sourcegraph.cody-ai',
	'continue.continue',
	'codeium.codeium',
	'saoudrizwan.claude-dev', // cline
	'rooveterinaryinc.roo-cline', // roo
	'supermaven.supermaven', // supermaven
	'GitHub.copilot-chat',
	'github.copilot',
	'github.copilot-chat',
];


const isBlacklisted = (fsPath: string | undefined) => {
	return extensionBlacklist.find(bItem => fsPath?.includes(bItem))
}

// An import replaces the user's own settings.json, keybindings.json and extensions.json: the current file is first
// copied next to it, as <name>.<stamp>.bak, one stamp per import so a second import keeps the first backup. If the
// copy fails, the error stops this file's import, so nothing is replaced without a backup.
const backUpBeforeImport = async (fileService: IFileService, file: URI, stamp: string) => {
	if (!await fileService.exists(file)) return
	let backup = file.with({ path: `${file.path}.${stamp}.bak` })
	for (let i = 1; await fileService.exists(backup); i++) {
		backup = file.with({ path: `${file.path}.${stamp}-${i}.bak` })
	}
	await fileService.copy(file, backup, false)
}

export class ExtensionTransferService extends Disposable implements IExtensionTransferService {
	_serviceBrand: undefined;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IProductService private readonly _productService: IProductService,
	) {
		super()
	}

	async transferExtensions(os: 'mac' | 'windows' | 'linux' | null, fromEditor: TransferEditorType) {
		const transferTheseFiles = transferTheseFilesOfOS(os, fromEditor, this._productService)
		const fileService = this._fileService
		const backupStamp = new Date().toISOString().replace(/[:.]/g, '-')

		let errAcc = ''

		for (const { from, to, isExtensions } of transferTheseFiles) {
			// Check if the source file exists before attempting to copy
			try {
				if (!isExtensions) {
					console.log('transferring item', from, to)

					const exists = await fileService.exists(from)
					if (exists) {
						// Ensure the destination directory exists
						const toParent = URI.joinPath(to, '..')
						const toParentExists = await fileService.exists(toParent)
						if (!toParentExists) {
							await fileService.createFolder(toParent)
						}
						await backUpBeforeImport(fileService, to, backupStamp)
						await fileService.copy(from, to, true)
					} else {
						console.log(`Skipping file that doesn't exist: ${from.toString()}`)
					}
				}
				// extensions folder
				else {
					console.log('transferring extensions...', from, to)
					const exists = await fileService.exists(from)
					if (exists) {
						const stat = await fileService.resolve(from)
						const toParent = URI.joinPath(to) // extensions/
						const toParentExists = await fileService.exists(toParent)
						if (!toParentExists) {
							await fileService.createFolder(toParent)
						}
						for (const extensionFolder of stat.children ?? []) {
							const from = extensionFolder.resource
							const to = URI.joinPath(toParent, extensionFolder.name)
							const toStat = await fileService.resolve(from)

							if (toStat.isDirectory) {
								if (!isBlacklisted(extensionFolder.resource.fsPath)) {
									await fileService.copy(from, to, true)
								}
							}
							else if (toStat.isFile) {
								if (extensionFolder.name === 'extensions.json') {
									try {
										const contentsStr = await fileService.readFile(from)
										const json: any = JSON.parse(contentsStr.value.toString())
										const j2 = json.filter((entry: { identifier?: { id?: string } }) => !isBlacklisted(entry?.identifier?.id))
										const jsonStr = JSON.stringify(j2)
										await backUpBeforeImport(fileService, to, backupStamp)
										await fileService.writeFile(to, VSBuffer.fromString(jsonStr))
									}
									catch {
										console.log('Error copying extensions.json, skipping')
									}
								}
							}
						}

					} else {
						console.log(`Skipping file that doesn't exist: ${from.toString()}`)
					}
					console.log('done transferring extensions.')
				}
			}
			catch (e) {
				console.error('Error copying file:', e)
				errAcc += `Error copying ${from.toString()}: ${e}\n`
			}
		}

		if (errAcc) return errAcc
		return undefined
	}

	async deleteBlacklistExtensions(os: 'mac' | 'windows' | 'linux' | null) {
		const fileService = this._fileService
		const extensionsURI = getExtensionsFolder(os, this._productService)
		if (!extensionsURI) return
		const eURI = await fileService.resolve(extensionsURI)
		for (const child of eURI.children ?? []) {


			try {
				if (child.isDirectory) {
					// if is blacklisted
					if (isBlacklisted(child.resource.fsPath)) {
						console.log('Deleting extension', child.resource.fsPath)
						await fileService.del(child.resource, { recursive: true, useTrash: true })
					}
				}
				else if (child.isFile) {
					// if is extensions.json

					if (child.name === 'extensions.json') {
						console.log('Updating extensions.json', child.resource.fsPath)
						try {
							const contentsStr = await fileService.readFile(child.resource)
							const json: any = JSON.parse(contentsStr.value.toString())
							const j2 = json.filter((entry: { identifier?: { id?: string } }) => !isBlacklisted(entry?.identifier?.id))
							const jsonStr = JSON.stringify(j2)
							await fileService.writeFile(child.resource, VSBuffer.fromString(jsonStr))
						}
						catch {
							console.log('Error copying extensions.json, skipping')
						}
					}
				}
			}
			catch (e) {
				console.error('Could not delete extension', child.resource.fsPath, e)
			}
		}
	}
}


registerSingleton(IExtensionTransferService, ExtensionTransferService, InstantiationType.Eager); // lazily loaded, even if Eager









// The names of Kodia's own folders. Shipped builds set them in prepare_vscode.sh in kodia-builder: the insiders build
// has 'Kodia - Insiders' and '.kodia-insiders'.
export type TransferProductNames = Pick<IProductService, 'nameShort' | 'dataFolderName'>;

// The targets follow the default locations the app reads from: getUserDataPath in platform/environment/node/userDataPath.ts
// for settings and keybindings, extensionsPath in platform/environment/common/environmentService.ts for extensions.
export const transferTheseFilesOfOS = (os: 'mac' | 'windows' | 'linux' | null, fromEditor: TransferEditorType, product: TransferProductNames): TransferFilesInfo => {
	if (os === null)
		throw new Error(`One-click switch is not possible in this environment.`)

	// running out of sources, the user data folder has a fixed name
	const userDataFolderName = env.VSCODE_DEV ? 'code-oss-dev' : product.nameShort;

	if (os === 'mac') {
		const homeDir = env['HOME']
		if (!homeDir) throw new Error(`$HOME not found`)

		if (fromEditor === 'VS Code') {
			return [{
				from: URI.joinPath(URI.from({ scheme: 'file' }), homeDir, 'Library', 'Application Support', 'Code', 'User', 'settings.json'),
				to: URI.joinPath(URI.from({ scheme: 'file' }), homeDir, 'Library', 'Application Support', userDataFolderName, 'User', 'settings.json'),
			}, {
				from: URI.joinPath(URI.from({ scheme: 'file' }), homeDir, 'Library', 'Application Support', 'Code', 'User', 'keybindings.json'),
				to: URI.joinPath(URI.from({ scheme: 'file' }), homeDir, 'Library', 'Application Support', userDataFolderName, 'User', 'keybindings.json'),
			}, {
				from: URI.joinPath(URI.from({ scheme: 'file' }), homeDir, '.vscode', 'extensions'),
				to: URI.joinPath(URI.from({ scheme: 'file' }), homeDir, product.dataFolderName, 'extensions'),
				isExtensions: true,
			}]
		} else if (fromEditor === 'Cursor') {
			return [{
				from: URI.joinPath(URI.from({ scheme: 'file' }), homeDir, 'Library', 'Application Support', 'Cursor', 'User', 'settings.json'),
				to: URI.joinPath(URI.from({ scheme: 'file' }), homeDir, 'Library', 'Application Support', userDataFolderName, 'User', 'settings.json'),
			}, {
				from: URI.joinPath(URI.from({ scheme: 'file' }), homeDir, 'Library', 'Application Support', 'Cursor', 'User', 'keybindings.json'),
				to: URI.joinPath(URI.from({ scheme: 'file' }), homeDir, 'Library', 'Application Support', userDataFolderName, 'User', 'keybindings.json'),
			}, {
				from: URI.joinPath(URI.from({ scheme: 'file' }), homeDir, '.cursor', 'extensions'),
				to: URI.joinPath(URI.from({ scheme: 'file' }), homeDir, product.dataFolderName, 'extensions'),
				isExtensions: true,
			}]
		} else if (fromEditor === 'Windsurf') {
			return [{
				from: URI.joinPath(URI.from({ scheme: 'file' }), homeDir, 'Library', 'Application Support', 'Windsurf', 'User', 'settings.json'),
				to: URI.joinPath(URI.from({ scheme: 'file' }), homeDir, 'Library', 'Application Support', userDataFolderName, 'User', 'settings.json'),
			}, {
				from: URI.joinPath(URI.from({ scheme: 'file' }), homeDir, 'Library', 'Application Support', 'Windsurf', 'User', 'keybindings.json'),
				to: URI.joinPath(URI.from({ scheme: 'file' }), homeDir, 'Library', 'Application Support', userDataFolderName, 'User', 'keybindings.json'),
			}, {
				from: URI.joinPath(URI.from({ scheme: 'file' }), homeDir, '.windsurf', 'extensions'),
				to: URI.joinPath(URI.from({ scheme: 'file' }), homeDir, product.dataFolderName, 'extensions'),
				isExtensions: true,
			}]
		}
	}

	if (os === 'linux') {
		const homeDir = env['HOME']
		if (!homeDir) throw new Error(`variable for $HOME location not found`)
		const configHome = env.XDG_CONFIG_HOME || `${homeDir}/.config`;

		if (fromEditor === 'VS Code') {
			return [{
				from: URI.joinPath(URI.from({ scheme: 'file' }), configHome, 'Code', 'User', 'settings.json'),
				to: URI.joinPath(URI.from({ scheme: 'file' }), configHome, userDataFolderName, 'User', 'settings.json'),
			}, {
				from: URI.joinPath(URI.from({ scheme: 'file' }), configHome, 'Code', 'User', 'keybindings.json'),
				to: URI.joinPath(URI.from({ scheme: 'file' }), configHome, userDataFolderName, 'User', 'keybindings.json'),
			}, {
				from: URI.joinPath(URI.from({ scheme: 'file' }), homeDir, '.vscode', 'extensions'),
				to: URI.joinPath(URI.from({ scheme: 'file' }), homeDir, product.dataFolderName, 'extensions'),
				isExtensions: true,
			}]
		} else if (fromEditor === 'Cursor') {
			return [{
				from: URI.joinPath(URI.from({ scheme: 'file' }), configHome, 'Cursor', 'User', 'settings.json'),
				to: URI.joinPath(URI.from({ scheme: 'file' }), configHome, userDataFolderName, 'User', 'settings.json'),
			}, {
				from: URI.joinPath(URI.from({ scheme: 'file' }), configHome, 'Cursor', 'User', 'keybindings.json'),
				to: URI.joinPath(URI.from({ scheme: 'file' }), configHome, userDataFolderName, 'User', 'keybindings.json'),
			}, {
				from: URI.joinPath(URI.from({ scheme: 'file' }), homeDir, '.cursor', 'extensions'),
				to: URI.joinPath(URI.from({ scheme: 'file' }), homeDir, product.dataFolderName, 'extensions'),
				isExtensions: true,
			}]
		} else if (fromEditor === 'Windsurf') {
			return [{
				from: URI.joinPath(URI.from({ scheme: 'file' }), configHome, 'Windsurf', 'User', 'settings.json'),
				to: URI.joinPath(URI.from({ scheme: 'file' }), configHome, userDataFolderName, 'User', 'settings.json'),
			}, {
				from: URI.joinPath(URI.from({ scheme: 'file' }), configHome, 'Windsurf', 'User', 'keybindings.json'),
				to: URI.joinPath(URI.from({ scheme: 'file' }), configHome, userDataFolderName, 'User', 'keybindings.json'),
			}, {
				from: URI.joinPath(URI.from({ scheme: 'file' }), homeDir, '.windsurf', 'extensions'),
				to: URI.joinPath(URI.from({ scheme: 'file' }), homeDir, product.dataFolderName, 'extensions'),
				isExtensions: true,
			}]
		}
	}

	if (os === 'windows') {
		const appdata = env['APPDATA']
		if (!appdata) throw new Error(`variable for %APPDATA% location not found`)
		const userprofile = env['USERPROFILE']
		if (!userprofile) throw new Error(`variable for %USERPROFILE% location not found`)

		if (fromEditor === 'VS Code') {
			return [{
				from: URI.joinPath(URI.from({ scheme: 'file' }), appdata, 'Code', 'User', 'settings.json'),
				to: URI.joinPath(URI.from({ scheme: 'file' }), appdata, userDataFolderName, 'User', 'settings.json'),
			}, {
				from: URI.joinPath(URI.from({ scheme: 'file' }), appdata, 'Code', 'User', 'keybindings.json'),
				to: URI.joinPath(URI.from({ scheme: 'file' }), appdata, userDataFolderName, 'User', 'keybindings.json'),
			}, {
				from: URI.joinPath(URI.from({ scheme: 'file' }), userprofile, '.vscode', 'extensions'),
				to: URI.joinPath(URI.from({ scheme: 'file' }), userprofile, product.dataFolderName, 'extensions'),
				isExtensions: true,
			}]
		} else if (fromEditor === 'Cursor') {
			return [{
				from: URI.joinPath(URI.from({ scheme: 'file' }), appdata, 'Cursor', 'User', 'settings.json'),
				to: URI.joinPath(URI.from({ scheme: 'file' }), appdata, userDataFolderName, 'User', 'settings.json'),
			}, {
				from: URI.joinPath(URI.from({ scheme: 'file' }), appdata, 'Cursor', 'User', 'keybindings.json'),
				to: URI.joinPath(URI.from({ scheme: 'file' }), appdata, userDataFolderName, 'User', 'keybindings.json'),
			}, {
				from: URI.joinPath(URI.from({ scheme: 'file' }), userprofile, '.cursor', 'extensions'),
				to: URI.joinPath(URI.from({ scheme: 'file' }), userprofile, product.dataFolderName, 'extensions'),
				isExtensions: true,
			}]
		} else if (fromEditor === 'Windsurf') {
			return [{
				from: URI.joinPath(URI.from({ scheme: 'file' }), appdata, 'Windsurf', 'User', 'settings.json'),
				to: URI.joinPath(URI.from({ scheme: 'file' }), appdata, userDataFolderName, 'User', 'settings.json'),
			}, {
				from: URI.joinPath(URI.from({ scheme: 'file' }), appdata, 'Windsurf', 'User', 'keybindings.json'),
				to: URI.joinPath(URI.from({ scheme: 'file' }), appdata, userDataFolderName, 'User', 'keybindings.json'),
			}, {
				from: URI.joinPath(URI.from({ scheme: 'file' }), userprofile, '.windsurf', 'extensions'),
				to: URI.joinPath(URI.from({ scheme: 'file' }), userprofile, product.dataFolderName, 'extensions'),
				isExtensions: true,
			}]
		}
	}

	throw new Error(`os '${os}' not recognized or editor type '${fromEditor}' not supported for this OS`)
}


const getExtensionsFolder = (os: 'mac' | 'windows' | 'linux' | null, product: TransferProductNames) => {
	const t = transferTheseFilesOfOS(os, 'VS Code', product) // from editor doesnt matter
	return t.find(f => f.isExtensions)?.to
}
