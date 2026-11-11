import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { MAX_PROJECT_MEMORY_TOKENS, memoryTooLongMessage, memoryWithSection, PROJECT_MEMORY_FILE_HEADER as FILE_HEADER, PROJECT_MEMORY_FILE_PATH } from '../../../../platform/kodia/common/projectMemory.js';
import { PROJECT_MEMORY_STORAGE_KEY } from './storageKeys.js';
import { estimateTokens } from './tokenizer.js';

// the file format is shared with the Kodia agent of the Agents window
export { memoryWithSection, parseMemorySections, PROJECT_MEMORY_FILE_PATH } from '../../../../platform/kodia/common/projectMemory.js';


export interface IProjectMemoryService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	readonly whenReady: Promise<void>;
	memoryFileURI(): URI | undefined; // in the first workspace folder; undefined without a folder
	// the file's contents; before the first write, notes saved by older versions in this machine's storage
	getMemory(): string;
	// rewrites one section (empty content deletes it); rejects if the memory would exceed MAX_PROJECT_MEMORY_TOKENS
	writeSection(title: string, content: string): Promise<{ memory: string, tokenCount: number }>;
	// replaces the whole memory (settings page); '' deletes the file
	setMemory(memory: string): Promise<void>;
}

export const IProjectMemoryService = createDecorator<IProjectMemoryService>('ProjectMemoryService');

class ProjectMemoryService extends Disposable implements IProjectMemoryService {
	_serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>())
	readonly onDidChange = this._onDidChange.event

	private _fileContents: string | null = null // null: no file
	readonly whenReady: Promise<void>

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super()
		this.whenReady = this._reload()
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this._reload()))
		this._register(this.fileService.onDidFilesChange(e => {
			const uri = this.memoryFileURI()
			if (uri && e.affects(uri)) this._reload()
		}))
	}

	memoryFileURI() {
		const folder = this.workspaceContextService.getWorkspace().folders[0]
		return folder ? URI.joinPath(folder.uri, PROJECT_MEMORY_FILE_PATH) : undefined
	}

	private _legacyMemory() {
		return this.storageService.get(PROJECT_MEMORY_STORAGE_KEY, StorageScope.WORKSPACE) ?? ''
	}

	private async _reload() {
		const uri = this.memoryFileURI()
		let contents: string | null = null
		if (uri) {
			try { contents = (await this.fileService.readFile(uri)).value.toString() }
			catch { contents = null } // no file yet
		}
		if (contents !== this._fileContents) {
			this._fileContents = contents
			this._onDidChange.fire()
		}
	}

	getMemory() {
		return this._fileContents ?? this._legacyMemory()
	}

	async writeSection(title: string, content: string) {
		await this.whenReady
		const base = this._fileContents ?? (this._legacyMemory() ? `${FILE_HEADER}\n\n## Notes\n${this._legacyMemory()}` : FILE_HEADER)
		const memory = memoryWithSection(base, title, content)
		const tokenCount = estimateTokens(memory)
		if (tokenCount > MAX_PROJECT_MEMORY_TOKENS) {
			throw new Error(memoryTooLongMessage(tokenCount))
		}
		await this._write(memory)
		return { memory, tokenCount }
	}

	async setMemory(memory: string) {
		await this.whenReady
		if (!memory.trim()) {
			const uri = this.memoryFileURI()
			if (uri && this._fileContents !== null) await this.fileService.del(uri)
			this.storageService.remove(PROJECT_MEMORY_STORAGE_KEY, StorageScope.WORKSPACE)
			this._fileContents = null
			this._onDidChange.fire()
			return
		}
		await this._write(memory)
	}

	private async _write(memory: string) {
		const uri = this.memoryFileURI()
		if (!uri) throw new Error(`Open a folder to save project memory (it's stored in ${PROJECT_MEMORY_FILE_PATH}).`)
		await this.fileService.writeFile(uri, VSBuffer.fromString(memory))
		this.storageService.remove(PROJECT_MEMORY_STORAGE_KEY, StorageScope.WORKSPACE) // migrated into the file
		this._fileContents = memory
		this._onDidChange.fire()
	}
}

registerSingleton(IProjectMemoryService, ProjectMemoryService, InstantiationType.Delayed);
