import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js'
import { URI } from '../../../../base/common/uri.js'
import { IReference } from '../../../../base/common/lifecycle.js'
import { Position } from '../../../../editor/common/core/position.js'
import { IRange } from '../../../../editor/common/core/range.js'
import { ITextModel } from '../../../../editor/common/model.js'
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js'
import { IResolvedTextEditorModel, ITextModelService } from '../../../../editor/common/services/resolverService.js'
import { getDefinitionsAtPosition, getReferencesAtPosition } from '../../../../editor/contrib/gotoSymbol/browser/goToSymbol.js'
import { getWorkspaceSymbols, WorkspaceSymbolProviderRegistry } from '../../search/common/search.js'
import { IFileService } from '../../../../platform/files/common/files.js'
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js'
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js'
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js'
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js'
import { ISearchService } from '../../../services/search/common/search.js'
import { IEditCodeService } from './editCodeServiceInterface.js'
import { ITerminalToolService } from './terminalToolService.js'
import { LintErrorItem, BuiltinToolCallParams, BuiltinToolResultType, BuiltinToolName, CodeLocation } from '../common/toolsServiceTypes.js'
import { IVoidModelService } from '../common/voidModelService.js'
import { EndOfLinePreference } from '../../../../editor/common/model.js'
import { IVoidCommandBarService } from './voidCommandBarServiceInterface.js'
import { computeDirectoryTree1Deep, IDirectoryStrService, stringifyDirectoryTree1Deep } from '../common/directoryStrService.js'
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js'
import { raceTimeout, timeout } from '../../../../base/common/async.js'
import { RawToolParamsObj } from '../common/sendLLMMessageTypes.js'
import { MAX_CHILDREN_URIs_PAGE, MAX_FILE_CHARS_PAGE, MAX_PROJECT_MEMORY_TOKENS, MAX_TERMINAL_BG_COMMAND_TIME, MAX_TERMINAL_INACTIVE_TIME } from '../common/prompt/prompts.js'
import { IVoidSettingsService } from '../common/voidSettingsService.js'
import { generateUuid } from '../../../../base/common/uuid.js'
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js'
import { PROJECT_MEMORY_STORAGE_KEY } from '../common/storageKeys.js'
import { estimateTokens } from '../common/tokenizer.js'


// tool use for AI
type ValidateBuiltinParams = { [T in BuiltinToolName]: (p: RawToolParamsObj) => BuiltinToolCallParams[T] }
type CallBuiltinTool = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T]) => Promise<{ result: BuiltinToolResultType[T] | Promise<BuiltinToolResultType[T]>, interruptTool?: () => void }> }
type BuiltinToolResultToString = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T], result: Awaited<BuiltinToolResultType[T]>) => string }


const isFalsy = (u: unknown) => {
	return !u || u === 'null' || u === 'undefined'
}

const validateStr = (argName: string, value: unknown) => {
	if (value === null) throw new Error(`Invalid LLM output: ${argName} was null.`)
	if (typeof value !== 'string') throw new Error(`Invalid LLM output format: ${argName} must be a string, but its type is "${typeof value}". Full value: ${JSON.stringify(value)}.`)
	return value
}


// We are NOT checking to make sure in workspace
const validateURI = (uriStr: unknown) => {
	if (uriStr === null) throw new Error(`Invalid LLM output: uri was null.`)
	if (typeof uriStr !== 'string') throw new Error(`Invalid LLM output format: Provided uri must be a string, but it's a(n) ${typeof uriStr}. Full value: ${JSON.stringify(uriStr)}.`)

	// Check if it's already a full URI with scheme (e.g., vscode-remote://, file://, etc.)
	// Look for :// pattern which indicates a scheme is present
	// Examples of supported URIs:
	// - vscode-remote://wsl+Ubuntu/home/user/file.txt (WSL)
	// - vscode-remote://ssh-remote+myserver/home/user/file.txt (SSH)
	// - file:///home/user/file.txt (local file with scheme)
	// - /home/user/file.txt (local file path, will be converted to file://)
	// - C:\Users\file.txt (Windows local path, will be converted to file://)
	if (uriStr.includes('://')) {
		try {
			const uri = URI.parse(uriStr)
			return uri
		} catch (e) {
			// If parsing fails, it's a malformed URI
			throw new Error(`Invalid URI format: ${uriStr}. Error: ${e}`)
		}
	} else {
		// No scheme present, treat as file path
		// This handles regular file paths like /home/user/file.txt or C:\Users\file.txt
		const uri = URI.file(uriStr)
		return uri
	}
}

const validateOptionalURI = (uriStr: unknown) => {
	if (isFalsy(uriStr)) return null
	return validateURI(uriStr)
}

const validateOptionalStr = (argName: string, str: unknown) => {
	if (isFalsy(str)) return null
	return validateStr(argName, str)
}


const validatePageNum = (pageNumberUnknown: unknown) => {
	if (!pageNumberUnknown) return 1
	const parsedInt = Number.parseInt(pageNumberUnknown + '')
	if (!Number.isInteger(parsedInt)) throw new Error(`Page number was not an integer: "${pageNumberUnknown}".`)
	if (parsedInt < 1) throw new Error(`Invalid LLM output format: Specified page number must be 1 or greater: "${pageNumberUnknown}".`)
	return parsedInt
}

const validateNumber = (numStr: unknown, opts: { default: number | null }) => {
	if (typeof numStr === 'number')
		return numStr
	if (isFalsy(numStr)) return opts.default

	if (typeof numStr === 'string') {
		const parsedInt = Number.parseInt(numStr + '')
		if (!Number.isInteger(parsedInt)) return opts.default
		return parsedInt
	}

	return opts.default
}

const validateProposedTerminalId = (terminalIdUnknown: unknown) => {
	if (!terminalIdUnknown) throw new Error(`A value for terminalID must be specified, but the value was "${terminalIdUnknown}"`)
	const terminalId = terminalIdUnknown + ''
	return terminalId
}

const validateBoolean = (b: unknown, opts: { default: boolean }) => {
	if (typeof b === 'string') {
		if (b === 'true') return true
		if (b === 'false') return false
	}
	if (typeof b === 'boolean') {
		return b
	}
	return opts.default
}


const validateLine = (lineUnknown: unknown) => {
	const line = validateNumber(lineUnknown, { default: null })
	if (line === null || line < 1) throw new Error(`Invalid LLM output: line must be a line number (1 or greater), but it was ${JSON.stringify(lineUnknown)}.`)
	return line
}


// --- language-server (LSP) tools ---

const LANGUAGE_SERVER_TIMEOUT_MS = 20_000
const MAX_LANGUAGE_SERVER_RESULTS = 50
const DEFINITION_SNIPPET_LINES = 5

// indexed by SymbolKind (a const enum); symbolKindNames from languages.ts is localized, and this text goes to the LLM
const symbolKindNames = ['file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enum member', 'struct', 'event', 'operator', 'type parameter']

const isIdentifierChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_$]/u.test(c)

// 1-based column of `name` on the line, preferring a whole-identifier match over a substring
const columnOfIdentifier = (lineContent: string, name: string): number | null => {
	let substringMatch: number | null = null
	for (let i = lineContent.indexOf(name); i !== -1; i = lineContent.indexOf(name, i + 1)) {
		if (!isIdentifierChar(lineContent[i - 1]) && !isIdentifierChar(lineContent[i + name.length])) return i + 1
		substringMatch ??= i + 1
	}
	return substringMatch
}

// Where `symbol` is, at or near `line`: LLMs are often off by a line or two. For `a.b` or `a::b`, the last part.
const positionOfSymbol = (model: ITextModel, line: number, symbol: string): Position => {
	const name = symbol.split(/\.|::|->/).map(s => s.trim()).filter(s => s).pop() ?? symbol.trim()
	const lineCount = model.getLineCount()
	for (const delta of [0, -1, 1, -2, 2, -3, 3]) {
		const l = line + delta
		if (l < 1 || l > lineCount) continue
		const column = columnOfIdentifier(model.getLineContent(l), name)
		if (column !== null) return new Position(l, column)
	}
	const lineContent = line <= lineCount ? `"${model.getLineContent(line).trim()}"` : `past the end of the file (${lineCount} lines)`
	throw new Error(`"${symbol}" was not found on line ${line} or the lines around it. Line ${line} is ${lineContent}.`)
}

// one result per line, in order
const uniqueByLine = <T extends { uri: URI, range: IRange }>(links: T[]): T[] => {
	const seen = new Set<string>()
	return links.filter(l => {
		const key = `${l.uri.toString()}:${l.range.startLineNumber}`
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})
}

// language servers can hang, or still be starting: give up rather than block the agent
const withLanguageServerTimeout = async <T>(run: (token: CancellationToken) => Promise<T>): Promise<T> => {
	const cts = new CancellationTokenSource()
	try {
		const result = await raceTimeout(run(cts.token), LANGUAGE_SERVER_TIMEOUT_MS, () => cts.cancel())
		if (result === undefined) throw new Error(`The language server did not answer within ${LANGUAGE_SERVER_TIMEOUT_MS / 1000}s (it may still be starting). Try again, or use search_for_files.`)
		return result
	}
	finally {
		cts.dispose()
	}
}

const noLanguageServerMessage = (what: string) => `No language server provides ${what} here, so this tool can't answer. Use search_for_files or search_in_file instead.`


const checkIfIsFolder = (uriStr: string) => {
	uriStr = uriStr.trim()
	if (uriStr.endsWith('/') || uriStr.endsWith('\\')) return true
	return false
}

export interface IToolsService {
	readonly _serviceBrand: undefined;
	validateParams: ValidateBuiltinParams;
	callTool: CallBuiltinTool;
	stringOfResult: BuiltinToolResultToString;
}

export const IToolsService = createDecorator<IToolsService>('ToolsService');

export class ToolsService implements IToolsService {

	readonly _serviceBrand: undefined;

	public validateParams: ValidateBuiltinParams;
	public callTool: CallBuiltinTool;
	public stringOfResult: BuiltinToolResultToString;

	constructor(
		@IFileService fileService: IFileService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@ISearchService searchService: ISearchService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IVoidModelService voidModelService: IVoidModelService,
		@IEditCodeService editCodeService: IEditCodeService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IVoidCommandBarService private readonly commandBarService: IVoidCommandBarService,
		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IStorageService private readonly storageService: IStorageService,
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@ITextModelService textModelService: ITextModelService,
	) {
		const queryBuilder = instantiationService.createInstance(QueryBuilder);

		const modelOfFile = async (uri: URI) => {
			await voidModelService.initializeModel(uri)
			const { model } = await voidModelService.getModelSafe(uri)
			if (model === null) { throw new Error(`No contents; File does not exist.`) }
			return model
		}

		// The code at each location, `nLines` lines from its start. Each file is loaded once and released
		// afterwards (unlike voidModelService, which keeps files open), since references can span many files.
		const codeLocationsOf = async (links: { uri: URI, range: IRange }[], nLines: number): Promise<CodeLocation[]> => {
			const refOfURI = new Map<string, IReference<IResolvedTextEditorModel> | null>()
			try {
				const locations: CodeLocation[] = []
				for (const { uri, range } of links) {
					const key = uri.toString()
					if (!refOfURI.has(key)) refOfURI.set(key, await textModelService.createModelReference(uri).catch(() => null))
					const model = refOfURI.get(key)?.object.textEditorModel

					const line = range.startLineNumber
					const lastLine = model ? Math.min(line + nLines - 1, model.getLineCount()) : line
					const snippet = model ? model.getValueInRange({ startLineNumber: line, startColumn: 1, endLineNumber: lastLine, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF) : ''
					locations.push({ uri, line, snippet })
				}
				return locations
			}
			finally {
				for (const ref of refOfURI.values()) ref?.dispose()
			}
		}

		this.validateParams = {
			read_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, start_line: startLineUnknown, end_line: endLineUnknown, page_number: pageNumberUnknown } = params
				const uri = validateURI(uriStr)
				const pageNumber = validatePageNum(pageNumberUnknown)

				let startLine = validateNumber(startLineUnknown, { default: null })
				let endLine = validateNumber(endLineUnknown, { default: null })

				if (startLine !== null && startLine < 1) startLine = null
				if (endLine !== null && endLine < 1) endLine = null

				return { uri, startLine, endLine, pageNumber }
			},
			ls_dir: (params: RawToolParamsObj) => {
				const { uri: uriStr, page_number: pageNumberUnknown } = params

				const uri = validateURI(uriStr)
				const pageNumber = validatePageNum(pageNumberUnknown)
				return { uri, pageNumber }
			},
			get_dir_tree: (params: RawToolParamsObj) => {
				const { uri: uriStr, } = params
				const uri = validateURI(uriStr)
				return { uri }
			},
			search_pathnames_only: (params: RawToolParamsObj) => {
				const {
					query: queryUnknown,
					search_in_folder: includeUnknown,
					page_number: pageNumberUnknown
				} = params

				const queryStr = validateStr('query', queryUnknown)
				const pageNumber = validatePageNum(pageNumberUnknown)
				const includePattern = validateOptionalStr('include_pattern', includeUnknown)

				return { query: queryStr, includePattern, pageNumber }

			},
			search_for_files: (params: RawToolParamsObj) => {
				const {
					query: queryUnknown,
					search_in_folder: searchInFolderUnknown,
					is_regex: isRegexUnknown,
					page_number: pageNumberUnknown
				} = params
				const queryStr = validateStr('query', queryUnknown)
				const pageNumber = validatePageNum(pageNumberUnknown)
				const searchInFolder = validateOptionalURI(searchInFolderUnknown)
				const isRegex = validateBoolean(isRegexUnknown, { default: false })
				return {
					query: queryStr,
					isRegex,
					searchInFolder,
					pageNumber
				}
			},
			search_in_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, query: queryUnknown, is_regex: isRegexUnknown } = params;
				const uri = validateURI(uriStr);
				const query = validateStr('query', queryUnknown);
				const isRegex = validateBoolean(isRegexUnknown, { default: false });
				return { uri, query, isRegex };
			},
			go_to_definition: (params: RawToolParamsObj) => {
				const { uri: uriStr, line: lineUnknown, symbol: symbolUnknown } = params
				const uri = validateURI(uriStr)
				const line = validateLine(lineUnknown)
				const symbol = validateStr('symbol', symbolUnknown).trim()
				if (!symbol) throw new Error(`Invalid LLM output: symbol was empty.`)
				return { uri, line, symbol }
			},
			find_references: (params: RawToolParamsObj) => {
				const { uri: uriStr, line: lineUnknown, symbol: symbolUnknown } = params
				const uri = validateURI(uriStr)
				const line = validateLine(lineUnknown)
				const symbol = validateStr('symbol', symbolUnknown).trim()
				if (!symbol) throw new Error(`Invalid LLM output: symbol was empty.`)
				return { uri, line, symbol }
			},
			search_symbols: (params: RawToolParamsObj) => {
				const { query: queryUnknown } = params
				const query = validateStr('query', queryUnknown).trim()
				if (!query) throw new Error(`Invalid LLM output: query was empty.`)
				return { query }
			},

			read_lint_errors: (params: RawToolParamsObj) => {
				const {
					uri: uriUnknown,
				} = params
				const uri = validateURI(uriUnknown)
				return { uri }
			},

			read_project_memory: (params: RawToolParamsObj) => {
				return {}
			},

			// ---

			create_file_or_folder: (params: RawToolParamsObj) => {
				const { uri: uriUnknown } = params
				const uri = validateURI(uriUnknown)
				const uriStr = validateStr('uri', uriUnknown)
				const isFolder = checkIfIsFolder(uriStr)
				return { uri, isFolder }
			},

			delete_file_or_folder: (params: RawToolParamsObj) => {
				const { uri: uriUnknown, is_recursive: isRecursiveUnknown } = params
				const uri = validateURI(uriUnknown)
				const isRecursive = validateBoolean(isRecursiveUnknown, { default: false })
				const uriStr = validateStr('uri', uriUnknown)
				const isFolder = checkIfIsFolder(uriStr)
				return { uri, isRecursive, isFolder }
			},

			rewrite_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, new_content: newContentUnknown } = params
				const uri = validateURI(uriStr)
				const newContent = validateStr('newContent', newContentUnknown)
				return { uri, newContent }
			},

			edit_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, search_replace_blocks: searchReplaceBlocksUnknown } = params
				const uri = validateURI(uriStr)
				const searchReplaceBlocks = validateStr('searchReplaceBlocks', searchReplaceBlocksUnknown)
				return { uri, searchReplaceBlocks }
			},

			write_project_memory: (params: RawToolParamsObj) => {
				const { content: contentUnknown, mode: modeUnknown } = params
				const content = validateStr('content', contentUnknown)
				const mode = modeUnknown === 'replace' ? 'replace' as const : 'append' as const
				return { content, mode }
			},

			// ---

			run_command: (params: RawToolParamsObj) => {
				const { command: commandUnknown, cwd: cwdUnknown } = params
				const command = validateStr('command', commandUnknown)
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				const terminalId = generateUuid()
				return { command, cwd, terminalId }
			},
			run_persistent_command: (params: RawToolParamsObj) => {
				const { command: commandUnknown, persistent_terminal_id: persistentTerminalIdUnknown } = params;
				const command = validateStr('command', commandUnknown);
				const persistentTerminalId = validateProposedTerminalId(persistentTerminalIdUnknown)
				return { command, persistentTerminalId };
			},
			open_persistent_terminal: (params: RawToolParamsObj) => {
				const { cwd: cwdUnknown } = params;
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				// No parameters needed; will open a new background terminal
				return { cwd };
			},
			kill_persistent_terminal: (params: RawToolParamsObj) => {
				const { persistent_terminal_id: terminalIdUnknown } = params;
				const persistentTerminalId = validateProposedTerminalId(terminalIdUnknown);
				return { persistentTerminalId };
			},

		}


		this.callTool = {
			read_file: async ({ uri, startLine, endLine, pageNumber }) => {
				await voidModelService.initializeModel(uri)
				const { model } = await voidModelService.getModelSafe(uri)
				if (model === null) { throw new Error(`No contents; File does not exist.`) }

				let contents: string
				if (startLine === null && endLine === null) {
					contents = model.getValue(EndOfLinePreference.LF)
				}
				else {
					const startLineNumber = startLine === null ? 1 : startLine
					const endLineNumber = endLine === null ? model.getLineCount() : endLine
					contents = model.getValueInRange({ startLineNumber, startColumn: 1, endLineNumber, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF)
				}

				const totalNumLines = model.getLineCount()

				const fromIdx = MAX_FILE_CHARS_PAGE * (pageNumber - 1)
				const toIdx = MAX_FILE_CHARS_PAGE * pageNumber - 1
				const fileContents = contents.slice(fromIdx, toIdx + 1) // paginate
				const hasNextPage = (contents.length - 1) - toIdx >= 1
				const totalFileLen = contents.length
				return { result: { fileContents, totalFileLen, hasNextPage, totalNumLines } }
			},

			ls_dir: async ({ uri, pageNumber }) => {
				const dirResult = await computeDirectoryTree1Deep(fileService, uri, pageNumber)
				return { result: dirResult }
			},

			get_dir_tree: async ({ uri }) => {
				const str = await this.directoryStrService.getDirectoryStrTool(uri)
				return { result: { str } }
			},

			search_pathnames_only: async ({ query: queryStr, includePattern, pageNumber }) => {

				const query = queryBuilder.file(workspaceContextService.getWorkspace().folders.map(f => f.uri), {
					filePattern: queryStr,
					includePattern: includePattern ?? undefined,
					sortByScore: true, // makes results 10x better
				})
				const data = await searchService.fileSearch(query, CancellationToken.None)

				const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1)
				const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1
				const uris = data.results
					.slice(fromIdx, toIdx + 1) // paginate
					.map(({ resource, results }) => resource)

				const hasNextPage = (data.results.length - 1) - toIdx >= 1
				return { result: { uris, hasNextPage } }
			},

			search_for_files: async ({ query: queryStr, isRegex, searchInFolder, pageNumber }) => {
				const searchFolders = searchInFolder === null ?
					workspaceContextService.getWorkspace().folders.map(f => f.uri)
					: [searchInFolder]

				const query = queryBuilder.text({
					pattern: queryStr,
					isRegExp: isRegex,
				}, searchFolders)

				const data = await searchService.textSearch(query, CancellationToken.None)

				const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1)
				const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1
				const uris = data.results
					.slice(fromIdx, toIdx + 1) // paginate
					.map(({ resource, results }) => resource)

				const hasNextPage = (data.results.length - 1) - toIdx >= 1
				return { result: { queryStr, uris, hasNextPage } }
			},
			search_in_file: async ({ uri, query, isRegex }) => {
				await voidModelService.initializeModel(uri);
				const { model } = await voidModelService.getModelSafe(uri);
				if (model === null) { throw new Error(`No contents; File does not exist.`); }
				const contents = model.getValue(EndOfLinePreference.LF);
				const contentOfLine = contents.split('\n');
				const totalLines = contentOfLine.length;
				const regex = isRegex ? new RegExp(query) : null;
				const lines: number[] = []
				for (let i = 0; i < totalLines; i++) {
					const line = contentOfLine[i];
					if ((isRegex && regex!.test(line)) || (!isRegex && line.includes(query))) {
						const matchLine = i + 1;
						lines.push(matchLine);
					}
				}
				return { result: { lines } };
			},

			go_to_definition: async ({ uri, line, symbol }) => {
				const model = await modelOfFile(uri)
				const position = positionOfSymbol(model, line, symbol)
				const registry = languageFeaturesService.definitionProvider
				if (!registry.has(model)) return { result: { locations: [], hasLanguageServer: false } }

				const links = await withLanguageServerTimeout(token => getDefinitionsAtPosition(registry, model, position, false, token))
				// targetSelectionRange is the symbol's name; range can span a whole class
				const definitions = uniqueByLine(links.map(l => ({ uri: l.uri, range: l.targetSelectionRange ?? l.range })))
				const locations = await codeLocationsOf(definitions.slice(0, MAX_LANGUAGE_SERVER_RESULTS), DEFINITION_SNIPPET_LINES)
				return { result: { locations, hasLanguageServer: true } }
			},

			find_references: async ({ uri, line, symbol }) => {
				const model = await modelOfFile(uri)
				const position = positionOfSymbol(model, line, symbol)
				const registry = languageFeaturesService.referenceProvider
				if (!registry.has(model)) return { result: { locations: [], totalCount: 0, hasLanguageServer: false } }

				const links = await withLanguageServerTimeout(token => getReferencesAtPosition(registry, model, position, false, false, token))
				const references = uniqueByLine(links)
				const locations = await codeLocationsOf(references.slice(0, MAX_LANGUAGE_SERVER_RESULTS), 1)
				return { result: { locations, totalCount: references.length, hasLanguageServer: true } }
			},

			search_symbols: async ({ query }) => {
				if (WorkspaceSymbolProviderRegistry.all().length === 0) return { result: { symbols: [], totalCount: 0, hasLanguageServer: false } }

				const items = await withLanguageServerTimeout(token => getWorkspaceSymbols(query, token))
				// exact name first, then case-insensitive, then prefix, then the rest (sort is stable)
				const lowerQuery = query.toLowerCase()
				const rank = (name: string) => name === query ? 0 : name.toLowerCase() === lowerQuery ? 1 : name.toLowerCase().startsWith(lowerQuery) ? 2 : 3
				const symbols = items.map(i => i.symbol).sort((a, b) => rank(a.name) - rank(b.name))
				return {
					result: {
						symbols: symbols.slice(0, MAX_LANGUAGE_SERVER_RESULTS).map(s => ({
							name: s.name,
							kind: symbolKindNames[s.kind] ?? 'symbol',
							containerName: s.containerName || undefined,
							uri: s.location.uri,
							line: s.location.range?.startLineNumber,
						})),
						totalCount: symbols.length,
						hasLanguageServer: true,
					}
				}
			},

			read_lint_errors: async ({ uri }) => {
				await timeout(1000)
				const { lintErrors } = this._getLintErrors(uri)
				return { result: { lintErrors } }
			},

			read_project_memory: async () => {
				const content = this._readProjectMemory()
				return { result: { content } }
			},

			// ---

			create_file_or_folder: async ({ uri, isFolder }) => {
				if (isFolder)
					await fileService.createFolder(uri)
				else {
					await fileService.createFile(uri)
				}
				return { result: {} }
			},

			delete_file_or_folder: async ({ uri, isRecursive }) => {
				await fileService.del(uri, { recursive: isRecursive })
				return { result: {} }
			},

			rewrite_file: async ({ uri, newContent }) => {
				await voidModelService.initializeModel(uri)
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
				}
				await editCodeService.callBeforeApplyOrEdit(uri)
				editCodeService.instantlyRewriteFile({ uri, newContent })
				// at end, get lint errors
				const lintErrorsPromise = Promise.resolve().then(async () => {
					await timeout(2000)
					const { lintErrors } = this._getLintErrors(uri)
					return { lintErrors }
				})
				return { result: lintErrorsPromise }
			},

			edit_file: async ({ uri, searchReplaceBlocks }) => {
				await voidModelService.initializeModel(uri)
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
				}
				await editCodeService.callBeforeApplyOrEdit(uri)
				editCodeService.instantlyApplySearchReplaceBlocks({ uri, searchReplaceBlocks })

				// at end, get lint errors
				const lintErrorsPromise = Promise.resolve().then(async () => {
					await timeout(2000)
					const { lintErrors } = this._getLintErrors(uri)
					return { lintErrors }
				})

				return { result: lintErrorsPromise }
			},

			write_project_memory: async ({ content, mode }) => {
				const existing = mode === 'append' ? this._readProjectMemory() : ''
				const combined = existing ? `${existing}\n\n${content}` : content
				const { content: trimmedContent, tokenCount } = this._trimMemoryToTokenBudget(combined)
				this._writeProjectMemory(trimmedContent)
				return { result: { content: trimmedContent, tokenCount } }
			},
			// ---
			run_command: async ({ command, cwd, terminalId }) => {
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'temporary', cwd, terminalId })
				return { result: resPromise, interruptTool: interrupt }
			},
			run_persistent_command: async ({ command, persistentTerminalId }) => {
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'persistent', persistentTerminalId })
				return { result: resPromise, interruptTool: interrupt }
			},
			open_persistent_terminal: async ({ cwd }) => {
				const persistentTerminalId = await this.terminalToolService.createPersistentTerminal({ cwd })
				return { result: { persistentTerminalId } }
			},
			kill_persistent_terminal: async ({ persistentTerminalId }) => {
				// Close the background terminal by sending exit
				await this.terminalToolService.killPersistentTerminal(persistentTerminalId)
				return { result: {} }
			},
		}


		const nextPageStr = (hasNextPage: boolean) => hasNextPage ? '\n\n(more on next page...)' : ''

		const stringifyLintErrors = (lintErrors: LintErrorItem[]) => {
			return lintErrors
				.map((e, i) => `Error ${i + 1}:\nLines Affected: ${e.startLineNumber}-${e.endLineNumber}\nError message:${e.message}`)
				.join('\n\n')
				.substring(0, MAX_FILE_CHARS_PAGE)
		}

		// given to the LLM after the call for successful tool calls
		this.stringOfResult = {
			read_file: (params, result) => {
				return `${params.uri.fsPath}\n\`\`\`\n${result.fileContents}\n\`\`\`${nextPageStr(result.hasNextPage)}${result.hasNextPage ? `\nMore info because truncated: this file has ${result.totalNumLines} lines, or ${result.totalFileLen} characters.` : ''}`
			},
			ls_dir: (params, result) => {
				const dirTreeStr = stringifyDirectoryTree1Deep(params, result)
				return dirTreeStr // + nextPageStr(result.hasNextPage) // already handles num results remaining
			},
			get_dir_tree: (params, result) => {
				return result.str
			},
			search_pathnames_only: (params, result) => {
				return result.uris.map(uri => uri.fsPath).join('\n') + nextPageStr(result.hasNextPage)
			},
			search_for_files: (params, result) => {
				return result.uris.map(uri => uri.fsPath).join('\n') + nextPageStr(result.hasNextPage)
			},
			search_in_file: (params, result) => {
				const { model } = voidModelService.getModel(params.uri)
				if (!model) return '<Error getting string of result>'
				const lines = result.lines.map(n => {
					const lineContent = model.getValueInRange({ startLineNumber: n, startColumn: 1, endLineNumber: n, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF)
					return `Line ${n}:\n\`\`\`\n${lineContent}\n\`\`\``
				}).join('\n\n');
				return lines;
			},
			go_to_definition: (params, result) => {
				if (!result.hasLanguageServer) return noLanguageServerMessage('definitions for this file type')
				if (result.locations.length === 0) return `No definition found for "${params.symbol}".`
				return result.locations.map(l => `${l.uri.fsPath}:${l.line}\n\`\`\`\n${l.snippet}\n\`\`\``).join('\n\n')
			},
			find_references: (params, result) => {
				if (!result.hasLanguageServer) return noLanguageServerMessage('references for this file type')
				if (result.locations.length === 0) return `No references found for "${params.symbol}".`

				// grouped by file, in the language server's order
				const linesOfFile = new Map<string, string[]>()
				for (const l of result.locations) {
					const lines = linesOfFile.get(l.uri.fsPath) ?? []
					lines.push(`  ${l.line}: ${l.snippet.trim()}`)
					linesOfFile.set(l.uri.fsPath, lines)
				}
				const str = [...linesOfFile].map(([fsPath, lines]) => `${fsPath}\n${lines.join('\n')}`).join('\n\n')
				const truncated = result.totalCount > result.locations.length ? `\n\n(Showing ${result.locations.length} of ${result.totalCount} references.)` : ''
				return str + truncated
			},
			search_symbols: (params, result) => {
				if (!result.hasLanguageServer) return noLanguageServerMessage('workspace symbols')
				if (result.symbols.length === 0) return `No symbols match "${params.query}". The language server may not have loaded the project yet (reading one of its files helps) — or use search_for_files.`

				const str = result.symbols.map(s => {
					const where = s.line ? `${s.uri.fsPath}:${s.line}` : s.uri.fsPath
					return `${s.name} (${s.kind}${s.containerName ? `, in ${s.containerName}` : ''}) — ${where}`
				}).join('\n')
				const truncated = result.totalCount > result.symbols.length ? `\n\n(Showing ${result.symbols.length} of ${result.totalCount} symbols. Use a more specific query to narrow it down.)` : ''
				return str + truncated
			},
			read_lint_errors: (params, result) => {
				return result.lintErrors ?
					stringifyLintErrors(result.lintErrors)
					: 'No lint errors found.'
			},
			read_project_memory: (params, result) => {
				return result.content || 'No project memory stored yet.'
			},
			// ---
			create_file_or_folder: (params, result) => {
				return `URI ${params.uri.fsPath} successfully created.`
			},
			delete_file_or_folder: (params, result) => {
				return `URI ${params.uri.fsPath} successfully deleted.`
			},
			edit_file: (params, result) => {
				const lintErrsString = (
					this.voidSettingsService.state.globalSettings.includeToolLintErrors ?
						(result.lintErrors ? ` Lint errors found after change:\n${stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
							: ` No lint errors found.`)
						: '')

				return `Change successfully made to ${params.uri.fsPath}.${lintErrsString}`
			},
			rewrite_file: (params, result) => {
				const lintErrsString = (
					this.voidSettingsService.state.globalSettings.includeToolLintErrors ?
						(result.lintErrors ? ` Lint errors found after change:\n${stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
							: ` No lint errors found.`)
						: '')

				return `Change successfully made to ${params.uri.fsPath}.${lintErrsString}`
			},
			write_project_memory: (params, result) => {
				return `Project memory saved (${result.tokenCount} tokens).`
			},
			run_command: (params, result) => {
				const { resolveReason, result: result_, } = result
				// success
				if (resolveReason.type === 'done') {
					return `${result_}\n(exit code ${resolveReason.exitCode})`
				}
				// normal command
				if (resolveReason.type === 'timeout') {
					return `${result_}\nTerminal command ran, but was automatically killed by Kodia after ${MAX_TERMINAL_INACTIVE_TIME}s of inactivity and did not finish successfully. To try with more time, open a persistent terminal and run the command there.`
				}
				throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`)
			},

			run_persistent_command: (params, result) => {
				const { resolveReason, result: result_, } = result
				const { persistentTerminalId } = params
				// success
				if (resolveReason.type === 'done') {
					return `${result_}\n(exit code ${resolveReason.exitCode})`
				}
				// bg command
				if (resolveReason.type === 'timeout') {
					return `${result_}\nTerminal command is running in terminal ${persistentTerminalId}. The given outputs are the results after ${MAX_TERMINAL_BG_COMMAND_TIME} seconds.`
				}
				throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`)
			},

			open_persistent_terminal: (_params, result) => {
				const { persistentTerminalId } = result;
				return `Successfully created persistent terminal. persistentTerminalId="${persistentTerminalId}"`;
			},
			kill_persistent_terminal: (params, _result) => {
				return `Successfully closed terminal "${params.persistentTerminalId}".`;
			},
		}



	}


	private _getLintErrors(uri: URI): { lintErrors: LintErrorItem[] | null } {
		const lintErrors = this.markerService
			.read({ resource: uri })
			.filter(l => l.severity === MarkerSeverity.Error || l.severity === MarkerSeverity.Warning)
			.slice(0, 100)
			.map(l => ({
				code: typeof l.code === 'string' ? l.code : l.code?.value || '',
				message: (l.severity === MarkerSeverity.Error ? '(error) ' : '(warning) ') + l.message,
				startLineNumber: l.startLineNumber,
				endLineNumber: l.endLineNumber,
			} satisfies LintErrorItem))

		if (!lintErrors.length) return { lintErrors: null }
		return { lintErrors, }
	}

	private _readProjectMemory(): string {
		return this.storageService.get(PROJECT_MEMORY_STORAGE_KEY, StorageScope.WORKSPACE) ?? ''
	}

	private _writeProjectMemory(content: string) {
		this.storageService.store(PROJECT_MEMORY_STORAGE_KEY, content, StorageScope.WORKSPACE, StorageTarget.MACHINE)
	}

	// keeps the most recent content — trims from the oldest (front) first, proportional to this
	// text's own token density, then nudges until it actually fits (BPE density isn't perfectly uniform)
	private _trimMemoryToTokenBudget(content: string): { content: string, tokenCount: number } {
		const tokenCount = estimateTokens(content)
		if (tokenCount <= MAX_PROJECT_MEMORY_TOKENS) return { content, tokenCount }

		const charsPerToken = content.length / tokenCount
		const excessTokens = tokenCount - MAX_PROJECT_MEMORY_TOKENS
		const charsToRemove = Math.ceil(excessTokens * charsPerToken)
		let trimmed = content.slice(charsToRemove).trim()

		while (trimmed.length > 0 && estimateTokens(trimmed) > MAX_PROJECT_MEMORY_TOKENS) {
			trimmed = trimmed.slice(Math.ceil(trimmed.length * 0.05)).trim()
		}
		return { content: trimmed, tokenCount: estimateTokens(trimmed) }
	}

}

registerSingleton(IToolsService, ToolsService, InstantiationType.Eager);
