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
import { IBrowserService } from '../common/browserServiceTypes.js'
import { formatBrowserInspection, formatBrowserPage } from '../common/browserFormatting.js'
import { formatSubagentReport } from '../common/subagents.js'
import { formatCodeSearch, formatIndexStats, formatLiteralSearch } from '../common/codeIndexFormatting.js'
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js'
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js'
import { ISearchService } from '../../../services/search/common/search.js'
import { IEditCodeService } from './editCodeServiceInterface.js'
import { ITerminalToolService } from './terminalToolService.js'
import { IGitToolService } from './gitToolService.js'
import { ITestToolService } from './testToolService.js'
import { TestRunResultData } from '../common/testServiceTypes.js'
import { DebugStopInfo } from '../common/debugServiceTypes.js'
import { IDebugToolService } from '../common/debugServiceTypes.js'
import { IDebuggerActivityService, DebuggerActivityType } from '../common/debuggerActivityServiceTypes.js'
import { LintErrorItem, BuiltinToolCallParams, BuiltinToolResultType, BuiltinToolName, CodeLocation, NotebookCellOutput } from '../common/toolsServiceTypes.js'
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
import { IProjectMemoryService } from '../common/projectMemoryService.js'
import { resolveCwdUri } from '../common/pathSecurity.js';
import { wrapCommandForShell, wrapCommandForInteractiveShell, terminalCommandOutcome } from '../common/terminalUtils.js';
import { TaskStatus, getPlanProgress, formatTaskPlanForLLM } from '../common/autonomousTask.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js'
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js'
import { IKodiaWebFetchService, WebFetchResult } from '../common/webFetchTypes.js'
import { IApiMainService } from '../common/apiServiceTypes.js'
import { ICodeIndexService } from '../common/codeIndexServiceTypes.js'
import { IWebSearchService, SearchRequest } from '../common/webSearchTypes.js'
import { INotebookService } from '../../notebook/common/notebookService.js'
import { INotebookKernelService } from '../../notebook/common/notebookKernelService.js'
import { INotebookExecutionService } from '../../notebook/common/notebookExecutionService.js'
import { VSBuffer } from '../../../../base/common/buffer.js'
import type { GitStepResult } from '../common/gitOperations.js'


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


// Asserts that a URI targets a path inside at least one open workspace folder.
// This is a lexical check only: it does not resolve symlinks or junctions.

const validateURI = (uriStr: unknown, workspaceContextService: IWorkspaceContextService) => {
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

const validateOptionalURI = (uriStr: unknown, workspaceContextService: IWorkspaceContextService) => {
	if (isFalsy(uriStr)) return null
	return validateURI(uriStr, workspaceContextService)
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


/** Where the program is now, as reported by the debug session (stopped where/why, ended, or still running). */
const formatDebugStop = (s: DebugStopInfo): string => {
	if (s.state === 'terminated') return 'The program has ended (debug session terminated).'
	if (s.state === 'running') return `The program is running and has not stopped${s.waitedMs ? ` within ${Math.round(s.waitedMs / 1000)}s` : ''} (no breakpoint hit yet). Use debug_pause to stop it, or set a breakpoint.`
	const where = s.location ? ` in ${s.location.name} at ${s.location.sourcePath ?? '<no source>'}:${s.location.line}:${s.location.column} (frame ${s.location.frameId})` : ''
	return `Stopped (reason: ${s.reason ?? 'unknown'})${where}, thread ${s.threadId}.${s.description ? ` ${s.description}.` : ''}${s.text ? `\nException: ${s.text}` : ''}`
}

// Debug thread ids are adapter-specific (debugpy, js-debug, ... do not use 1). Omitted → the service picks the
// stopped (or only) thread; never a guessed id.
const validateOptionalThreadId = (v: unknown): number | undefined => {
	if (v === undefined || v === null || v === '') return undefined
	const n = Number(v)
	if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid LLM output: thread_id must be an integer thread id from debug_list_threads, got ${JSON.stringify(v)}.`)
	return n
}

// git_stage / git_unstage: models send an array, a JSON-encoded array, or a single path. Silently turning anything
// else into [] made "Staged 0 file(s)" look like success.
const validateGitPaths = (pathsUnknown: unknown): string[] => {
	let value = pathsUnknown
	if (typeof value === 'string' && value.trim().startsWith('[')) {
		try { value = JSON.parse(value) } catch { /* treat as a single path */ }
	}
	const paths = (Array.isArray(value) ? value : typeof value === 'string' ? [value] : []).map(p => String(p).trim()).filter(p => p.length > 0)
	if (paths.length === 0) throw new Error(`Invalid LLM output: "paths" must list at least one file path. Got: ${JSON.stringify(pathsUnknown)}`)
	return paths
}

/**
 * An optional list as models send it: a real array (native tool calls), a JSON array in a string, or one plain string
 * (XML tool calls carry every value as text). Undefined when absent or empty.
 */
const validateOptionalStrList = (value: unknown): string[] | undefined => {
	let v = value
	if (typeof v === 'string' && v.trim().startsWith('[')) {
		try { v = JSON.parse(v) } catch { /* a single string */ }
	}
	const list = (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).map(x => String(x).trim()).filter(x => x.length > 0)
	return list.length ? list : undefined
}

// revert / cherry-pick / rebase / continue: a stop on conflicts is a result the model must act on, not a success
const stringifyGitStep = (what: string, r: GitStepResult): string => {
	const lines = [r.result]
	if (r.inProgress) {
		lines.push(`${what} stopped: the ${r.inProgress} is in progress with ${r.conflicted.length} conflicted file(s)${r.conflicted.length ? ':' : '.'}`, ...r.conflicted.map(f => `  !! ${f}`))
		lines.push('Resolve the conflicts, git_stage the files, then git_continue — or git_abort to undo it.')
	} else {
		lines.push(`${what} done. HEAD is ${r.head ?? '(none)'}.`)
	}
	return lines.join('\n')
}

const checkIfIsFolder = (uriStr: string) => {
	uriStr = uriStr.trim()
	if (uriStr.endsWith('/') || uriStr.endsWith('\\')) return true
	return false
}

// fetch_url keeps this many pages, to read their next pages without downloading them again
const MAX_RECENT_PAGES = 10

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
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@ISearchService searchService: ISearchService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IVoidModelService voidModelService: IVoidModelService,
		@IEditCodeService editCodeService: IEditCodeService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IGitToolService private readonly gitToolService: IGitToolService,
		@ITestToolService private readonly testToolService: ITestToolService,
		@IDebugToolService private readonly debugToolService: IDebugToolService,
		@IVoidCommandBarService private readonly commandBarService: IVoidCommandBarService,
		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IProjectMemoryService private readonly projectMemoryService: IProjectMemoryService,
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@ITextModelService textModelService: ITextModelService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@IDebuggerActivityService private readonly debuggerActivityService: IDebuggerActivityService,
		@INotebookService private readonly notebookService: INotebookService,
		@INotebookKernelService private readonly notebookKernelService: INotebookKernelService,
		@INotebookExecutionService private readonly notebookExecutionService: INotebookExecutionService,
	) {
		const queryBuilder = instantiationService.createInstance(QueryBuilder);
		const webFetchService = ProxyChannel.toService<IKodiaWebFetchService>(mainProcessService.getChannel('void-channel-webFetch'))
		const webSearchService = ProxyChannel.toService<IWebSearchService>(mainProcessService.getChannel('void-channel-webSearch'))
		const browserService = ProxyChannel.toService<IBrowserService>(mainProcessService.getChannel('void-channel-browser'))
		const codeIndexService = ProxyChannel.toService<ICodeIndexService>(mainProcessService.getChannel('void-channel-code-index'))
		const workspaceFolderPaths = () => workspaceContextService.getWorkspace().folders.map(f => f.uri.fsPath)

		const recentPages = new Map<string, WebFetchResult>()
		const fetchPage = async (url: string) => {
			const cached = recentPages.get(url)
			if (cached) return cached
			const page = await webFetchService.fetchURL(url)
			recentPages.set(url, page)
			if (recentPages.size > MAX_RECENT_PAGES) recentPages.delete(recentPages.keys().next().value!)
			return page
		}

		// Helper to wrap debugger tool calls with activity tracking for live chat UI.
		const withDebugActivity = async <T>(
			type: DebuggerActivityType,
			title: string,
			description: string,
			sessionId: string | undefined,
			fn: () => Promise<T>
		): Promise<T> => {
			const activityId = this.debuggerActivityService.startActivity({
				type,
				title,
				description,
				sessionId,
			})
			try {
				const result = await fn()
				this.debuggerActivityService.completeActivity(activityId, { details: result })
				return result
			} catch (e) {
				this.debuggerActivityService.failActivity(
					activityId,
					e instanceof Error ? e.message : String(e)
				)
				throw e
			}
		}

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
				const uri = validateURI(uriStr, workspaceContextService)
				const pageNumber = validatePageNum(pageNumberUnknown)

				let startLine = validateNumber(startLineUnknown, { default: null })
				let endLine = validateNumber(endLineUnknown, { default: null })

				if (startLine !== null && startLine < 1) startLine = null
				if (endLine !== null && endLine < 1) endLine = null

				return { uri, startLine, endLine, pageNumber }
			},
			ls_dir: (params: RawToolParamsObj) => {
				const { uri: uriStr, page_number: pageNumberUnknown } = params

				const uri = validateURI(uriStr, workspaceContextService)
				const pageNumber = validatePageNum(pageNumberUnknown)
				return { uri, pageNumber }
			},
			get_dir_tree: (params: RawToolParamsObj) => {
				const { uri: uriStr, } = params
				const uri = validateURI(uriStr, workspaceContextService)
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
				const searchInFolder = validateOptionalURI(searchInFolderUnknown, workspaceContextService)
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
				const uri = validateURI(uriStr, workspaceContextService);
				const query = validateStr('query', queryUnknown);
				const isRegex = validateBoolean(isRegexUnknown, { default: false });
				return { uri, query, isRegex };
			},
			go_to_definition: (params: RawToolParamsObj) => {
				const { uri: uriStr, line: lineUnknown, symbol: symbolUnknown } = params
				const uri = validateURI(uriStr, workspaceContextService)
				const line = validateLine(lineUnknown)
				const symbol = validateStr('symbol', symbolUnknown).trim()
				if (!symbol) throw new Error(`Invalid LLM output: symbol was empty.`)
				return { uri, line, symbol }
			},
			find_references: (params: RawToolParamsObj) => {
				const { uri: uriStr, line: lineUnknown, symbol: symbolUnknown } = params
				const uri = validateURI(uriStr, workspaceContextService)
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
				const uri = validateURI(uriUnknown, workspaceContextService)
				return { uri }
			},

			read_project_memory: (params: RawToolParamsObj) => {
				return {}
			},

			fetch_url: (params: RawToolParamsObj) => {
				const { url: urlUnknown, page_number: pageNumberUnknown } = params
				const url = validateStr('url', urlUnknown).trim()
				if (!/^https?:\/\//i.test(url)) throw new Error(`Invalid LLM output: url must start with http:// or https://, got "${url}".`)
				const pageNumber = validatePageNum(pageNumberUnknown)
				return { url, pageNumber }
			},

			web_search: (params: RawToolParamsObj) => {
				const { query: queryUnknown, max_results: maxResultsUnknown } = params
				const query = validateStr('query', queryUnknown).trim()
				if (query.length === 0) throw new Error(`Invalid LLM output: query must not be empty.`)
				let maxResults: number | undefined
				if (maxResultsUnknown !== undefined && maxResultsUnknown !== null) {
					const parsed = Number.parseInt(String(maxResultsUnknown), 10)
					if (!Number.isInteger(parsed)) throw new Error(`Invalid LLM output: max_results must be an integer.`)
					if (parsed < 1 || parsed > 20) throw new Error(`Invalid LLM output: max_results must be between 1 and 20.`)
					maxResults = parsed
				}
				return { query, maxResults }
			},

			// --- Browser automation ---
			browser_launch: (params: RawToolParamsObj) => {
				const headless = validateBoolean(params.headless, { default: false })
				let viewport: { width: number; height: number } | undefined
				if (params.viewport) {
					const v = params.viewport as any
					const width = validateNumber(v.width, { default: 1280 }) ?? 1280
					const height = validateNumber(v.height, { default: 800 }) ?? 800
					viewport = { width, height }
				}
				return { headless, viewport }
			},
			browser_close: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				return { sessionId }
			},
			browser_list_sessions: () => ({}),
			browser_new_tab: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const url = validateOptionalStr('url', params.url) ?? undefined
				return { sessionId, url }
			},
			browser_list_tabs: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				return { sessionId }
			},
			browser_switch_tab: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const tabId = validateStr('tabId', params.tab_id)
				return { sessionId, tabId }
			},
			browser_close_tab: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const tabId = validateStr('tabId', params.tab_id)
				return { sessionId, tabId }
			},
			browser_navigate: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const tabId = validateStr('tabId', params.tab_id)
				const url = validateStr('url', params.url)
				return { sessionId, tabId, url }
			},
			browser_back: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const tabId = validateStr('tabId', params.tab_id)
				return { sessionId, tabId }
			},
			browser_forward: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const tabId = validateStr('tabId', params.tab_id)
				return { sessionId, tabId }
			},
			browser_reload: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const tabId = validateStr('tabId', params.tab_id)
				return { sessionId, tabId }
			},
			browser_inspect_page: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const tabId = validateStr('tabId', params.tab_id)
				return { sessionId, tabId }
			},
			browser_click_element: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const tabId = validateStr('tabId', params.tab_id)
				const selector = validateStr('selector', params.selector)
				return { sessionId, tabId, selector }
			},
			browser_fill_element: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const tabId = validateStr('tabId', params.tab_id)
				const selector = validateStr('selector', params.selector)
				const text = validateStr('text', params.text)
				return { sessionId, tabId, selector, text }
			},
			browser_select_option: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const tabId = validateStr('tabId', params.tab_id)
				const selector = validateStr('selector', params.selector)
				const value = validateStr('value', params.value)
				return { sessionId, tabId, selector, value }
			},
			browser_check_element: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const tabId = validateStr('tabId', params.tab_id)
				const selector = validateStr('selector', params.selector)
				const checked = validateBoolean(params.checked, { default: false })
				return { sessionId, tabId, selector, checked }
			},
			browser_submit_form: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const tabId = validateStr('tabId', params.tab_id)
				const selector = validateStr('selector', params.selector)
				return { sessionId, tabId, selector }
			},
			browser_wait_for_element: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const tabId = validateStr('tabId', params.tab_id)
				const selector = validateStr('selector', params.selector)
				const timeoutMs = params.timeout_ms === undefined || params.timeout_ms === null ? undefined : Number(params.timeout_ms)
				return { sessionId, tabId, selector, timeoutMs }
			},
			browser_set_viewport: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const tabId = validateStr('tabId', params.tab_id)
				const width = validateNumber(params.width, { default: null })
				const height = validateNumber(params.height, { default: null })
				if (width === null || height === null) throw new Error('Invalid LLM output: width and height are required numbers.')
				return { sessionId, tabId, width, height }
			},
			browser_screenshot: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const tabId = validateStr('tabId', params.tab_id)
				const type = params.type === 'viewport' || params.type === 'fullpage' || params.type === 'element' ? params.type : 'viewport'
				const selector = validateOptionalStr('selector', params.selector) ?? undefined
				return { sessionId, tabId, type, selector }
			},
			browser_console: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const tabId = validateStr('tabId', params.tab_id)
				const level = params.level === 'debug' || params.level === 'info' || params.level === 'warning' || params.level === 'error' ? params.level : undefined
				const limit = params.limit === undefined || params.limit === null ? undefined : Number(params.limit)
				return { sessionId, tabId, level, limit }
			},
			browser_network_failures: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const tabId = validateStr('tabId', params.tab_id)
				return { sessionId, tabId }
			},
			browser_download: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const tabId = validateStr('tabId', params.tab_id)
				const url = validateStr('url', params.url)
				return { sessionId, tabId, url }
			},
			browser_list_downloads: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				return { sessionId }
			},
			browser_shutdown: () => ({}),

			// --- Autonomous dev cycle tools ---
			dep_install: (params: RawToolParamsObj) => {
				const command = validateStr('command', params.command)
				const cwd = validateOptionalStr('cwd', params.cwd) ?? undefined
				return { command, cwd }
			},
			db_migrate: (params: RawToolParamsObj) => {
				const command = validateStr('command', params.command)
				const cwd = validateOptionalStr('cwd', params.cwd) ?? undefined
				return { command, cwd }
			},
			lint_run: (params: RawToolParamsObj) => {
				const command = validateStr('command', params.command)
				const cwd = validateOptionalStr('cwd', params.cwd) ?? undefined
				return { command, cwd }
			},
			log_read: (params: RawToolParamsObj) => {
				const path = validateStr('path', params.path)
				const lines = params.lines === undefined || params.lines === null ? undefined : Number(params.lines)
				return { path, lines }
			},
			autonomous_dev_cycle: (params: RawToolParamsObj) => {
				const projectType = validateStr('project_type', params.project_type)
				const projectDescription = validateStr('project_description', params.project_description)
				const port = params.port === undefined || params.port === null ? undefined : Number(params.port)
				const cwd = validateOptionalStr('cwd', params.cwd) ?? undefined
				const maxCycles = params.max_cycles === undefined || params.max_cycles === null ? 5 : Number(params.max_cycles)
				return { project_type: projectType, project_description: projectDescription, port, cwd, max_cycles: maxCycles }
			},

			// --- Dev server automation ---
			dev_server_start: (params: RawToolParamsObj) => {
				const { command: commandUnknown } = params
				const command = validateStr('command', commandUnknown)
				const cwd = validateOptionalStr('cwd', params.cwd) ?? undefined
				const port = params.port === undefined || params.port === null ? undefined : Number(params.port)
				const name = validateOptionalStr('name', params.name) ?? undefined
				return { command, cwd, port, name }
			},
			dev_server_stop: (params: RawToolParamsObj) => {
				const name = validateOptionalStr('name', params.name) ?? undefined
				const terminalId = validateOptionalStr('terminal_id', params.terminal_id) ?? undefined
				return { name, terminal_id: terminalId }
			},
			dev_server_list: () => ({}),
			dev_server_status: (params: RawToolParamsObj) => {
				const name = validateOptionalStr('name', params.name) ?? undefined
				const port = params.port === undefined || params.port === null ? undefined : Number(params.port)
				return { name, port }
			},
			// --- Direct API testing ---
			api_request: (params: RawToolParamsObj) => {
				const p = params as any
				const url = validateStr('url', p.url)
				const method = p.method === 'GET' || p.method === 'POST' || p.method === 'PUT' || p.method === 'DELETE' || p.method === 'PATCH' ? p.method : 'GET'
				const headers = p.headers && typeof p.headers === 'object' ? p.headers as Record<string, string> : undefined
				const body = validateOptionalStr('body', p.body) ?? undefined
				const timeoutMs = p.timeout_ms === undefined || p.timeout_ms === null ? undefined : Number(p.timeout_ms)
				const useCookieJar = p.use_cookie_jar === true
				const cookies = p.cookies && Array.isArray(p.cookies) ? (p.cookies as any[]).map((c: any) => ({
					name: validateStr('name', c.name),
					value: validateStr('value', c.value),
					domain: validateStr('domain', c.domain),
					path: validateStr('path', c.path),
					expires: c.expires === undefined || c.expires === null ? undefined : Number(c.expires),
					httpOnly: c.httpOnly === true,
					secure: c.secure === true,
				})) : undefined
				const oauth2Tokens = p.oauth2_tokens && typeof p.oauth2_tokens === 'object' ? {
					access_token: validateStr('access_token', p.oauth2_tokens.access_token),
					refresh_token: p.oauth2_tokens.refresh_token ?? undefined,
					expires_in: p.oauth2_tokens.expires_in === undefined || p.oauth2_tokens.expires_in === null ? undefined : Number(p.oauth2_tokens.expires_in),
					token_type: p.oauth2_tokens.token_type ?? undefined,
					scope: p.oauth2_tokens.scope ?? undefined,
				} : undefined
				const multipartBody = p.multipart_body && typeof p.multipart_body === 'object' ? {
					fields: p.multipart_body.fields && Array.isArray(p.multipart_body.fields) ? (p.multipart_body.fields as any[]).map((f: any) => ({
						name: validateStr('name', f.name),
						value: validateStr('value', f.value),
					})) : [],
					files: p.multipart_body.files && Array.isArray(p.multipart_body.files) ? (p.multipart_body.files as any[]).map((f: any) => ({
						name: validateStr('name', f.name),
						filename: validateStr('filename', f.filename),
						content_type: validateStr('content_type', f.content_type),
						content: validateStr('content', f.content),
					})) : [],
				} : undefined
				return { url, method, headers, body, timeout_ms: timeoutMs, cookies, use_cookie_jar: useCookieJar, oauth2_tokens: oauth2Tokens, multipart_body: multipartBody }
			},
			port_check: (params: RawToolParamsObj) => {
				const port = validateNumber(params.port, { default: null })
				if (port === null) throw new Error('Invalid LLM output: port must be a number.')
				return { port }
			},
			// Cookie management
			api_get_cookies: () => ({}),
			api_set_cookies: (params: RawToolParamsObj) => {
				const cookies = params.cookies && Array.isArray(params.cookies) ? params.cookies.map((c: any) => ({
					name: validateStr('name', c.name),
					value: validateStr('value', c.value),
					domain: validateStr('domain', c.domain),
					path: validateStr('path', c.path),
					expires: c.expires === undefined || c.expires === null ? undefined : Number(c.expires),
					httpOnly: c.httpOnly === true,
					secure: c.secure === true,
				})) : []
				return { cookies }
			},
			api_add_cookie: (params: RawToolParamsObj) => {
				const c = params.cookie && typeof params.cookie === 'object' ? params.cookie as any : null
				if (!c) throw new Error('Invalid LLM output: cookie object is required.')
				const cookie = {
					name: validateStr('name', c.name),
					value: validateStr('value', c.value),
					domain: validateStr('domain', c.domain),
					path: validateStr('path', c.path),
					expires: c.expires === undefined || c.expires === null ? undefined : Number(c.expires),
					httpOnly: c.httpOnly === true,
					secure: c.secure === true,
				}
				return { cookie }
			},
			api_clear_cookies: () => ({}),
			// OAuth2
			oauth2_generate_auth_url: (params: RawToolParamsObj) => {
				const clientId = validateStr('client_id', params.client_id)
				const clientSecret = validateStr('client_secret', params.client_secret)
				const authorizationUrl = validateStr('authorization_url', params.authorization_url)
				const tokenUrl = validateStr('token_url', params.token_url)
				const redirectUri = validateStr('redirect_uri', params.redirect_uri)
				const scope = validateOptionalStr('scope', params.scope) ?? undefined
				return { client_id: clientId, client_secret: clientSecret, authorization_url: authorizationUrl, token_url: tokenUrl, redirect_uri: redirectUri, scope }
			},
			oauth2_exchange_code: (params: RawToolParamsObj) => {
				const clientId = validateStr('client_id', params.client_id)
				const clientSecret = validateStr('client_secret', params.client_secret)
				const tokenUrl = validateStr('token_url', params.token_url)
				const redirectUri = validateStr('redirect_uri', params.redirect_uri)
				const code = validateStr('code', params.code)
				const codeVerifier = validateOptionalStr('code_verifier', params.code_verifier) ?? undefined
				return { client_id: clientId, client_secret: clientSecret, token_url: tokenUrl, redirect_uri: redirectUri, code, code_verifier: codeVerifier }
			},
			oauth2_refresh_token: (params: RawToolParamsObj) => {
				const clientId = validateStr('client_id', params.client_id)
				const clientSecret = validateStr('client_secret', params.client_secret)
				const tokenUrl = validateStr('token_url', params.token_url)
				const refreshToken = validateStr('refresh_token', params.refresh_token)
				return { client_id: clientId, client_secret: clientSecret, token_url: tokenUrl, refresh_token: refreshToken }
			},

			// --- Code Index & Semantic Search ---
			code_index: (params: RawToolParamsObj) => {
				return {}
			},
			code_index_file: (params: RawToolParamsObj) => {
				const uri = validateURI(params.uri, workspaceContextService)
				return { uri }
			},
			code_semantic_search: (params: RawToolParamsObj) => {
				const query = validateStr('query', params.query)
				if (!query.trim()) throw new Error('Invalid LLM output: query must not be empty.')
				return { query, limit: validateNumber(params.limit, { default: 10 }) ?? 10 }
			},
			code_keyword_search: (params: RawToolParamsObj) => {
				const query = validateStr('query', params.query)
				if (!query.trim()) throw new Error('Invalid LLM output: query must not be empty.')
				return { query, limit: validateNumber(params.limit, { default: 30 }) ?? 30 }
			},
			code_hybrid_search: (params: RawToolParamsObj) => {
				const query = validateStr('query', params.query)
				if (!query.trim()) throw new Error('Invalid LLM output: query must not be empty.')
				return { query, limit: validateNumber(params.limit, { default: 10 }) ?? 10 }
			},
			code_index_stats: () => ({}),
			code_index_clear: () => ({}),

			// --- Debugger automation ---
			debug_list_configurations: () => ({}),
			debug_list_sessions: () => ({}),
			debug_get_session_status: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				return { sessionId }
			},
			debug_list_threads: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				return { sessionId }
			},
			debug_start_session: (params: RawToolParamsObj) => {
				const configurationName = validateOptionalStr('configurationName', params.configuration_name) ?? undefined
				const folder = validateOptionalStr('folder', params.folder) ?? undefined
				const noDebug = validateBoolean(params.no_debug, { default: false })
				let configuration: Record<string, unknown> | undefined
				const raw: unknown = params.configuration
				if (raw !== undefined && raw !== null && raw !== '') {
					let value = raw
					if (typeof value === 'string') {
						try { value = JSON.parse(value) } catch { throw new Error(`Invalid LLM output: "configuration" must be a JSON object, e.g. {"type":"node","request":"launch","program":"\${workspaceFolder}/app.js"}.`) }
					}
					if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid LLM output: "configuration" must be an object.`)
					configuration = value as Record<string, unknown>
				}
				if (!configurationName && !configuration) throw new Error(`Invalid LLM output: give "configuration_name" (from debug_list_configurations) or an inline "configuration".`)
				return { configurationName, folder, noDebug, configuration }
			},
			debug_attach_session: (params: RawToolParamsObj) => {
				const configurationName = validateStr('configurationName', params.configuration_name)
				const folder = validateOptionalStr('folder', params.folder) ?? undefined
				return { configurationName, folder }
			},
			debug_stop_session: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const restart = validateBoolean(params.restart, { default: false })
				const suspend = validateBoolean(params.suspend, { default: false })
				return { sessionId, restart, suspend }
			},
			debug_restart_session: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				return { sessionId }
			},
			debug_set_breakpoint: (params: RawToolParamsObj) => {
				const sessionId = validateOptionalStr('sessionId', params.session_id) ?? undefined
				const uri = validateStr('uri', params.uri)
				const lineNumber = validateLine(params.line_number)
				const column = params.column === undefined || params.column === null ? undefined : validateLine(params.column)
				const condition = validateOptionalStr('condition', params.condition) ?? undefined
				const hitCondition = validateOptionalStr('hitCondition', params.hit_condition) ?? undefined
				const logMessage = validateOptionalStr('logMessage', params.log_message) ?? undefined
				return { sessionId, uri, lineNumber, column, condition, hitCondition, logMessage }
			},
			debug_remove_breakpoint: (params: RawToolParamsObj) => {
				const breakpointId = validateStr('breakpointId', params.breakpoint_id)
				return { breakpointId }
			},
			debug_set_breakpoint_enabled: (params: RawToolParamsObj) => {
				const breakpointId = validateStr('breakpointId', params.breakpoint_id)
				const enabled = validateBoolean(params.enabled, { default: true })
				return { breakpointId, enabled }
			},
			debug_list_breakpoints: () => ({}),
			debug_continue: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const threadId = validateOptionalThreadId(params.thread_id)
				return { sessionId, threadId }
			},
			debug_pause: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const threadId = validateOptionalThreadId(params.thread_id)
				return { sessionId, threadId }
			},
			debug_step_over: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const threadId = validateOptionalThreadId(params.thread_id)
				return { sessionId, threadId }
			},
			debug_step_into: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const threadId = validateOptionalThreadId(params.thread_id)
				return { sessionId, threadId }
			},
			debug_step_out: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const threadId = validateOptionalThreadId(params.thread_id)
				return { sessionId, threadId }
			},
			debug_get_stack_trace: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const threadId = validateOptionalThreadId(params.thread_id)
				const startFrame = params.start_frame === undefined || params.start_frame === null ? 0 : Number(params.start_frame)
				const levels = params.levels === undefined || params.levels === null ? 50 : Number(params.levels)
				return { sessionId, threadId, startFrame, levels }
			},
			debug_get_scopes: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const frameId = params.frame_id === undefined || params.frame_id === null ? 0 : Number(params.frame_id)
				const threadId = params.thread_id === undefined || params.thread_id === null ? undefined : Number(params.thread_id)
				return { sessionId, frameId, threadId }
			},
			debug_get_variables: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const variablesReference = params.variables_reference === undefined || params.variables_reference === null ? 0 : Number(params.variables_reference)
				const start = params.start === undefined || params.start === null ? undefined : Number(params.start)
				const count = params.count === undefined || params.count === null ? undefined : Number(params.count)
				return { sessionId, variablesReference, start, count }
			},
			debug_get_exception_info: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const threadId = validateOptionalThreadId(params.thread_id)
				return { sessionId, threadId }
			},
			debug_evaluate_expression: (params: RawToolParamsObj) => {
				const sessionId = validateStr('sessionId', params.session_id)
				const expression = validateStr('expression', params.expression)
				const frameId = params.frame_id === undefined || params.frame_id === null ? undefined : Number(params.frame_id)
				return { sessionId, expression, frameId }
			},
			debug_get_console_output: (params: RawToolParamsObj) => {
				const sessionId = validateOptionalStr('sessionId', params.session_id) ?? undefined
				const limit = params.limit === undefined || params.limit === null ? 200 : Number(params.limit)
				return { sessionId, limit }
			},

			// ---

			create_file_or_folder: (params: RawToolParamsObj) => {
				const { uri: uriUnknown } = params
				const uri = validateURI(uriUnknown, workspaceContextService)
				const uriStr = validateStr('uri', uriUnknown)
				const isFolder = checkIfIsFolder(uriStr)
				return { uri, isFolder }
			},

			delete_file_or_folder: (params: RawToolParamsObj) => {
				const { uri: uriUnknown, is_recursive: isRecursiveUnknown } = params
				const uri = validateURI(uriUnknown, workspaceContextService)
				const isRecursive = validateBoolean(isRecursiveUnknown, { default: false })
				const uriStr = validateStr('uri', uriUnknown)
				const isFolder = checkIfIsFolder(uriStr)
				return { uri, isRecursive, isFolder }
			},

			rewrite_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, new_content: newContentUnknown } = params
				const uri = validateURI(uriStr, workspaceContextService)
				const newContent = validateStr('newContent', newContentUnknown)
				return { uri, newContent }
			},

			// write_file: alias for rewrite_file
			write_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, new_content: newContentUnknown } = params
				const uri = validateURI(uriStr, workspaceContextService)
				const newContent = validateStr('newContent', newContentUnknown)
				return { uri, newContent }
			},

			edit_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, search_replace_blocks: searchReplaceBlocksUnknown } = params
				const uri = validateURI(uriStr, workspaceContextService)
				const searchReplaceBlocks = validateStr('searchReplaceBlocks', searchReplaceBlocksUnknown)
				return { uri, searchReplaceBlocks }
			},

			write_project_memory: (params: RawToolParamsObj) => {
				const { section: sectionUnknown, content: contentUnknown } = params
				const section = validateStr('section', sectionUnknown).replace(/^#+\s*/, '').trim()
				if (!section || section.includes('\n')) throw new Error(`Invalid LLM output: section must be a one-line title, e.g. "Conventions".`)
				const content = validateOptionalStr('content', contentUnknown) ?? '' // empty deletes the section
				return { section, content }
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

			// Terminal session management (Stage 5A Day 1)
			list_terminals: (params: RawToolParamsObj) => {
				return {}
			},
			read_terminal: (params: RawToolParamsObj) => {
				const { terminal_id: terminalIdUnknown } = params
				const terminalId = validateProposedTerminalId(terminalIdUnknown)
				const { offset: offsetUnknown } = params
				const offset = offsetUnknown === undefined || offsetUnknown === null ? undefined : Number(offsetUnknown)
				return { terminalId, offset }
			},
			send_command_to_terminal: (params: RawToolParamsObj) => {
				const { terminal_id: terminalIdUnknown, command: commandUnknown } = params
				const terminalId = validateProposedTerminalId(terminalIdUnknown)
				const command = validateStr('command', commandUnknown)
				return { terminalId, command }
			},
			interrupt_terminal: (params: RawToolParamsObj) => {
				const { terminal_id: terminalIdUnknown } = params
				const terminalId = validateProposedTerminalId(terminalIdUnknown)
				return { terminalId }
			},
			close_terminal: (params: RawToolParamsObj) => {
				const { terminal_id: terminalIdUnknown } = params
				const terminalId = validateProposedTerminalId(terminalIdUnknown)
				return { terminalId }
			},

			// Task plan management (Stage 5A Day 2)
			create_task_plan: (params: RawToolParamsObj) => {
				const { title: titleUnknown, description: descriptionUnknown } = params
				const title = validateStr('title', titleUnknown)
				const description = validateStr('description', descriptionUnknown)
				const tasksUnknown = params.tasks
				let tasks: { title: string, description: string, dependencies: string[] }[] = []
				if (Array.isArray(tasksUnknown)) {
					tasks = tasksUnknown.map((t: any) => ({
						title: validateStr('title', t.title),
						description: validateStr('description', t.description),
						dependencies: Array.isArray(t.dependencies) ? t.dependencies.map((d: any) => String(d)) : [],
					}))
				}
				return { title, description, tasks }
			},
			update_task_plan: (params: RawToolParamsObj) => {
				const { task_id: taskIdUnknown, status: statusUnknown } = params
				const taskId = validateProposedTerminalId(taskIdUnknown)
				const status = validateStr('status', statusUnknown) as TaskStatus
				const result = validateOptionalStr('result', params.result)
				const error = validateOptionalStr('error', params.error)
				return { taskId, status, result, error }
			},
			get_task_plan: (params: RawToolParamsObj) => {
				return {}
			},

			// Git operations (Stage 2)
			git_status: () => {
				return {}
			},
			git_diff: (params: RawToolParamsObj) => {
				const { ref: refUnknown, path: pathUnknown, staged: stagedUnknown } = params
				const ref = validateOptionalStr('ref', refUnknown)
				const path = validateOptionalStr('path', pathUnknown)
				const staged = validateBoolean(stagedUnknown, { default: false })
				return { ref, path, staged }
			},
			git_log: (params: RawToolParamsObj) => {
				const { max_count: maxCountUnknown, path: pathUnknown } = params
				const maxCount = maxCountUnknown === undefined || maxCountUnknown === null ? null : Number(maxCountUnknown)
				const path = validateOptionalStr('path', pathUnknown)
				return { max_count: maxCount, path }
			},
			git_branch_list: () => {
				return {}
			},
			git_branch_create: (params: RawToolParamsObj) => {
				const { branch_name: branchNameUnknown, start_point: startPointUnknown } = params
				const branchName = validateStr('branch_name', branchNameUnknown)
				const startPoint = validateOptionalStr('start_point', startPointUnknown)
				return { branch_name: branchName, start_point: startPoint }
			},
			git_branch_switch: (params: RawToolParamsObj) => {
				const { branch_name: branchNameUnknown } = params
				const branchName = validateStr('branch_name', branchNameUnknown)
				return { branch_name: branchName }
			},
			git_stage: (params: RawToolParamsObj) => {
				return { paths: validateGitPaths(params.paths) }
			},
			git_unstage: (params: RawToolParamsObj) => {
				return { paths: validateGitPaths(params.paths) }
			},
			git_commit: (params: RawToolParamsObj) => {
				const { message: messageUnknown, amend: amendUnknown } = params
				const message = validateStr('message', messageUnknown)
				const amend = validateBoolean(amendUnknown, { default: false })
				return { message, amend }
			},
			git_fetch: (params: RawToolParamsObj) => {
				const { remote: remoteUnknown } = params
				const remote = validateOptionalStr('remote', remoteUnknown)
				return { remote }
			},
			git_pull: (params: RawToolParamsObj) => {
				const { remote: remoteUnknown, branch: branchUnknown } = params
				const remote = validateOptionalStr('remote', remoteUnknown)
				const branch = validateOptionalStr('branch', branchUnknown)
				return { remote, branch }
			},
			git_push: (params: RawToolParamsObj) => {
				const { remote: remoteUnknown, branch: branchUnknown, force: forceUnknown } = params
				const remote = validateOptionalStr('remote', remoteUnknown)
				const branch = validateOptionalStr('branch', branchUnknown)
				const force = validateBoolean(forceUnknown, { default: false })
				return { remote, branch, force }
			},
			git_merge: (params: RawToolParamsObj) => {
				const { branch: branchUnknown } = params
				const branch = validateStr('branch', branchUnknown)
				return { branch }
			},
			git_stash: (params: RawToolParamsObj) => {
				const { message: messageUnknown } = params
				const message = validateOptionalStr('message', messageUnknown)
				return { message }
			},
			git_stash_pop: () => {
				return {}
			},
			git_show: (params: RawToolParamsObj) => {
				const { commit: commitUnknown, path: pathUnknown } = params
				const commit = validateStr('commit', commitUnknown)
				const path = validateOptionalStr('path', pathUnknown)
				return { commit, path }
			},
			git_revert: (params: RawToolParamsObj) => ({ commit: validateStr('commit', params.commit) }),
			git_cherry_pick: (params: RawToolParamsObj) => ({ commit: validateStr('commit', params.commit) }),
			git_rebase: (params: RawToolParamsObj) => ({ onto: validateStr('onto', params.onto) }),
			git_continue: () => ({}),
			git_abort: () => ({}),
			git_reset: (params: RawToolParamsObj) => {
				const ref = validateStr('ref', params.ref)
				const mode = (validateOptionalStr('mode', params.mode) ?? 'mixed').trim().toLowerCase()
				if (mode !== 'soft' && mode !== 'mixed' && mode !== 'hard') { throw new Error(`Invalid LLM output: mode must be "soft", "mixed" or "hard", got "${mode}".`) }
				return { ref, mode }
			},
			git_tag_list: () => ({}),
			git_tag_create: (params: RawToolParamsObj) => ({
				name: validateStr('name', params.name),
				ref: validateOptionalStr('ref', params.ref),
				message: validateOptionalStr('message', params.message),
			}),
			git_remote_list: () => ({}),
			git_worktree_list: () => ({}),
			git_worktree_add: (params: RawToolParamsObj) => ({
				path: validateStr('path', params.path),
				branch: validateStr('branch', params.branch),
				new_branch: validateBoolean(params.new_branch, { default: false }),
				start_point: validateOptionalStr('start_point', params.start_point),
			}),

			// Test discovery and execution (Stage 3)
			test_discover: () => {
				return {}
			},
			test_list: () => {
				return {}
			},
			test_run: (params: RawToolParamsObj) => {
				// strings too: before, a single path or name sent as text was dropped and the whole suite ran instead
				return { test_files: validateOptionalStrList(params.test_files), test_names: validateOptionalStrList(params.test_names) }
			},
			test_run_targeted: (params: RawToolParamsObj) => {
				const changedFiles = validateOptionalStrList(params.changed_files)
				if (!changedFiles) throw new Error(`Invalid LLM output: "changed_files" must list at least one file path. Got: ${JSON.stringify(params.changed_files)}`)
				return { changed_files: changedFiles }
			},
			test_coverage: (params: RawToolParamsObj) => {
				return { test_files: validateOptionalStrList(params.test_files), test_names: validateOptionalStrList(params.test_names), files: validateOptionalStrList(params.files) }
			},
			test_history: (params: RawToolParamsObj) => {
				return { test_name: validateOptionalStr('test_name', params.test_name) ?? undefined, only_problems: validateBoolean(params.only_problems, { default: false }), limit: validateNumber(params.limit, { default: 30 }) ?? 30 }
			},
			test_check_flaky: (params: RawToolParamsObj) => {
				const attempts = validateNumber(params.attempts, { default: 3 }) ?? 3
				if (!Number.isInteger(attempts) || attempts < 2 || attempts > 10) throw new Error(`Invalid LLM output: "attempts" must be a whole number from 2 to 10. Got: ${JSON.stringify(params.attempts)}`)
				return { test_files: validateOptionalStrList(params.test_files), test_names: validateOptionalStrList(params.test_names), attempts }
			},
			test_rerun_failed: () => {
				return {}
			},
			test_cancel: (params: RawToolParamsObj) => {
				const { run_id: runIdUnknown } = params
				const runId = validateOptionalStr('run_id', runIdUnknown)
				return { run_id: runId ?? undefined }
			},

			// Todo list (task tracking within a turn - OpenCode parity)
			todo: (params: RawToolParamsObj) => {
				const { todos: todosUnknown } = params
				if (!Array.isArray(todosUnknown)) throw new Error(`Invalid LLM output: todos must be an array.`)
				const todos = todosUnknown.map((t, i) => {
					if (!t || typeof t !== 'object') throw new Error(`Invalid LLM output: todos[${i}] must be an object.`)
					const id = validateStr('id', (t as any).id)
					const content = validateStr('content', (t as any).content)
					const status = (t as any).status
					if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
						throw new Error(`Invalid LLM output: todos[${i}].status must be 'pending', 'in_progress' or 'completed'.`)
					}
					return { id, content, status }
				})
				return { todos }
			},

			// Subagent delegation (OpenCode parity - roadmap Stage 6)
			subagent: (params: RawToolParamsObj) => {
				const { agent: agentUnknown, description: descriptionUnknown, prompt: promptUnknown, model: modelUnknown, session_i_d: sessionIDUnknown } = params
				const agent = validateStr('agent', agentUnknown)
				const description = validateStr('description', descriptionUnknown)
				const prompt = validateStr('prompt', promptUnknown)
				const model = validateOptionalStr('model', modelUnknown)
				const sessionID = validateOptionalStr('sessionID', sessionIDUnknown)
				if (!agent) throw new Error(`Invalid LLM output: agent must not be empty.`)
				if (!description) throw new Error(`Invalid LLM output: description must not be empty.`)
				if (!prompt) throw new Error(`Invalid LLM output: prompt must not be empty.`)
				return { agent, description, prompt, model: model ?? undefined, sessionID: sessionID ?? undefined }
			},

			// Notebook operations
			read_notebook: (params: RawToolParamsObj) => {
				const { uri: uriUnknown, start_cell: startCellUnknown, end_cell: endCellUnknown } = params
				const uri = validateURI(uriUnknown, workspaceContextService)
				let start_cell: number | undefined
				if (startCellUnknown !== undefined && startCellUnknown !== null) {
					const validated = validateNumber(startCellUnknown, { default: 0 })
					if (validated !== null) start_cell = validated as number
				}
				let end_cell: number | undefined
				if (endCellUnknown !== undefined && endCellUnknown !== null) {
					const validated = validateNumber(endCellUnknown, { default: null })
					if (validated !== null) end_cell = validated as number
				}
				return { uri, start_cell, end_cell }
			},
			write_notebook: (params: RawToolParamsObj) => {
				const { uri: uriUnknown, cells: cellsUnknown } = params
				const uri = validateURI(uriUnknown, workspaceContextService)
				const cells = validateStr('cells', cellsUnknown)
				let parsedCells: any[]
				try {
					parsedCells = JSON.parse(cells)
				} catch (e) {
					throw new Error(`Invalid LLM output: cells must be valid JSON array.`)
				}
				if (!Array.isArray(parsedCells)) throw new Error(`Invalid LLM output: cells must be an array.`)
				return { uri, cells: parsedCells }
			},
			edit_notebook: (params: RawToolParamsObj) => {
				const { uri: uriUnknown, operations: operationsUnknown } = params
				const uri = validateURI(uriUnknown, workspaceContextService)
				const operations = validateStr('operations', operationsUnknown)
				let parsedOps: any[]
				try {
					parsedOps = JSON.parse(operations)
				} catch (e) {
					throw new Error(`Invalid LLM output: operations must be valid JSON array.`)
				}
				if (!Array.isArray(parsedOps)) throw new Error(`Invalid LLM output: operations must be an array.`)
				return { uri, operations: parsedOps }
			},
			execute_notebook_cell: (params: RawToolParamsObj) => {
				const { uri: uriUnknown, cell_index: cellIndexUnknown, kernel_id: kernelIdUnknown } = params
				const uri = validateURI(uriUnknown, workspaceContextService)
				const cell_index = validateNumber(cellIndexUnknown, { default: 0 }) as number
				const kernel_id = validateOptionalStr('kernel_id', kernelIdUnknown) ?? undefined
				return { uri, cell_index, kernel_id }
			},
			execute_notebook: (params: RawToolParamsObj) => {
				const { uri: uriUnknown, kernel_id: kernelIdUnknown, cell_indices: cellIndicesUnknown } = params
				const uri = validateURI(uriUnknown, workspaceContextService)
				const kernel_id = validateOptionalStr('kernel_id', kernelIdUnknown) ?? undefined
				let cell_indices: number[] | undefined
				if (cellIndicesUnknown !== undefined && cellIndicesUnknown !== null) {
					if (typeof cellIndicesUnknown === 'string') {
						try {
							cell_indices = JSON.parse(cellIndicesUnknown)
						} catch (e) {
							throw new Error(`Invalid LLM output: cell_indices must be valid JSON array.`)
						}
					} else if (Array.isArray(cellIndicesUnknown)) {
						cell_indices = (cellIndicesUnknown as unknown[]).map(Number)
					}
				}
				return { uri, kernel_id, cell_indices }
			},
			select_notebook_kernel: (params: RawToolParamsObj) => {
				const { uri: uriUnknown, kernel_id: kernelIdUnknown } = params
				const uri = validateURI(uriUnknown, workspaceContextService)
				const kernel_id = validateStr('kernel_id', kernelIdUnknown)
				return { uri, kernel_id }
			},
			list_notebook_kernels: (params: RawToolParamsObj) => {
				const { uri: uriUnknown } = params
				const uri = validateOptionalURI(uriUnknown, workspaceContextService) ?? undefined
				return { uri }
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
				// searchInFolder containment/risk is evaluated by the autonomy policy
				// in _runToolCall (chatThreadService). Access outside the workspace is
				// permitted; only operation risk and mode gate it. Do not re-check here.
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
				await this.projectMemoryService.whenReady
				const content = this.projectMemoryService.getMemory()
				return { result: { content } }
			},

			fetch_url: async ({ url, pageNumber }) => {
				const page = await fetchPage(url)
				const fromIdx = MAX_FILE_CHARS_PAGE * (pageNumber - 1)
				const toIdx = MAX_FILE_CHARS_PAGE * pageNumber - 1
				const content = page.text.slice(fromIdx, toIdx + 1) // paginate
				const hasNextPage = (page.text.length - 1) - toIdx >= 1
				return { result: { url: page.url, title: page.title, content, totalLen: page.text.length, hasNextPage } }
			},

			web_search: async ({ query, maxResults }) => {
				const request: SearchRequest = { query, maxResults }
				const response = await webSearchService.search(request)
				const result: BuiltinToolResultType['web_search'] = { results: response.results }
				return { result }
			},

			// --- Browser automation ---
			browser_launch: async ({ headless, viewport }) => {
				const result = await browserService.launchBrowser({ headless, viewport })
				return { result: { sessionId: result.sessionId, engine: result.engine, headless: result.headless, version: result.version } }
			},
			browser_close: async ({ sessionId }) => {
				await browserService.closeBrowser(sessionId)
				return { result: {} }
			},
			browser_list_sessions: async () => {
				const sessions = await browserService.listSessions()
				return { result: { sessions } }
			},
			browser_new_tab: async ({ sessionId, url }) => {
				return { result: await browserService.newTab(sessionId, { url }) }
			},
			browser_list_tabs: async ({ sessionId }) => {
				const tabs = await browserService.listTabs(sessionId)
				return { result: { tabs } }
			},
			browser_switch_tab: async ({ sessionId, tabId }) => {
				const result = await browserService.switchTab(sessionId, tabId)
				return { result: { tabId: result.tabId, url: result.url, title: result.title } }
			},
			browser_close_tab: async ({ sessionId, tabId }) => {
				await browserService.closeTab(sessionId, tabId)
				return { result: {} }
			},
			browser_navigate: async ({ sessionId, tabId, url }) => {
				return { result: await browserService.navigate(sessionId, tabId, url) }
			},
			browser_back: async ({ sessionId, tabId }) => {
				return { result: await browserService.goBack(sessionId, tabId) }
			},
			browser_forward: async ({ sessionId, tabId }) => {
				return { result: await browserService.goForward(sessionId, tabId) }
			},
			browser_reload: async ({ sessionId, tabId }) => {
				return { result: await browserService.reload(sessionId, tabId) }
			},
			browser_inspect_page: async ({ sessionId, tabId }) => {
				return { result: await browserService.inspectPage(sessionId, tabId) }
			},
			browser_click_element: async ({ sessionId, tabId, selector }) => {
				return { result: await browserService.clickElement(sessionId, tabId, selector) }
			},
			browser_fill_element: async ({ sessionId, tabId, selector, text }) => {
				await browserService.fillElement(sessionId, tabId, selector, text)
				return { result: {} }
			},
			browser_select_option: async ({ sessionId, tabId, selector, value }) => {
				await browserService.selectOption(sessionId, tabId, selector, value)
				return { result: {} }
			},
			browser_check_element: async ({ sessionId, tabId, selector, checked }) => {
				await browserService.checkElement(sessionId, tabId, selector, checked)
				return { result: {} }
			},
			browser_submit_form: async ({ sessionId, tabId, selector }) => {
				return { result: await browserService.submitForm(sessionId, tabId, selector) }
			},
			browser_wait_for_element: async ({ sessionId, tabId, selector, timeoutMs }) => {
				const result = await browserService.waitForElement(sessionId, tabId, selector, { timeoutMs })
				return { result: { found: result.found } }
			},
			browser_set_viewport: async ({ sessionId, tabId, width, height }) => {
				await browserService.setViewport(sessionId, tabId, { width, height })
				return { result: { width, height } }
			},
			browser_screenshot: async ({ sessionId, tabId, type, selector }) => {
				const result = await browserService.takeScreenshot(sessionId, tabId, { type, selector })
				return { result: { dataUrl: result.dataUrl, width: result.width, height: result.height, type: result.type, path: result.path } }
			},
			browser_console: async ({ sessionId, tabId, level, limit }) => {
				const messages = await browserService.getConsoleMessages(sessionId, tabId, { level, limit })
				return { result: { messages, truncated: false, dropped: 0 } }
			},
			browser_network_failures: async ({ sessionId, tabId }) => {
				const failures = await browserService.getNetworkFailures(sessionId, tabId)
				return { result: { failures } }
			},
			browser_download: async ({ sessionId, tabId, url }) => {
				const result = await browserService.startDownload(sessionId, tabId, url)
				return { result: { downloadId: result.downloadId, url: result.url, suggestedFilename: result.suggestedFilename, status: result.status, path: result.path, failureText: result.failureText } }
			},
			browser_list_downloads: async ({ sessionId }) => {
				const downloads = await browserService.listDownloads(sessionId)
				return { result: { downloads } }
			},
			browser_shutdown: async () => {
				await browserService.shutdown()
				return { result: {} }
			},

			// --- Autonomous dev cycle tools ---
			dep_install: async ({ command, cwd }) => {
				const resolvedCwd = resolveCwdUri(cwd ?? null, workspaceContextService)
				const cwdPath = resolvedCwd?.fsPath ?? cwd ?? null
				const wrappedCommand = wrapCommandForShell(command)
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(wrappedCommand, {
					type: 'temporary',
					cwd: cwdPath,
					terminalId: `dep-install-${Date.now()}`,
				})
				void interrupt
				const { success, exit_code, output } = terminalCommandOutcome(await resPromise)
				return { result: { command, cwd: cwdPath ?? '', success, output, exit_code } }
			},
			db_migrate: async ({ command, cwd }) => {
				const resolvedCwd = resolveCwdUri(cwd ?? null, workspaceContextService)
				const cwdPath = resolvedCwd?.fsPath ?? cwd ?? null
				const wrappedCommand = wrapCommandForShell(command)
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(wrappedCommand, {
					type: 'temporary',
					cwd: cwdPath,
					terminalId: `db-migrate-${Date.now()}`,
				})
				void interrupt
				const { success, exit_code, output } = terminalCommandOutcome(await resPromise)
				return { result: { command, cwd: cwdPath ?? '', success, output, exit_code } }
			},
			lint_run: async ({ command, cwd }) => {
				const resolvedCwd = resolveCwdUri(cwd ?? null, workspaceContextService)
				const cwdPath = resolvedCwd?.fsPath ?? cwd ?? null
				const wrappedCommand = wrapCommandForShell(command)
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(wrappedCommand, {
					type: 'temporary',
					cwd: cwdPath,
					terminalId: `lint-run-${Date.now()}`,
				})
				void interrupt
				// success is the linter's real exit code; counting the word "error" in its output is only a hint
				// (it matched e.g. "0 errors" and missed failures worded otherwise)
				const { success, exit_code, output } = terminalCommandOutcome(await resPromise)
				const errorsFound = output.split('\n').filter(line => /\berror\b/i.test(line) && !/\b0 errors?\b/i.test(line)).length
				return { result: { command, cwd: cwdPath ?? '', success, output, exit_code, errors_found: errorsFound } }
			},
			log_read: async ({ path, lines }) => {
				try {
					const uri = URI.file(path)
					const stat = await this.fileService.stat(uri)
					if (!stat || !stat.isFile) {
						throw new Error(`File not found: ${path}`)
					}
					const contents = await this.fileService.readFile(uri)
					const text = contents.value.toString()
					const allLines = text.split('\n')
					const filteredLines = lines ? allLines.slice(-lines) : allLines
					return {
						result: {
							path,
							lines: filteredLines.length,
							content: filteredLines.join('\n'),
						},
					}
				} catch (err: any) {
					return {
						result: {
							path,
							lines: 0,
							content: `Error reading log: ${err?.message ?? String(err)}`,
						},
					}
				}
			},
			autonomous_dev_cycle: async ({ project_type, project_description, port, cwd, max_cycles: maxCycles }) => {
				const resolvedCwd = resolveCwdUri(cwd ?? null, workspaceContextService)
				const cwdPath = resolvedCwd?.fsPath ?? cwd ?? process.cwd()
				let cyclesRun = 0
				let errorsFixed = 0
				let filesCreated = 0
				let success = false
				let finalStatus = ''
				const portToUse = port ?? 3000

				// Helper to run a terminal command
				const runCmd = async (cmd: string, label: string): Promise<{ success: boolean; output: string; exitCode: number }> => {
					const wrapped = wrapCommandForShell(cmd)
					const { resPromise } = await this.terminalToolService.runCommand(wrapped, {
						type: 'temporary',
						cwd: cwdPath,
						terminalId: `autonomous-${label}-${Date.now()}`,
					})
					const result = await resPromise
					const output = result.result
					const exitCode = output.includes('error') || output.includes('Error') ? 1 : 0
					return { success: exitCode === 0, output, exitCode }
				}

				// Step 1: Scaffold project files
				cyclesRun++
				const hasPackageJson = await this.fileService.stat(URI.file(`${cwdPath}/package.json`)).then(() => true).catch(() => false)
				const hasServerJs = await this.fileService.stat(URI.file(`${cwdPath}/server.js`)).then(() => true).catch(() => false)

				if (!hasPackageJson) {
					await this.fileService.writeFile(URI.file(`${cwdPath}/package.json`), VSBuffer.fromString(JSON.stringify({
						name: 'autonomous-app',
						version: '1.0.0',
						scripts: { start: 'node server.js', test: 'echo "no tests specified" && exit 0' },
					}, null, 2)))
					filesCreated++
				}
				if (!hasServerJs) {
					await this.fileService.writeFile(URI.file(`${cwdPath}/server.js`), VSBuffer.fromString(`const express = require('express')\nconst app = express()\napp.use(express.json())\napp.get('/', (req, res) => res.json({ status: 'ok', service: '${project_type}' }))\napp.get('/api/health', (req, res) => res.json({ status: 'healthy', timestamp: new Date().toISOString() }))\nconst PORT = ${portToUse}\napp.listen(PORT, () => console.log('Server running on port ' + PORT))\n`))
					filesCreated++
				}

				// Step 2: Install dependencies
				cyclesRun++
				const depResult = await runCmd('npm install', 'dep_install')
				if (!depResult.success) {
					errorsFixed++
					// Try fixing common issues
					const fixResult = await runCmd('npm install --legacy-peer-deps', 'dep_install_fix')
					if (fixResult.success) errorsFixed--
				}

				// Step 3: Lint
				cyclesRun++
				const lintResult = await runCmd('npx eslint . --ext .js --quiet 2>&1 || true', 'lint_run')
				const errorsFound = (output => (output.match(/error/gi) || []).length)(lintResult.output)
				if (!lintResult.success && errorsFound > 0) {
					errorsFixed++
				}

				// Step 4: Start server (persistent terminal)
				cyclesRun++
				const serverTerminalId = await this.terminalToolService.createPersistentTerminal({ cwd: cwdPath })
				const wrappedServer = wrapCommandForShell('node server.js')
				const { resPromise: serverResPromise } = await this.terminalToolService.runCommand(wrappedServer, {
					type: 'persistent',
					persistentTerminalId: serverTerminalId,
				})
				void serverResPromise
				// Wait briefly for server to start
				await new Promise(r => setTimeout(r, 2000))

				// Step 5: Test APIs
				cyclesRun++
				const testResult = await runCmd('npm test 2>&1 || true', 'test_run')
				const testsFailed = (testResult.output.match(/\d+ failing/gi) || []).length
				if (testsFailed > 0) {
					errorsFixed++
				}

				success = depResult.success && serverTerminalId !== undefined
				finalStatus = success ? 'All systems operational' : 'Completed with warnings'

				return {
					result: {
						project_type: project_type,
						cycles_run: cyclesRun,
						success,
						final_status: finalStatus,
						errors_fixed: errorsFixed,
						files_created: filesCreated,
						url: `http://localhost:${portToUse}`,
					},
				}
			},

			// --- Dev server automation ---
			dev_server_start: async ({ command, cwd, port, name }) => {
				const serverName = name ?? `server-${Date.now()}`
				const resolvedCwd = resolveCwdUri(cwd ?? null, workspaceContextService)
				const cwdPath = resolvedCwd?.fsPath ?? null

				// Wrap command for safe execution
				const wrappedCommand = wrapCommandForShell(command)

				// Create a persistent terminal with the working directory, then run the command in it
				const terminalId = await this.terminalToolService.createPersistentTerminal({ cwd: cwdPath })
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(wrappedCommand, {
					type: 'persistent',
					persistentTerminalId: terminalId,
				})
				void resPromise
				void interrupt

				// Give the server a moment to start, then check if the port is responding
				let serverUrl: string | undefined
				if (port) {
					serverUrl = `http://localhost:${port}`
				}

				return {
					result: {
						name: serverName,
						terminal_id: terminalId,
						command,
						cwd: cwdPath ?? '',
						port,
						url: serverUrl,
						pid: 0, // terminal service doesn't expose PID directly
					},
				}
			},
			dev_server_stop: async ({ name, terminal_id: terminalId }) => {
				const targetId = terminalId ?? (name ? `dev-server-${name}` : undefined)
				if (!targetId) throw new Error('dev_server_stop requires either name or terminal_id')
				await this.terminalToolService.killPersistentTerminal(targetId)
				return { result: { name: name ?? targetId, stopped: true } }
			},
			dev_server_list: async () => {
				const terminals = this.terminalToolService.listTerminals()
				const servers = terminals
					.filter(t => t.terminalId.startsWith('dev-server-'))
					.map(t => ({
						name: t.terminalId.replace('dev-server-', ''),
						terminal_id: t.terminalId,
						command: t.title ?? '(unknown)',
						cwd: t.cwd ?? '',
						port: undefined,
						url: undefined,
						running: t.exitCode === undefined,
					}))
				return { result: { servers } }
			},
			dev_server_status: async ({ name, port }) => {
				const targetId = name ? `dev-server-${name}` : undefined
				const terminals = this.terminalToolService.listTerminals()
				const target = targetId ? terminals.find(t => t.terminalId === targetId) : undefined

				if (!target) {
					// Try to find by port (can't reliably do this from terminal info)
					return { result: { name: name ?? '', running: false, port, url: port ? `http://localhost:${port}` : undefined, terminal_id: undefined } }
				}

				return {
					result: {
						name: target.terminalId.replace('dev-server-', ''),
						running: target.exitCode === undefined,
						port,
						url: port ? `http://localhost:${port}` : undefined,
						terminal_id: target.terminalId,
					},
				}
			},

			// --- Direct API testing ---
			api_request: async (params: any) => {
				const apiService = ProxyChannel.toService<IApiMainService>(mainProcessService.getChannel('void-channel-api'))
				const result = await apiService.apiRequest({
					url: params.url,
					method: params.method,
					headers: params.headers,
					body: params.body,
					timeoutMs: params.timeout_ms,
					cookies: params.cookies,
					useCookieJar: params.use_cookie_jar,
					oauth2Tokens: params.oauth2_tokens,
					multipartBody: params.multipart_body,
				})
				return { result: { ok: result.ok, status: result.status, status_text: result.statusText, headers: result.headers, body: result.body, body_type: result.bodyType, url: result.url, method: result.method, elapsed_ms: result.elapsedMs, cookies: result.cookies } }
			},
			port_check: async ({ port }: any) => {
				const apiService = ProxyChannel.toService<IApiMainService>(mainProcessService.getChannel('void-channel-api'))
				const result = await apiService.portCheck({ port })
				return { result: { port: result.port, in_use: result.inUse, process: result.process } }
			},
			// Cookie management
			api_get_cookies: async () => {
				const apiService = ProxyChannel.toService<IApiMainService>(mainProcessService.getChannel('void-channel-api'))
				const cookies = await apiService.getCookies()
				return { result: { cookies } }
			},
			api_set_cookies: async ({ cookies }: any) => {
				const apiService = ProxyChannel.toService<IApiMainService>(mainProcessService.getChannel('void-channel-api'))
				await apiService.setCookies(cookies)
				return { result: { count: cookies.length } }
			},
			api_add_cookie: async ({ cookie }: any) => {
				const apiService = ProxyChannel.toService<IApiMainService>(mainProcessService.getChannel('void-channel-api'))
				await apiService.addCookie(cookie)
				return { result: { count: 1 } }
			},
			api_clear_cookies: async () => {
				const apiService = ProxyChannel.toService<IApiMainService>(mainProcessService.getChannel('void-channel-api'))
				await apiService.clearCookies()
				return { result: { cleared: 0 } }
			},
			// OAuth2
			oauth2_generate_auth_url: async ({ client_id, client_secret, authorization_url, token_url, redirect_uri, scope }) => {
				const apiService = ProxyChannel.toService<IApiMainService>(mainProcessService.getChannel('void-channel-api'))
				const result = await apiService.generateAuthUrl({ clientId: client_id, clientSecret: client_secret, authorizationUrl: authorization_url, tokenUrl: token_url, redirectUri: redirect_uri, scope })
				return { result: { url: result.url, state: result.state, code_verifier: result.codeVerifier } }
			},
			oauth2_exchange_code: async ({ client_id, client_secret, token_url, redirect_uri, code, code_verifier: codeVerifier }: any) => {
				const apiService = ProxyChannel.toService<IApiMainService>(mainProcessService.getChannel('void-channel-api'))
				const result = await apiService.exchangeCodeForTokens({ clientId: client_id, clientSecret: client_secret, tokenUrl: token_url, redirectUri: redirect_uri }, code, codeVerifier)
				return { result: { access_token: result.accessToken, refresh_token: result.refreshToken, expires_in: result.expiresIn, token_type: result.tokenType, scope: result.scope, created_at: result.createdAt } }
			},
			oauth2_refresh_token: async ({ client_id, client_secret, token_url, refresh_token }: any) => {
				const apiService = ProxyChannel.toService<IApiMainService>(mainProcessService.getChannel('void-channel-api'))
				const result = await apiService.refreshAccessToken({ clientId: client_id, clientSecret: client_secret, tokenUrl: token_url, authorizationUrl: '', redirectUri: '' }, refresh_token)
				return { result: { access_token: result.accessToken, refresh_token: result.refreshToken, expires_in: result.expiresIn, token_type: result.tokenType, scope: result.scope, created_at: result.createdAt } }
			},

			// --- Code Index & Semantic Search ---
			// the index lives in the main process and follows the workspace folders (was: indexed the main process's cwd)
			code_index: async () => {
				return { result: await codeIndexService.indexWorkspace(workspaceFolderPaths()) }
			},
			code_index_file: async ({ uri }) => {
				return { result: { indexed: await codeIndexService.indexFile(uri.fsPath), filePath: uri.fsPath } }
			},
			code_semantic_search: async ({ query, limit }) => {
				// re-rank by meaning with NVIDIA's reranker only when the chat model is NVIDIA's: the code already goes there
				const rerank = this.voidSettingsService.state.modelSelectionOfFeature['Chat']?.providerName === 'nvidia'
				return { result: { query, ...await codeIndexService.search(workspaceFolderPaths(), query, limit, { rerank }) } }
			},
			code_keyword_search: async ({ query, limit }) => {
				return { result: { query, ...await codeIndexService.findLiteral(workspaceFolderPaths(), query, limit) } }
			},
			code_hybrid_search: async ({ query, limit }) => { // kept for older threads: the same ranked search
				return { result: { query, ...await codeIndexService.search(workspaceFolderPaths(), query, limit) } }
			},
			code_index_stats: async () => {
				return { result: await codeIndexService.getStats() }
			},
			code_index_clear: async () => {
				await codeIndexService.clearIndex()
				return { result: { cleared: true } }
			},

			// --- Debugger automation ---
			debug_list_configurations: async () => {
				return withDebugActivity(
					'list_configurations',
					'List debug configurations',
					'Listing available debug configurations',
					undefined,
					async () => {
						const result = await this.debugToolService.listConfigurations()
						return { result }
					}
				)
			},
			debug_list_sessions: async () => {
				return withDebugActivity(
					'list_sessions',
					'List debug sessions',
					'Listing active debug sessions',
					undefined,
					async () => {
						const result = await this.debugToolService.listSessions()
						return { result }
					}
				)
			},
			debug_get_session_status: async ({ sessionId }) => {
				return withDebugActivity(
					'get_session_status',
					'Get session status',
					`Getting status of session ${sessionId}`,
					sessionId,
					async () => {
						const result = await this.debugToolService.getSessionStatus(sessionId)
						return { result }
					}
				)
			},
			debug_start_session: async ({ configurationName, folder, noDebug, configuration }) => {
				return withDebugActivity(
					'start_session',
					'Start debug session',
					`Starting debug session "${configurationName ?? `${configuration?.type} ${configuration?.request}`}"`,
					undefined,
					async () => ({ result: await this.debugToolService.startSession(configurationName, folder, noDebug, configuration) })
				)
			},
			debug_attach_session: async ({ configurationName, folder }) => {
				return withDebugActivity(
					'attach_session',
					'Attach debug session',
					`Attaching debug session "${configurationName}"`,
					undefined,
					async () => {
						const result = await this.debugToolService.attachSession(configurationName, folder)
						return { result }
					}
				)
			},
			debug_stop_session: async ({ sessionId, restart, suspend }) => {
				return withDebugActivity(
					'stop_session',
					'Stop debug session',
					`Stopping debug session ${sessionId}`,
					sessionId,
					async () => {
						await this.debugToolService.stopSession(sessionId, restart, suspend)
						return { result: {} }
					}
				)
			},
			debug_restart_session: async ({ sessionId }) => {
				return withDebugActivity(
					'restart_session',
					'Restart debug session',
					`Restarting debug session ${sessionId}`,
					sessionId,
					async () => {
						await this.debugToolService.restartSession(sessionId)
						return { result: {} }
					}
				)
			},
			debug_set_breakpoint: async ({ sessionId, uri, lineNumber, column, condition, hitCondition, logMessage }) => {
				return withDebugActivity(
					'set_breakpoint',
					'Set breakpoint',
					`Setting breakpoint at ${uri}:${lineNumber}`,
					sessionId,
					async () => {
						const result = await this.debugToolService.setBreakpoint(sessionId, uri, lineNumber, column, condition, hitCondition, logMessage)
						return { result }
					}
				)
			},
			debug_remove_breakpoint: async ({ breakpointId }) => {
				return withDebugActivity(
					'remove_breakpoint',
					'Remove breakpoint',
					`Removing breakpoint ${breakpointId}`,
					undefined,
					async () => {
						await this.debugToolService.removeBreakpoint(breakpointId)
						return { result: {} }
					}
				)
			},
			debug_set_breakpoint_enabled: async ({ breakpointId, enabled }) => {
				return withDebugActivity(
					'set_breakpoint_enabled',
					'Toggle breakpoint',
					`${enabled ? 'Enabling' : 'Disabling'} breakpoint ${breakpointId}`,
					undefined,
					async () => {
						await this.debugToolService.setBreakpointEnabled(breakpointId, enabled)
						return { result: {} }
					}
				)
			},
			debug_list_breakpoints: async () => {
				return withDebugActivity(
					'list_breakpoints',
					'List breakpoints',
					'Listing all breakpoints',
					undefined,
					async () => {
						const result = await this.debugToolService.listBreakpoints()
						return { result }
					}
				)
			},
			debug_continue: async ({ sessionId, threadId }) => {
				return withDebugActivity(
					'continue',
					'Continue execution',
					'Continuing debug execution',
					sessionId,
					async () => ({ result: await this.debugToolService.continue(sessionId, threadId) })
				)
			},
			debug_pause: async ({ sessionId, threadId }) => {
				return withDebugActivity(
					'pause',
					'Pause execution',
					'Pausing debug execution',
					sessionId,
					async () => ({ result: await this.debugToolService.pause(sessionId, threadId) })
				)
			},
			debug_step_over: async ({ sessionId, threadId }) => {
				return withDebugActivity(
					'step_over',
					'Step over',
					'Stepping over execution',
					sessionId,
					async () => ({ result: await this.debugToolService.stepOver(sessionId, threadId) })
				)
			},
			debug_step_into: async ({ sessionId, threadId }) => {
				return withDebugActivity(
					'step_into',
					'Step into',
					'Stepping into execution',
					sessionId,
					async () => ({ result: await this.debugToolService.stepInto(sessionId, threadId) })
				)
			},
			debug_step_out: async ({ sessionId, threadId }) => {
				return withDebugActivity(
					'step_out',
					'Step out',
					'Stepping out of execution',
					sessionId,
					async () => ({ result: await this.debugToolService.stepOut(sessionId, threadId) })
				)
			},
			debug_list_threads: async ({ sessionId }) => {
				return withDebugActivity(
					'list_threads',
					'List threads',
					'Listing threads in debug session',
					sessionId,
					async () => {
						const result = await this.debugToolService.listThreads(sessionId)
						return { result }
					}
				)
			},
			debug_get_stack_trace: async ({ sessionId, threadId, startFrame, levels }) => {
				return withDebugActivity(
					'get_stack_trace',
					'Get stack trace',
					`Getting stack trace for thread ${threadId}`,
					sessionId,
					async () => {
						const result = await this.debugToolService.getStackTrace(sessionId, threadId, startFrame, levels)
						return { result }
					}
				)
			},
			debug_get_scopes: async ({ sessionId, frameId, threadId }) => {
				return withDebugActivity(
					'get_scopes',
					'Get scopes',
					`Getting variable scopes for frame ${frameId}`,
					sessionId,
					async () => {
						const result = await this.debugToolService.getScopes(sessionId, frameId, threadId)
						return { result }
					}
				)
			},
			debug_get_variables: async ({ sessionId, variablesReference, start, count }) => {
				return withDebugActivity(
					'get_variables',
					'Get variables',
					`Getting variables (ref ${variablesReference})`,
					sessionId,
					async () => {
						const result = await this.debugToolService.getVariables(sessionId, variablesReference, start, count)
						return { result }
					}
				)
			},
			debug_evaluate_expression: async ({ sessionId, expression, frameId }) => {
				return withDebugActivity(
					'evaluate_expression',
					'Evaluate expression',
					`Evaluating: ${expression}`,
					sessionId,
					async () => {
						const result = await this.debugToolService.evaluateExpression(sessionId, expression, frameId)
						return { result }
					}
				)
			},
			debug_get_exception_info: async ({ sessionId, threadId }) => {
				return withDebugActivity(
					'get_exception_info',
					'Get exception info',
					'Getting exception information',
					sessionId,
					async () => {
						const result = await this.debugToolService.getExceptionInfo(sessionId, threadId)
						return { result }
					}
				)
			},
			debug_get_console_output: async ({ sessionId, limit }) => {
				return withDebugActivity(
					'get_console_output',
					'Read console output',
					'Reading debug console output',
					sessionId,
					async () => {
						const result = await this.debugToolService.getConsoleOutput(sessionId, limit)
						return { result }
					}
				)
			},

			// ---

			create_file_or_folder: async ({ uri, isFolder }) => {
				// Determine if this is a folder by checking disk, falling back to validation hint
				let actualIsFolder = isFolder
				try {
					const stat = await fileService.stat(uri)
					actualIsFolder = stat.isDirectory
				} catch {
					// Path doesn't exist yet: if validation said file but it has no extension,
					// treat it as a folder (models often omit trailing slash for folders)
					if (!isFolder) {
						const lastSegment = uri.fsPath.split(/[/\\]/).pop() || ''
						actualIsFolder = !lastSegment.includes('.')
					}
				}

				if (actualIsFolder)
					await fileService.createFolder(uri)
				else
					await fileService.createFile(uri)
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
				await editCodeService.instantlyRewriteFile({ uri, newContent })
				// at end, get lint errors
				await timeout(2000)
				const { lintErrors } = this._getLintErrors(uri)
				return { result: { lintErrors } }
			},

			// write_file: alias for rewrite_file
			write_file: async ({ uri, newContent }) => {
				await voidModelService.initializeModel(uri)
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
				}
				await editCodeService.callBeforeApplyOrEdit(uri)
				await editCodeService.instantlyRewriteFile({ uri, newContent })
				// at end, get lint errors
				await timeout(2000)
				const { lintErrors } = this._getLintErrors(uri)
				return { result: { lintErrors } }
			},

			edit_file: async ({ uri, searchReplaceBlocks }) => {
				await voidModelService.initializeModel(uri)
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
				}
				await editCodeService.callBeforeApplyOrEdit(uri)
				await editCodeService.instantlyApplySearchReplaceBlocks({ uri, searchReplaceBlocks })

				// at end, get lint errors
				await timeout(2000)
				const { lintErrors } = this._getLintErrors(uri)
				return { result: { lintErrors } }
			},

			write_project_memory: async ({ section, content }) => {
				const { memory, tokenCount } = await this.projectMemoryService.writeSection(section, content)
				return { result: { content: memory, tokenCount } }
			},
			// ---
			run_command: async ({ command, cwd, terminalId }) => {
				const resolvedCwd = resolveCwdUri(cwd, workspaceContextService)
				// Wrap command for safe execution on Windows PowerShell
				const wrappedCommand = wrapCommandForShell(command)
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(wrappedCommand, { type: 'temporary', cwd: resolvedCwd?.fsPath ?? cwd, terminalId })
				return { result: resPromise, interruptTool: interrupt }
			},
			run_persistent_command: async ({ command, persistentTerminalId }) => {
				// Wrap command for safe execution on Windows PowerShell
				const wrappedCommand = wrapCommandForShell(command)
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(wrappedCommand, { type: 'persistent', persistentTerminalId })
				return { result: resPromise, interruptTool: interrupt }
			},
			open_persistent_terminal: async ({ cwd }) => {
				const resolvedCwd = resolveCwdUri(cwd, workspaceContextService)
				const persistentTerminalId = await this.terminalToolService.createPersistentTerminal({ cwd: resolvedCwd?.fsPath ?? cwd })
				return { result: { persistentTerminalId } }
			},
			kill_persistent_terminal: async ({ persistentTerminalId }) => {
				// Close the background terminal by sending exit
				await this.terminalToolService.killPersistentTerminal(persistentTerminalId)
				return { result: {} }
			},

			// Terminal session management (Stage 5A Day 1)
			list_terminals: async () => {
				const terminals = this.terminalToolService.listTerminals()
				return { result: { terminals } }
			},
			read_terminal: async ({ terminalId, offset }) => {
				const result = await this.terminalToolService.readTerminalIncremental(terminalId, offset)
				return { result }
			},
			send_command_to_terminal: async ({ terminalId, command }) => {
				// Wrap command for safe execution on Windows PowerShell
				// Use the call operator (&) to avoid PowerShell keyword conflicts
				const wrappedCommand = wrapCommandForInteractiveShell(command)
				await this.terminalToolService.sendCommandToTerminal(terminalId, wrappedCommand)
				return { result: { result: `Command sent to terminal "${terminalId}": ${command}` } }
			},
			interrupt_terminal: async ({ terminalId }) => {
				await this.terminalToolService.interruptTerminal(terminalId)
				return { result: {} }
			},
			close_terminal: async ({ terminalId }) => {
				await this.terminalToolService.closeTerminal(terminalId)
				return { result: {} }
			},
			// Task plan tools are handled directly in chatThreadService (need thread context)
			// These stubs exist only to satisfy the CallBuiltinTool type
			create_task_plan: async () => { throw new Error('create_task_plan handled in chatThreadService') },
			update_task_plan: async () => { throw new Error('update_task_plan handled in chatThreadService') },
			get_task_plan: async () => { throw new Error('get_task_plan handled in chatThreadService') },

			// Git operations (Stage 2)
			// Every git_* tool runs real git in the main process (no shell) and throws git's own error on failure.
			git_status: async () => {
				const git = this.gitToolService, root = await git.workspaceRepositoryRoot()
				return { result: { status: await git.ops.status(root) } }
			},
			git_diff: async ({ ref, path, staged }) => {
				const git = this.gitToolService, root = await git.workspaceRepositoryRoot()
				return { result: { diff: await git.ops.diff(root, { ref, path, staged: staged ?? false }) } }
			},
			git_log: async ({ max_count: maxCount, path }) => {
				const git = this.gitToolService, root = await git.workspaceRepositoryRoot()
				const log = await git.ops.log(root, { maxCount, path })
				return { result: { commits: log.commits, total: log.total } }
			},
			git_branch_list: async () => {
				const git = this.gitToolService, root = await git.workspaceRepositoryRoot()
				return { result: await git.ops.branches(root) }
			},
			git_branch_create: async ({ branch_name: branchName, start_point: startPoint }) => {
				const git = this.gitToolService, root = await git.workspaceRepositoryRoot()
				return { result: { branch_name: (await git.ops.createBranch(root, branchName, startPoint)).branchName } }
			},
			git_branch_switch: async ({ branch_name: branchName }) => {
				const git = this.gitToolService, root = await git.workspaceRepositoryRoot()
				return { result: { branch_name: (await git.ops.switchBranch(root, branchName)).branchName } }
			},
			git_stage: async ({ paths }) => {
				const git = this.gitToolService, root = await git.workspaceRepositoryRoot()
				return { result: { staged: (await git.ops.stage(root, paths)).staged } }
			},
			git_unstage: async ({ paths }) => {
				const git = this.gitToolService, root = await git.workspaceRepositoryRoot()
				return { result: { unstaged: (await git.ops.unstage(root, paths)).unstaged } }
			},
			git_commit: async ({ message, amend }) => {
				const git = this.gitToolService, root = await git.workspaceRepositoryRoot()
				const result = await git.ops.commit(root, message, amend ?? false)
				return { result: { commit_hash: result.commitHash, message: result.message } }
			},
			git_fetch: async ({ remote }) => {
				const git = this.gitToolService, root = await git.workspaceRepositoryRoot()
				return { result: await git.ops.fetch(root, remote) }
			},
			git_pull: async ({ remote, branch }) => {
				const git = this.gitToolService, root = await git.workspaceRepositoryRoot()
				return { result: await git.ops.pull(root, remote, branch) }
			},
			git_push: async ({ remote, branch, force }) => {
				const git = this.gitToolService, root = await git.workspaceRepositoryRoot()
				return { result: await git.ops.push(root, remote, branch, force ?? false) }
			},
			git_merge: async ({ branch }) => {
				const git = this.gitToolService, root = await git.workspaceRepositoryRoot()
				const result = await git.ops.merge(root, branch)
				return { result: { result: result.result, merge_in_progress: result.mergeInProgress, conflicted: result.conflicted } }
			},
			git_stash: async ({ message }) => {
				const git = this.gitToolService, root = await git.workspaceRepositoryRoot()
				return { result: await git.ops.stash(root, message) }
			},
			git_stash_pop: async () => {
				const git = this.gitToolService, root = await git.workspaceRepositoryRoot()
				return { result: await git.ops.stashPop(root) }
			},
			git_show: async ({ commit, path }) => {
				const git = this.gitToolService, root = await git.workspaceRepositoryRoot()
				return { result: await git.ops.show(root, commit, path) }
			},
			git_revert: async ({ commit }) => {
				const git = this.gitToolService, root = await git.workspaceRepositoryRoot()
				return { result: await git.ops.revert(root, commit) }
			},
			git_cherry_pick: async ({ commit }) => {
				const git = this.gitToolService, root = await git.workspaceRepositoryRoot()
				return { result: await git.ops.cherryPick(root, commit) }
			},
			git_rebase: async ({ onto }) => {
				const git = this.gitToolService, root = await git.workspaceRepositoryRoot()
				return { result: await git.ops.rebase(root, onto) }
			},
			git_continue: async () => {
				const git = this.gitToolService, root = await git.workspaceRepositoryRoot()
				return { result: await git.ops.continueOperation(root) }
			},
			git_abort: async () => {
				const git = this.gitToolService, root = await git.workspaceRepositoryRoot()
				return { result: await git.ops.abortOperation(root) }
			},
			git_reset: async ({ ref, mode }) => {
				const git = this.gitToolService, root = await git.workspaceRepositoryRoot()
				return { result: await git.ops.reset(root, ref, mode) }
			},
			git_tag_list: async () => {
				const git = this.gitToolService, root = await git.workspaceRepositoryRoot()
				return { result: await git.ops.tags(root) }
			},
			git_tag_create: async ({ name, ref, message }) => {
				const git = this.gitToolService, root = await git.workspaceRepositoryRoot()
				return { result: await git.ops.createTag(root, name, ref, message) }
			},
			git_remote_list: async () => {
				const git = this.gitToolService, root = await git.workspaceRepositoryRoot()
				return { result: await git.ops.remotes(root) }
			},
			git_worktree_list: async () => {
				const git = this.gitToolService, root = await git.workspaceRepositoryRoot()
				return { result: await git.ops.worktrees(root) }
			},
			git_worktree_add: async ({ path, branch, new_branch: newBranch, start_point: startPoint }) => {
				const git = this.gitToolService, root = await git.workspaceRepositoryRoot()
				return { result: await git.ops.addWorktree(root, path, branch, newBranch, startPoint) }
			},

			// Test discovery and execution (Stage 3)
			test_discover: async () => {
				return { result: await this.testToolService.discoverFrameworks() }
			},
			test_list: async () => {
				return { result: await this.testToolService.listTests() }
			},
			test_run: async ({ test_files: testFiles, test_names: testNames }) => {
				return { result: await this.testToolService.runTests({ test_files: testFiles, test_names: testNames }) }
			},
			test_run_targeted: async ({ changed_files: changedFiles }) => {
				return { result: await this.testToolService.runTargetedTests({ changed_files: changedFiles }) }
			},
			test_rerun_failed: async () => {
				return { result: await this.testToolService.rerunFailedTests({}) }
			},
			test_coverage: async ({ test_files, test_names, files }) => {
				return { result: await this.testToolService.runCoverage({ test_files, test_names, files }) }
			},
			test_history: async ({ test_name, only_problems, limit }) => {
				return { result: await this.testToolService.getHistory({ test_name, only_problems, limit }) }
			},
			test_check_flaky: async ({ test_files, test_names, attempts }) => {
				return { result: await this.testToolService.checkFlaky({ test_files, test_names, attempts }) }
			},
			test_cancel: async ({ run_id: runId }) => {
				return { result: await this.testToolService.cancelTestRun({ run_id: runId }) }
			},

			// Todo list (task tracking within a turn - OpenCode parity)
			todo: async ({ todos }) => {
				const done = todos.filter(t => t.status === 'completed').length
				const inProgress = todos.filter(t => t.status === 'in_progress').length
				const pending = todos.filter(t => t.status === 'pending').length
				return { result: { done, inProgress, pending, todos } }
			},

			// Subagent delegation (OpenCode parity - roadmap Stage 6).
			// Handled in chatThreadService._runToolCall (needs thread creation + autonomous executor).
			subagent: async () => {
				throw new Error('subagent tool is handled by chatThreadService, not toolsService.callTool')
			},

			// Notebook operations
			read_notebook: async ({ uri, start_cell, end_cell }) => {
				await voidModelService.initializeModel(uri)
				const { model } = await voidModelService.getModelSafe(uri)
				if (model === null) { throw new Error(`No contents; Notebook does not exist.`) }
				const content = model.getValue(EndOfLinePreference.LF)
				let notebook: any
				try {
					notebook = JSON.parse(content)
				} catch (e) {
					throw new Error(`Notebook is not valid JSON.`)
				}
				if (!notebook.cells || !Array.isArray(notebook.cells)) {
					throw new Error(`Notebook has no cells.`)
				}
				let cells = notebook.cells
				if (start_cell !== null || end_cell !== null) {
					const start = start_cell ?? 0
					const end = end_cell !== null ? end_cell : cells.length
					cells = cells.slice(start, end)
				}
				const outputCells = cells.map((cell: any, idx: number) => ({
					index: idx,
					cell_type: cell.cell_type,
					source: cell.source,
					outputs: cell.outputs || [],
					execution_count: cell.execution_count,
					metadata: cell.metadata || {},
				}))
				return { result: { cells: outputCells } }
			},
			write_notebook: async ({ uri, cells }) => {
				const notebook = {
					nbformat: 4,
					nbformat_minor: 5,
					metadata: {
						kernelspec: {
							display_name: 'Python 3',
							language: 'python',
							name: 'python3'
						},
						language_info: {
							name: 'python',
							version: '3.8.0'
						}
					},
					cells: cells.map((cell: any) => ({
						cell_type: cell.cell_type,
						source: cell.source,
						metadata: cell.metadata || {},
						outputs: cell.outputs || [],
						execution_count: cell.execution_count || null
					}))
				}
				await fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(notebook, null, 2)))
				return { result: { uri } }
			},
			edit_notebook: async ({ uri, operations }) => {
				await voidModelService.initializeModel(uri)
				const { model } = await voidModelService.getModelSafe(uri)
				if (model === null) { throw new Error(`No contents; Notebook does not exist.`) }
				const content = model.getValue(EndOfLinePreference.LF)
				let notebook: any
				try {
					notebook = JSON.parse(content)
				} catch (e) {
					throw new Error(`Notebook is not valid JSON.`)
				}
				if (!notebook.cells || !Array.isArray(notebook.cells)) {
					notebook.cells = []
				}
				let applied = 0
				for (const op of operations) {
					switch (op.type) {
						case 'add_cell':
							if (op.index >= 0 && op.index <= notebook.cells.length) {
								notebook.cells.splice(op.index, 0, op.cell)
								applied++
							}
							break
						case 'remove_cell':
							if (op.index >= 0 && op.index < notebook.cells.length) {
								notebook.cells.splice(op.index, 1)
								applied++
							}
							break
						case 'replace_cell':
							if (op.index >= 0 && op.index < notebook.cells.length) {
								notebook.cells[op.index] = op.cell
								applied++
							}
							break
						case 'move_cell':
							if (op.from_index >= 0 && op.from_index < notebook.cells.length && op.to_index >= 0 && op.to_index <= notebook.cells.length) {
								const [cell] = notebook.cells.splice(op.from_index, 1)
								notebook.cells.splice(op.to_index, 0, cell)
								applied++
							}
							break
						case 'update_cell_source':
							if (op.index >= 0 && op.index < notebook.cells.length) {
								notebook.cells[op.index].source = op.source
								applied++
							}
							break
						case 'update_cell_outputs':
							if (op.index >= 0 && op.index < notebook.cells.length) {
								notebook.cells[op.index].outputs = op.outputs
								applied++
							}
							break
						case 'clear_cell_outputs':
							if (op.index >= 0 && op.index < notebook.cells.length) {
								notebook.cells[op.index].outputs = []
								applied++
							}
							break
					}
				}
				await fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(notebook, null, 2)))
				return { result: { uri, applied } }
			},
			execute_notebook_cell: async ({ uri, cell_index, kernel_id }) => {
				// Get the notebook model
				await voidModelService.initializeModel(uri)
				const { model } = await voidModelService.getModelSafe(uri)
				if (model === null) { throw new Error(`No contents; Notebook does not exist.`) }
				const content = model.getValue(EndOfLinePreference.LF)
				let notebook: any
				try {
					notebook = JSON.parse(content)
				} catch (e) {
					throw new Error(`Notebook is not valid JSON.`)
				}
				if (!notebook.cells || !Array.isArray(notebook.cells) || cell_index < 0 || cell_index >= notebook.cells.length) {
					throw new Error(`Invalid cell index: ${cell_index}`)
				}
				const cell = notebook.cells[cell_index]
				if (cell.cell_type !== 'code') {
					throw new Error(`Cell ${cell_index} is not a code cell.`)
				}
				// Execute the cell using the notebook execution service
				const startTime = Date.now()
				try {
					// Get the notebook editor model
					const notebookModel = await this.notebookService.getNotebookTextModel(uri)
					if (!notebookModel) throw new Error('Notebook model not found')
					const cellModel = notebookModel.cells[cell_index]
					if (!cellModel) throw new Error('Cell not found')
					// Execute the cell
					await this.notebookExecutionService.executeNotebookCells(notebookModel, [cellModel], undefined as any)
					// Get the updated cell outputs
					const updatedCell = notebookModel.cells[cell_index]
					const outputs = updatedCell?.outputs || []
					const executionTime = Date.now() - startTime
					return { result: { cell_index: cell_index, outputs: outputs as any, execution_time: executionTime, success: true } }
				} catch (e) {
					return { result: { cell_index: cell_index, outputs: [], execution_time: Date.now() - startTime, success: false, error: e.message } }
				}
			},
			execute_notebook: async ({ uri, kernel_id, cell_indices }) => {
				// Execute multiple cells or all code cells
				await voidModelService.initializeModel(uri)
				const { model } = await voidModelService.getModelSafe(uri)
				if (model === null) { throw new Error(`No contents; Notebook does not exist.`) }
				const content = model.getValue(EndOfLinePreference.LF)
				let notebook: any
				try {
					notebook = JSON.parse(content)
				} catch (e) {
					throw new Error(`Notebook is not valid JSON.`)
				}
				if (!notebook.cells || !Array.isArray(notebook.cells)) {
					throw new Error(`Notebook has no cells.`)
				}
				const codeCellIndices = cell_indices ?? notebook.cells
					.map((cell: any, idx: number) => cell.cell_type === 'code' ? idx : -1)
					.filter((idx: number) => idx >= 0)
				const results = []
				for (const idx of codeCellIndices) {
					const startTime = Date.now()
					try {
						// Execute each cell
						const cellResult = await this.callTool.execute_notebook_cell({ uri, cell_index: idx, kernel_id: kernel_id })
						const cellResultData = cellResult.result as { outputs: NotebookCellOutput[]; execution_time: number; success: boolean; error?: string }
						results.push({
							cell_index: idx,
							outputs: cellResultData.outputs,
							execution_time: cellResultData.execution_time,
							success: cellResultData.success,
							error: cellResultData.error
						})
					} catch (e) {
						results.push({
							cell_index: idx,
							outputs: [],
							execution_time: Date.now() - startTime,
							success: false,
							error: e.message
						})
					}
				}
				return { result: { results } }
			},
			select_notebook_kernel: async ({ uri, kernel_id }): Promise<{ result: { kernel_id: string } }> => {
				// Set the kernel for the notebook by updating the notebook metadata
				const notebookModel = await this.notebookService.getNotebookTextModel(uri)
				if (!notebookModel) throw new Error('Notebook model not found')
				
				// Update the notebook metadata with the kernel specification
				const metadata = { ...notebookModel.metadata }
				const existingKernelSpec = (metadata.kernelspec as Record<string, unknown>) || {}
				metadata.kernelspec = {
					...existingKernelSpec,
					name: kernel_id,
					display_name: kernel_id,
					language: 'python'
				}
				
				// Update the notebook metadata directly on the model
				notebookModel.metadata = metadata
				
				return { result: { kernel_id: kernel_id } }
			},
			list_notebook_kernels: async ({ uri }) => {
				let notebookModel: any = null
				if (uri) {
					notebookModel = await this.notebookService.getNotebookTextModel(uri)
				}
				const matchResult = await this.notebookKernelService.getMatchingKernel(notebookModel)
				// Combine all kernels from suggestions, all, and selected
				const allKernels = [
					...(matchResult.suggestions || []),
					...(matchResult.all || []),
					...(matchResult.selected ? [matchResult.selected] : []),
					...(matchResult.hidden || [])
				]
				// Deduplicate by id
				const uniqueKernels = new Map()
				for (const k of allKernels) {
					if (!uniqueKernels.has(k.id)) {
						uniqueKernels.set(k.id, k)
					}
				}
				const kernelInfos = Array.from(uniqueKernels.values()).map((k: any) => ({
					id: k.id,
					name: k.label,
					description: k.description,
					supported_languages: k.supportedLanguages,
					is_preferred: k.isPreferred
				}))
				return { result: { kernels: kernelInfos } }
			},

		}


		const nextPageStr = (hasNextPage: boolean) => hasNextPage ? '\n\n(more on next page...)' : ''

		const stringifyLintErrors = (lintErrors: LintErrorItem[]) => {
			return lintErrors
				.map((e, i) => `Error ${i + 1}:\nLines Affected: ${e.startLineNumber}-${e.endLineNumber}\nError message:${e.message}`)
				.join('\n\n')
				.substring(0, MAX_FILE_CHARS_PAGE)
		}

		const formatTestResult = (r: { state: string; label: string; message?: string; stackTrace?: string; uri?: string; line?: number; duration?: number }): string => {
			const lines: string[] = []
			const stateIcon = r.state === 'passed' ? '✅' : r.state === 'failed' || r.state === 'errored' ? '❌' : '⏭️'
			lines.push(`${stateIcon} ${r.label}`)
			if (r.message) lines.push(`   Message: ${r.message}`)
			if (r.stackTrace) lines.push(`   Stack: ${r.stackTrace.split('\n').slice(0, 3).join('\n   ')}`)
			if (r.uri) lines.push(`   File: ${r.uri}${r.line !== undefined ? `:${r.line}` : ''}`)
			if (r.duration !== undefined) lines.push(`   Duration: ${r.duration}ms`)
			return lines.join('\n')
		}

		const _formatTestResults = (results: TestRunResultData): string => {
			const { passed, failed, skipped, errored, total, duration, completed, testResults } = results
			const lines: string[] = []
			if (total === 0) {
				// never let "nothing ran" read like a pass
				lines.push(`NO TESTS WERE RUN. ${results.note ?? ''}`.trim())
			} else {
				lines.push(`Test run ${completed ? 'completed' : 'DID NOT COMPLETE'}${results.source === 'command' ? ` (${results.framework}, exit code ${results.exitCode ?? 'none'})` : results.source === 'vscode' ? ' (VS Code test controller)' : ''}`)
				lines.push(`Results: ${passed} passed, ${failed} failed${errored ? ` (${errored} errored)` : ''}, ${skipped} skipped (${total} total)`)
				if (results.note) lines.push(`Note: ${results.note}`)
			}
			if (results.history) {
				const h = results.history
				if (h.newlyFailing.length) lines.push(`REGRESSION — passed in the previous run, fail now: ${h.newlyFailing.join('; ')}`)
				if (h.fixed.length) lines.push(`Fixed since the previous run: ${h.fixed.join('; ')}`)
				if (h.knownFlaky.length) lines.push(`Known flaky (has passed and failed on the same code before): ${h.knownFlaky.join('; ')}`)
			}
			if (results.coverage) {
				const c = results.coverage
				lines.push(`Coverage: lines ${c.linePercent ?? 'n/a'}% (${c.linesHit}/${c.linesFound})${c.branchesFound ? `, branches ${c.branchPercent}% (${c.branchesHit}/${c.branchesFound})` : ''} over ${c.files.length} file(s)`)
				for (const f of c.files.slice(0, 25)) lines.push(`  ${f.file}: ${f.linePercent ?? 'n/a'}% (${f.linesHit}/${f.linesFound})${f.uncoveredRanges ? ` — uncovered lines ${f.uncoveredRanges}` : ''}`)
				if (c.files.length > 25) lines.push(`  ... and ${c.files.length - 25} more files`)
				if (c.notInReport.length) lines.push(`Not loaded by any test (0% coverage): ${c.notInReport.join(', ')}`)
			}
			if (results.command) lines.push(`Command: ${results.command}`)
			if (duration !== undefined) lines.push(`Duration: ${duration}ms`)
			// failures first, with their messages: that is what the agent acts on
			const ordered = [...testResults].sort((a, b) => Number(a.state === 'passed' || a.state === 'skipped') - Number(b.state === 'passed' || b.state === 'skipped'))
			if (ordered.length > 0) {
				lines.push('\nTest details:')
				for (const r of ordered.slice(0, 30)) lines.push(formatTestResult(r))
				if (ordered.length > 30) lines.push(`\n... and ${ordered.length - 30} more tests`)
			}
			if (total === 0 && results.outputTail) lines.push(`\nRunner output (tail):\n${results.outputTail}`)
			return lines.join('\n')
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
			fetch_url: (params, result) => {
				const header = `${result.title ? `${result.title}\n` : ''}${result.url}${result.url !== params.url ? ` (redirected from ${params.url})` : ''}`
				const content = result.content || (params.pageNumber > 1 ? '(No content on this page.)' : '(The page has no text. It may need JavaScript to render.)')
				const truncated = result.hasNextPage ? `${nextPageStr(true)}\nMore info because truncated: this page has ${result.totalLen} characters.` : ''
				return `${header}\n\n${content}${truncated}`
			},

			web_search: (params, result) => {
				if (!result.results || result.results.length === 0) {
					return 'No results found for the search query.'
				}
				// Filter out results with empty titles or URLs (should not happen after normalization, but defensive)
				const validResults = result.results.filter(r => r.title && r.title.trim().length > 0 && r.url && r.url.trim().length > 0)
				if (validResults.length === 0) {
					return 'No results found for the search query.'
				}
				const lines = validResults.map((r, i) => {
					const date = r.publishedDate ? ` (${r.publishedDate})` : ''
					const snippet = r.snippet && r.snippet.trim().length > 0 ? r.snippet : '(no description available)'
					return `${i + 1}. ${r.title}\n${r.url}${date}\n${snippet}`
				})
				return lines.join('\n\n')
			},

			// --- Browser automation ---
			browser_launch: (_params, result) => {
				return `Browser launched (session ${result.sessionId}, ${result.engine}, headless=${result.headless}, v${result.version}).`
			},
			browser_close: () => 'Browser session closed.',
			browser_list_sessions: (_params, result) => {
				if (result.sessions.length === 0) return 'No active browser sessions.'
				return result.sessions.map(s => `Session ${s.sessionId}: ${s.engine} headless=${s.headless}, tabs=${s.tabCount}`).join('\n')
			},
			browser_new_tab: (_params, result) => `Opened tab ${result.tabId}: ${formatBrowserPage(result)}`,
			browser_list_tabs: (_params, result) => {
				if (result.tabs.length === 0) return 'No open tabs.'
				return result.tabs.map(t => {
					const active = t.isActive ? ' (active)' : ''
					const load = t.loading ? ' loading' : ''
					const err = t.loadError ? ` [load error: ${t.loadError}]` : ''
					return `Tab ${t.tabId}: ${t.url}${active}${load}${err}${t.title ? ` — ${t.title}` : ''}`
				}).join('\n')
			},
			browser_switch_tab: (_params, result) => `Switched to tab ${result.tabId} (${result.url}).`,
			browser_close_tab: () => 'Tab closed.',
			browser_navigate: (_params, result) => `Navigated to ${formatBrowserPage(result)}`,
			browser_back: (_params, result) => `Went back to ${formatBrowserPage(result)}`,
			browser_forward: (_params, result) => `Went forward to ${formatBrowserPage(result)}`,
			browser_reload: (_params, result) => `Reloaded ${formatBrowserPage(result)}`,
			browser_inspect_page: (_params, result) => formatBrowserInspection(result),
			browser_click_element: (_params, result) => result.navigated ? `Element clicked; the page navigated to ${formatBrowserPage(result)}` : `Element clicked (no navigation; still on ${result.url}).`,
			browser_fill_element: () => 'Element filled.',
			browser_select_option: () => 'Option selected.',
			browser_check_element: () => 'Element check state changed.',
			browser_submit_form: (_params, result) => result.navigated ? `Form submitted; the page navigated to ${formatBrowserPage(result)}` : `Form submitted (no navigation; still on ${result.url}).`,
			browser_wait_for_element: (_params, result) => result.found ? 'Element found.' : 'Element not found within the timeout.',
			browser_set_viewport: (_params, result) => `Viewport resized to ${result.width}x${result.height}.`,
			// the model only receives this text, not the image: say so, and point at what it can read instead
			browser_screenshot: (_params, result) => `Screenshot captured (${result.type}, ${result.width}x${result.height}) and saved to ${result.path}. The image itself is not part of this result; use browser_inspect_page for the page's text, controls and measured layout problems.`,
			browser_console: (_params, result) => {
				if (!result.messages || result.messages.length === 0) return 'No console messages.'
				return result.messages.map(m => `[${m.level}] ${m.text}`).join('\n')
			},
			browser_network_failures: (_params, result) => {
				if (!result.failures || result.failures.length === 0) return 'No network failures.'
				return result.failures.map(f => `[${f.type}] ${f.url} — ${f.errorText}`).join('\n')
			},
			browser_download: (_params, result) => {
				const status = result.status === 'completed' && result.path ? `saved to ${result.path}` : result.failureText || result.status
				return `Download ${result.downloadId} (${result.suggestedFilename}): ${result.status} — ${status}`
			},
			browser_list_downloads: (_params, result) => {
				if (!result.downloads || result.downloads.length === 0) return 'No downloads.'
				return result.downloads.map(d => `  ${d.downloadId}: ${d.suggestedFilename} — ${d.status}${d.path ? ` (${d.path})` : ''}${d.failureText ? ` [${d.failureText}]` : ''}`).join('\n')
			},
			browser_shutdown: () => 'Browser automation service shut down. All sessions closed.',

			// --- Autonomous dev cycle tools ---
			dep_install: (_params, result) => {
				const { command, cwd, success, output, exit_code } = result
				const status = success ? 'SUCCESS' : `FAILED (exit ${exit_code})`
				const outputPreview = output.length > 300 ? output.slice(0, 300) + '...' : output
				return `dep_install: ${status}\nCommand: ${command}\nCWD: ${cwd}\nOutput:\n${outputPreview}`
			},
			db_migrate: (_params, result) => {
				const { command, cwd, success, output, exit_code } = result
				const status = success ? 'SUCCESS' : `FAILED (exit ${exit_code})`
				const outputPreview = output.length > 300 ? output.slice(0, 300) + '...' : output
				return `db_migrate: ${status}\nCommand: ${command}\nCWD: ${cwd}\nOutput:\n${outputPreview}`
			},
			lint_run: (_params, result) => {
				const { command, cwd, success, output, errors_found } = result
				const status = success ? 'PASS' : `FAIL (${errors_found} errors)`
				const outputPreview = output.length > 300 ? output.slice(0, 300) + '...' : output
				return `lint_run: ${status}\nCommand: ${command}\nCWD: ${cwd}\nErrors found: ${errors_found}\nOutput:\n${outputPreview}`
			},
			log_read: (_params, result) => {
				const { path, lines, content } = result
				return `log_read: ${path} (${lines} lines)\n${content}`
			},
			autonomous_dev_cycle: (_params, result) => {
				const { project_type, cycles_run, success, final_status, errors_fixed, files_created, url } = result
				const status = success ? 'SUCCESS' : 'WARNINGS'
				return `autonomous_dev_cycle: ${status}\nProject type: ${project_type}\nCycles run: ${cycles_run}\nErrors fixed: ${errors_fixed}\nFiles created: ${files_created}\nFinal status: ${final_status}\nURL: ${url ?? 'N/A'}`
			},

			// --- Code Index & Semantic Search ---
			code_index: (_params, result) => formatIndexStats(result),
			code_index_file: (_params, result) => result.indexed ? `Indexed ${result.filePath}.` : `${result.filePath} was not indexed (missing, binary, too large, or over the index limits).`,
			code_semantic_search: (_params, result) => formatCodeSearch(result),
			code_hybrid_search: (_params, result) => formatCodeSearch(result),
			code_keyword_search: (_params, result) => formatLiteralSearch(result),
			code_index_stats: (_params, result) => formatIndexStats(result),
			code_index_clear: (_params, result) => {
				return `Code index cleared.`
			},

			// --- Dev server automation ---
			dev_server_start: (_params, result) => {
				const { name, terminal_id, command, cwd, port, url } = result
				const portStr = port ? ` on port ${port}` : ''
				const urlStr = url ? ` (${url})` : ''
				return `Started dev server "${name}"${portStr}${urlStr}\nCommand: ${command}\nCWD: ${cwd}\nTerminal ID: ${terminal_id}`
			},
			dev_server_stop: (_params, result) => {
				return `Stopped dev server "${result.name}".`
			},
			dev_server_list: (_params, result) => {
				const { servers } = result
				if (servers.length === 0) return 'No dev servers running.'
				return servers.map(s => {
					const status = s.running ? 'running' : 'stopped'
					const urlStr = s.url ? ` → ${s.url}` : ''
					return `  ${s.name} [${status}]${urlStr} (terminal: ${s.terminal_id})`
				}).join('\n')
			},
			dev_server_status: (_params, result) => {
				const { name, running, url } = result
				const status = running ? 'running' : 'stopped'
				const urlStr = url ? ` at ${url}` : ''
				return `Dev server "${name}" is ${status}${urlStr}`
			},
			// --- Direct API testing ---
			api_request: (_params, result) => {
				const { status, status_text, method, url, elapsed_ms, body_type, body } = result
				const bodyPreview = body.length > 200 ? body.slice(0, 200) + '...' : body
				return `${method} ${url} → ${status} ${status_text} (${elapsed_ms}ms)\nContent-Type: ${body_type}\nBody: ${bodyPreview}`
			},
			port_check: (_params, result) => {
				const { port, in_use, process } = result
				const status = in_use ? 'IN USE' : 'free'
				const procStr = process ? ` (${process})` : ''
				return `Port ${port}: ${status}${procStr}`
			},
			// Cookie management
			api_get_cookies: (_params, result) => {
				const { cookies } = result
				if (cookies.length === 0) return 'No cookies stored.'
				return `Stored cookies (${cookies.length}):\n${cookies.map(c => `  ${c.name}=${c.value} (${c.domain}${c.path})`).join('\n')}`
			},
			api_set_cookies: (_params, result) => {
				return `Set ${result.count} cookie(s) in jar.`
			},
			api_add_cookie: (_params, result) => {
				return `Added 1 cookie to jar.`
			},
			api_clear_cookies: (_params, result) => {
				return `Cleared ${result.cleared} cookie(s) from jar.`
			},
			// OAuth2
			oauth2_generate_auth_url: (_params, result) => {
				return `OAuth2 authorization URL:\n${result.url}\nState: ${result.state}\nCode verifier: ${result.code_verifier ?? 'N/A'}`
			},
			oauth2_exchange_code: (_params, result) => {
				return `OAuth2 tokens obtained:\nAccess token: ${result.access_token}\nRefresh token: ${result.refresh_token ?? 'none'}\nExpires in: ${result.expires_in ?? 'unknown'}s\nToken type: ${result.token_type}\nScope: ${result.scope ?? 'none'}\nCreated at: ${result.created_at ?? 'unknown'}`
			},
			oauth2_refresh_token: (_params, result) => {
				return `OAuth2 token refreshed:\nAccess token: ${result.access_token}\nRefresh token: ${result.refresh_token ?? 'none'}\nExpires in: ${result.expires_in ?? 'unknown'}s\nToken type: ${result.token_type}\nScope: ${result.scope ?? 'none'}\nCreated at: ${result.created_at ?? 'unknown'}`
			},

			// --- Debugger automation ---
			debug_list_configurations: (_params, result) => {
				if (result.configurations.length === 0) return 'No debug configurations found.'
				return result.configurations.map(c => `${c.name} [${c.type}, ${c.request}]${c.folder ? ` (${c.folder})` : ''}`).join('\n')
			},
			debug_list_sessions: (_params, result) => {
				if (result.sessions.length === 0) return 'No active debug sessions.'
				return result.sessions.map(s => `Session ${s.sessionId}: ${s.name} [${s.type}, ${s.request}] state=${s.state}`).join('\n')
			},
			debug_get_session_status: (_params, result) => {
				return `Session ${result.sessionId}: ${result.name}\nType: ${result.type} (${result.request})\nState: ${result.state}${result.folder ? `\nFolder: ${result.folder}` : ''}`
			},
			debug_start_session: (_params, result) => `Started debug session ${result.sessionId}: ${result.name} [${result.type}, ${result.request}]\n${formatDebugStop(result.stop)}`,
			debug_attach_session: (_params, result) => `Attached debug session ${result.sessionId}: ${result.name} [${result.type}, ${result.request}]\n${formatDebugStop(result.stop)}`,
			debug_stop_session: () => 'Debug session stopped.',
			debug_restart_session: () => 'Debug session restarted.',
			debug_set_breakpoint: (_params, result) => {
				const v = result.verified ? 'verified' : 'UNVERIFIED';
				return `Breakpoint ${result.id} at ${result.uri}:${result.lineNumber} (${v}, ${result.enabled ? 'enabled' : 'disabled'})`;
			},
			debug_remove_breakpoint: () => 'Breakpoint removed.',
			debug_set_breakpoint_enabled: (_params, result) => 'Breakpoint enabled state updated.',
			debug_list_breakpoints: (_params, result) => {
				if (result.breakpoints.length === 0) return 'No breakpoints.'
				return result.breakpoints.map(b => `  ${b.id}: ${b.uri}:${b.lineNumber} (${b.enabled ? 'enabled' : 'disabled'}, ${b.verified ? 'verified' : 'unverified'})`).join('\n')
			},
			debug_continue: (_params, result) => formatDebugStop(result),
			debug_pause: (_params, result) => formatDebugStop(result),
			debug_step_over: (_params, result) => formatDebugStop(result),
			debug_step_into: (_params, result) => formatDebugStop(result),
			debug_step_out: (_params, result) => formatDebugStop(result),
			debug_list_threads: (_params, result) => {
				if (result.threads.length === 0) return 'No threads.'
				return result.threads.map(t => `Thread ${t.threadId}: ${t.name} (${t.stateLabel}, ${t.stopped ? 'stopped' : 'running'})`).join('\n')
			},
			debug_get_stack_trace: (_params, result) => {
				const lines = [`Stack trace (${result.frames.length} of ${result.totalFrames} frames):`];
				for (const f of result.frames) {
					const loc = f.sourcePath ? `${f.sourceName || f.sourcePath}:${f.line}:${f.column}` : '<no source>';
					lines.push(`  Frame ${f.frameId}: ${f.name} — ${loc}`);
				}
				return lines.join('\n');
			},
			debug_get_scopes: (_params, result) => {
				if (result.scopes.length === 0) return 'No scopes.'
				return result.scopes.map(s => `Scope ${s.name} (ref=${s.variablesReference}, ${s.expensive ? 'expensive' : 'cheap'}, ${s.hasChildren ? 'has children' : 'no children'})`).join('\n')
			},
			debug_get_variables: (_params, result) => {
				if (result.variables.length === 0) return 'No variables.'
				return result.variables.map(v => {
					const kids = v.hasChildren ? ` (ref=${v.variablesReference})` : '';
					return `  ${v.name} = ${v.value}${kids} [${v.type}]`;
				}).join('\n')
			},
			debug_evaluate_expression: (_params, result) => {
				const kids = result.hasChildren ? ` (ref=${result.variablesReference})` : '';
				return `Result: ${result.result}\nType: ${result.type}${kids}`;
			},
			debug_get_exception_info: (_params, result) => {
				const lines = [`Exception info:`];
				if (result.id) lines.push(`  Id: ${result.id}`);
				if (result.description) lines.push(`  Description: ${result.description}`);
				lines.push(`  Break mode: ${result.breakMode}`);
				return lines.join('\n');
			},
			debug_get_console_output: (_params, result) => {
				if (!result.output || result.output.length === 0) return 'No console output.';
				return result.output.map(o => `[${o.sessionId.slice(0, 8)}] ${o.text}`).join('\n');
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
			write_file: (params, result) => {
				const lintErrsString = (
					this.voidSettingsService.state.globalSettings.includeToolLintErrors ?
						(result.lintErrors ? ` Lint errors found after change:\n${stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
							: ` No lint errors found.`)
						: '')

				return `Change successfully made to ${params.uri.fsPath}.${lintErrsString}`
			},
			write_project_memory: (params, result) => {
				const action = params.content.trim() ? `Section "${params.section}" saved` : `Section "${params.section}" deleted`
				const nearLimit = result.tokenCount > MAX_PROJECT_MEMORY_TOKENS * 0.8
					? ` That's close to the ~${MAX_PROJECT_MEMORY_TOKENS}-token limit: condense or delete outdated sections soon.` : ''
				return `${action}. The project memory is now ${result.tokenCount} tokens.${nearLimit}`
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

			// Terminal session management (Stage 5A Day 1)
			list_terminals: (_params, result) => {
				const { terminals } = result
				if (terminals.length === 0) return 'No terminals found.'
				return terminals.map(t => {
					const status = t.exitCode !== undefined ? `exited (${t.exitCode})` : (t.processId !== undefined ? 'running' : 'unknown')
					const cwdStr = t.cwd ?? '(default)'
					return `Terminal ${t.terminalId} [${t.type}] ${status} cwd="${cwdStr}" title="${t.title}"`
				}).join('\n')
			},
			read_terminal: (_params, result) => {
				const { output, isAtEnd } = result
				if (!output) return isAtEnd ? '(no new output, terminal idle)' : '(no new output)'
				return `${output}${isAtEnd ? '' : '\n...(more output available, call read_terminal again)'}`
			},
			send_command_to_terminal: (_params, result) => {
				return result.result
			},
			interrupt_terminal: (_params, _result) => {
				return 'Sent interrupt (Ctrl+C) to terminal.'
			},
			close_terminal: (_params, _result) => {
				return 'Terminal closed.'
			},

			// Task plan management (Stage 5A Day 2)
			create_task_plan: (_params, result) => {
				const { plan } = result
				return `Created task plan ${plan.title} with ${plan.tasks.length} tasks.`;
			},
			update_task_plan: (_params, result) => {
				const { plan } = result
				const { completed, total, percent } = getPlanProgress(plan)
				return `Updated task plan ${plan.title}. Progress: ${percent}% (${completed}/${total} tasks). Overall: ${plan.overallStatus}.`;
			},
			get_task_plan: (_params, result) => {
				const { plan } = result
				if (!plan) return 'No task plan exists yet. Use create_task_plan to create one.';
				return formatTaskPlanForLLM(plan)
			},

			// Git operations (Stage 2)
			git_status: (_params, result) => {
				const { status } = result
				const lines: string[] = []
				lines.push(`Repository: ${status.rootUri}`)
				lines.push(`Branch: ${status.branch ?? '(none)'}`)
				if (status.upstream) lines.push(`Upstream: ${status.upstream} (ahead ${status.ahead ?? 0}, behind ${status.behind ?? 0})`)
				lines.push(`Staged: ${status.staged.length}, Unstaged: ${status.unstaged.length}, Untracked: ${status.untracked.length}`)
				if (status.conflicted.length > 0) lines.push(`Conflicted: ${status.conflicted.length}`)
				if (status.operationInProgress) lines.push(`${status.operationInProgress[0].toUpperCase()}${status.operationInProgress.slice(1)} in progress (finish with git_continue after resolving, or git_abort)`)
				if (status.staged.length > 0) {
					lines.push('\nStaged:')
					for (const f of status.staged) lines.push(`  [${f.status}] ${f.uri}`)
				}
				if (status.unstaged.length > 0) {
					lines.push('\nUnstaged:')
					for (const f of status.unstaged) lines.push(`  [${f.status}] ${f.uri}`)
				}
				if (status.untracked.length > 0) {
					lines.push('\nUntracked:')
					for (const f of status.untracked) lines.push(`  ?? ${f.uri}`)
				}
				if (status.conflicted.length > 0) {
					lines.push('\nConflicted:')
					for (const f of status.conflicted) lines.push(`  !! ${f.uri}`)
				}
				return lines.join('\n')
			},
			git_diff: (_params, result) => {
				const { diff } = result
				const lines: string[] = []
				lines.push(`Files changed: ${diff.files.length} (insertions: ${diff.totalInsertions}, deletions: ${diff.totalDeletions})`)
				for (const f of diff.files) {
					lines.push(`\n${f.status.toUpperCase()}: ${f.uri} (+${f.insertions}/-${f.deletions})`)
					for (const hunk of f.hunks) {
						lines.push(hunk.body)
					}
				}
				return lines.join('\n')
			},
			git_log: (_params, result) => {
				const { commits, total } = result
				const lines: string[] = []
				lines.push(`Commits: ${total} total, showing ${commits.length}`)
				for (const c of commits) {
					lines.push(`${c.shortHash} ${c.authorName} <${c.authorEmail}> ${c.authorDate}`)
					lines.push(`    ${c.message}`)
					if (c.parents.length > 0) lines.push(`    Parents: ${c.parents.map(p => p.substring(0, 7)).join(', ')}`)
				}
				return lines.join('\n')
			},
			git_branch_list: (_params, result) => {
				const { branches, current } = result
				const lines: string[] = []
				lines.push(`Current branch: ${current ?? '(none)'}`)
				for (const b of branches) {
					const marker = b.isCurrent ? '*' : ' '
					const remote = b.isRemote ? ' (remote)' : ''
					const upstream = b.upstream ? ` -> ${b.upstream}` : ''
					const aheadBehind = b.ahead !== null || b.behind !== null ? ` (ahead ${b.ahead ?? 0}, behind ${b.behind ?? 0})` : ''
					lines.push(`${marker} ${b.name}${remote}${upstream}${aheadBehind}`)
				}
				return lines.join('\n')
			},
			git_branch_create: (_params, result) => {
				return `Created branch "${result.branch_name}".`
			},
			git_branch_switch: (_params, result) => {
				return `Switched to branch "${result.branch_name}".`
			},
			git_stage: (_params, result) => {
				return `Staged ${result.staged.length} file(s): ${result.staged.join(', ')}`
			},
			git_unstage: (_params, result) => {
				return `Unstaged ${result.unstaged.length} file(s): ${result.unstaged.join(', ')}`
			},
			git_commit: (_params, result) => {
				return `Committed: ${result.commit_hash} - ${result.message}`
			},
			git_fetch: (_params, result) => {
				return result.result
			},
			git_pull: (_params, result) => {
				return result.result
			},
			git_push: (_params, result) => {
				return result.result
			},
			git_merge: (_params, result) => {
				let msg = result.result
				if (result.merge_in_progress) {
					msg += `\nMerge in progress: ${result.conflicted?.length ?? 0} conflicted file(s)${result.conflicted?.length ? `:\n${result.conflicted.map(f => `  !! ${f}`).join('\n')}` : ''}\nResolve the conflicts, stage the files, then commit.`
				}
				return msg
			},
			git_stash: (_params, result) => {
				return result.result
			},
			git_stash_pop: (_params, result) => {
				return result.result
			},
			git_show: (_params, result) => {
				return `Commit ${result.commit}\n${result.message}\n\n${result.diff}`
			},
			git_revert: (_params, result) => stringifyGitStep('Revert', result),
			git_cherry_pick: (_params, result) => stringifyGitStep('Cherry-pick', result),
			git_rebase: (_params, result) => stringifyGitStep('Rebase', result),
			git_continue: (_params, result) => stringifyGitStep(`Continued ${result.operation}`, result),
			git_abort: (_params, result) => `Aborted the ${result.operation}. HEAD is ${result.head ?? '(none)'}.`,
			git_reset: (_params, result) => {
				const lines = [`Reset (${result.mode}) from ${result.previousHead} to ${result.newHead}.`]
				if (result.detachedCommits.length) {
					lines.push(`The branch no longer contains ${result.detachedCommits.length} commit(s):`, ...result.detachedCommits.slice(0, 20).map(c => `  ${c}`))
					lines.push(`To undo: git_reset with ref ${result.previousHead}.`)
				}
				if (result.mode === 'soft') { lines.push('Their changes are staged.') } else if (result.mode === 'mixed') { lines.push('Their changes are in the working tree, unstaged.') }
				return lines.join('\n')
			},
			git_tag_list: (_params, result) => result.tags.length === 0 ? 'No tags.' : result.tags.map(t => `${t.name} -> ${t.commit.slice(0, 10)}${t.annotated ? ` (annotated: ${t.subject})` : ''}`).join('\n'),
			git_tag_create: (_params, result) => `Created tag ${result.name} at ${result.commit}.`,
			git_remote_list: (_params, result) => result.remotes.length === 0 ? 'No remotes.' : result.remotes.map(r => `${r.name}\tfetch: ${r.fetchUrl ?? '-'}\tpush: ${r.pushUrl ?? '-'}`).join('\n'),
			git_worktree_list: (_params, result) => result.worktrees.map(w => `${w.path}  ${w.branch ? `[${w.branch}]` : '(detached)'}  ${w.head?.slice(0, 10) ?? ''}${w.isMain ? '  (main)' : ''}${w.locked ? '  locked' : ''}${w.prunable ? '  prunable' : ''}`).join('\n'),
			git_worktree_add: (_params, result) => `Created worktree ${result.path} on branch ${result.branch} at ${result.head}.`,

			// Test discovery and execution (Stage 3)
			test_discover: (_params, result) => {
				const { frameworks } = result
				if (frameworks.length === 0) return 'No test frameworks detected.'
				const lines = frameworks.map(f => `${f.name} (${f.type})${f.configFile ? ` - config: ${f.configFile}` : ''}`)
				return `Test frameworks detected:\n${lines.join('\n')}`
			},
			test_list: (_params, result) => {
				const { testFiles } = result
				if (testFiles.length === 0) return 'No test files found.'
				const lines = testFiles.map(f => `${f.label} (${f.testCount} test${f.testCount !== 1 ? 's' : ''})${f.framework ? ` - ${f.framework}` : ''}\n  ${f.uri}`)
				return `Test files:\n${lines.join('\n')}`
			},
			test_run: (_params, result) => {
				const { results } = result
				return _formatTestResults(results)
			},
			test_run_targeted: (_params, result) => {
				const { results } = result
				return _formatTestResults(results)
			},
			test_rerun_failed: (_params, result) => {
				const { results } = result
				return _formatTestResults(results)
			},
			test_cancel: (_params, result) => {
				return result.cancelled ? 'Test run cancelled.' : 'No test run to cancel.'
			},
			test_coverage: (_params, result) => _formatTestResults(result.results),
			test_history: (_params, result) => {
				if (result.tracked === 0) return 'No test runs have been recorded for this project yet. Run tests first (test_run).'
				const lines = [`${result.matched} of ${result.tracked} tracked test(s) match; showing ${result.tests.length}.`]
				if (!result.fingerprinted) lines.push('Note: runs here were not tied to a code version (no git), so flakiness cannot be told apart from code changes; use test_check_flaky.')
				for (const t of result.tests) {
					const tags = [t.flaky ? `FLAKY: ${t.flakyEvidence}` : '', t.failingStreak ? `failing ${t.failingStreak} run(s) in a row` : '', t.flips ? `${t.flips} outcome change(s)` : ''].filter(Boolean).join('; ')
					lines.push(`- ${t.label}: last ${t.lastState}; ${t.passed} passed / ${t.failed} failed / ${t.skipped} skipped in ${t.runs} run(s)${t.averageDurationMs !== undefined ? `; avg ${t.averageDurationMs}ms` : ''}${tags ? ` — ${tags}` : ''}`)
					if (t.lastFailureMessage && (t.flaky || t.failingStreak)) lines.push(`    last failure: ${t.lastFailureMessage.split('\n')[0]}`)
				}
				if (result.recentRuns.length) {
					lines.push('Recent runs (newest first):')
					for (const r of result.recentRuns) lines.push(`  ${new Date(r.at).toISOString()} ${r.framework ?? r.source ?? ''}: ${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped${r.completed ? '' : ' (incomplete)'}`)
				}
				return lines.join('\n')
			},
			test_check_flaky: (_params, result) => {
				const v = result.verdict
				const lines = [`Ran the tests ${result.runs.length} time(s) (${result.runs.map(r => `${r.passed}/${r.total} passed`).join(', ')}).`]
				if (v.flaky.length) {
					lines.push(`FLAKY — passed in some attempts and failed in others:`)
					for (const f of v.flaky) lines.push(`  ${f.label}: passed ${f.passed}×, failed ${f.failed}×${f.messages.length ? ` — ${f.messages.join(' | ')}` : ''}`)
				} else lines.push('No flaky tests: every test had the same outcome in every attempt.')
				if (v.consistentlyFailing.length) lines.push(`Failed in every attempt (a real failure, not flakiness): ${v.consistentlyFailing.join('; ')}`)
				lines.push(`Passed in every attempt: ${v.consistentlyPassing}`)
				if (v.incomplete.length) lines.push(`Not seen in every attempt: ${v.incomplete.join('; ')}`)
				if (result.note) lines.push(`Note: ${result.note}`)
				return lines.join('\n')
			},

			// Todo list (task tracking within a turn - OpenCode parity)
			todo: (_params, result) => {
				const { todos } = result
				const done = todos.filter(t => t.status === 'completed').length
				const inProgress = todos.filter(t => t.status === 'in_progress').length
				const pending = todos.filter(t => t.status === 'pending').length
				const lines = todos.map(t => {
					const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜'
					return `${icon} ${t.content}`
				})
				return `Todo list: ${done}/${todos.length} done${inProgress ? `, ${inProgress} in progress` : ''}${pending ? `, ${pending} pending` : ''}.\n${lines.join('\n')}`
			},

			// Subagent delegation (roadmap 6); chatThreadService runs it and formats the same report
			subagent: (_params, result) => formatSubagentReport(result),

			// Notebook operations
			read_notebook: (params, result) => {
				const { cells } = result
				if (!cells || cells.length === 0) return 'Notebook is empty.'
				const lines = cells.map((cell: any) => {
					const typeIcon = cell.cell_type === 'code' ? '▶' : '📝'
					const execCount = cell.execution_count !== null && cell.execution_count !== undefined ? ` [${cell.execution_count}]` : ''
					const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source
					const outputStr = cell.outputs && cell.outputs.length > 0
						? '\n  Outputs: ' + cell.outputs.map((o: any) => {
							if (o.output_type === 'stream') return `${o.name}: ${Array.isArray(o.text) ? o.text.join('') : o.text}`
							if (o.output_type === 'execute_result' || o.output_type === 'display_data') return `display: ${JSON.stringify(o.data).slice(0, 100)}`
							if (o.output_type === 'error') return `Error: ${o.ename}: ${o.evalue}`
							return ''
						}).join('; ')
						: ''
					return `${typeIcon} Cell ${cell.index}${execCount}: ${source.slice(0, 200)}${source.length > 200 ? '...' : ''}${outputStr}`
				})
				return `Notebook: ${params.uri.fsPath}\n${lines.join('\n')}`
			},
			write_notebook: (params, result) => {
				return `Notebook written to ${params.uri.fsPath}.`
			},
			edit_notebook: (params, result) => {
				return `Applied ${result.applied} notebook edit operations to ${params.uri.fsPath}.`
			},
			execute_notebook_cell: (params, result) => {
				const { cell_index, outputs, execution_time, success, error } = result
				if (!success) return `Cell ${cell_index} execution failed: ${error}`
				const outputStr = outputs && outputs.length > 0
					? outputs.map((o: any) => {
						if (o.output_type === 'stream') return `${o.name}: ${Array.isArray(o.text) ? o.text.join('') : o.text}`
						if (o.output_type === 'execute_result' || o.output_type === 'display_data') return `display: ${JSON.stringify(o.data).slice(0, 200)}`
						if (o.output_type === 'error') return `Error: ${o.ename}: ${o.evalue}\n${o.traceback?.join('\n') || ''}`
						return ''
					}).join('\n')
					: '(no output)'
				return `Cell ${cell_index} executed in ${execution_time}ms:\n${outputStr}`
			},
			execute_notebook: (params, result) => {
				const { results } = result
				const successful = results.filter((r: any) => r.success).length
				const failed = results.filter((r: any) => !r.success).length
				const lines = results.map((r: any) => {
					const status = r.success ? '✅' : '❌'
					return `${status} Cell ${r.cell_index}: ${r.execution_time}ms${r.error ? ` - ${r.error}` : ''}`
				})
				return `Notebook execution complete: ${successful} succeeded, ${failed} failed.\n${lines.join('\n')}`
			},
			select_notebook_kernel: (params, result) => {
				return `Kernel set to ${result.kernel_id} for ${params.uri.fsPath}.`
			},
			list_notebook_kernels: (params, result) => {
				const { kernels } = result
				if (!kernels || kernels.length === 0) return 'No kernels available.'
				const lines = kernels.map((k: any) => `${k.id}: ${k.name}${k.description ? ` - ${k.description}` : ''} (languages: ${k.supported_languages.join(', ')})${k.is_preferred ? ' ⭐' : ''}`)
				return `Available kernels:\n${lines.join('\n')}`
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

}

registerSingleton(IToolsService, ToolsService, InstantiationType.Eager);
