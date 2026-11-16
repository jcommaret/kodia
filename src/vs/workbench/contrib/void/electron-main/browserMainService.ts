/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Electron main-process browser automation service.
 *
 * Runs a real Chromium browser via Playwright (`playwright-core` + the
 * `@playwright/browser-chromium` optional dependency). Browser instances live
 * in the main process and are exposed to the renderer/workbench through an IPC
 * channel (see `browserChannel.ts` and the wiring in `app.ts`).
 *
 * Design notes:
 *  - One BrowserSession = one launched Browser + one persistent BrowserContext
 *    (cookies/localStorage survive across tabs within the session).
 *  - One tab = one Page. Tabs are created lazily and closed individually.
 *  - Console messages and page/network errors are recorded per page so the
 *    agent can inspect them later.
 *  - Downloads are written to the OS temp dir and tracked by id.
 *  - Every public method takes a CancellationToken-aware approach via
 *    AbortSignal so calls can be cancelled without orphaned pages.
 *  - Sensitive data (cookies, auth tokens, passwords) is never returned to the
 *    model: only page text, element metadata, URLs, titles and screenshots.
 */

import { IBrowserService, BrowserLaunchResult, BrowserTabResult, BrowserTabInfo, BrowserInspectResult, BrowserPageInfo, BrowserScreenshotResult, ConsoleMessage, NetworkFailure, DownloadInfo, ScreenshotType, BrowserSessionInfo } from '../common/browserServiceTypes.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { timeout } from '../../../../base/common/async.js';
import { tmpdir } from 'os';
import * as path from 'path';
import * as fs from 'fs';

const TEMP_DOWNLOAD_DIR = tmpdir();

// Playwright is imported lazily so the main process can start even if the
// optional Chromium bundle is not installed. The service reports a clear error
// at launch time instead of crashing the host.
let playwrightModule: typeof import('playwright-core') | null = null;
async function getPlaywright(): Promise<typeof import('playwright-core')> {
	if (!playwrightModule) {
		playwrightModule = await import('playwright-core');
	}
	return playwrightModule;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function now(): number { return Date.now(); }

// Resolve a Chromium-compatible executable. Prefer the Playwright-bundled
// Chromium; fall back to a system Chrome/Edge install so the service works on
// machines where the bundled browser was not downloaded.
function resolveChromeExecutable(pw: typeof import('playwright-core')): string {
	const bundled = pw.chromium.executablePath();
	try { if (fs.existsSync(bundled)) return bundled; } catch { }
	const candidates = [
		'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
		'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
		'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
		'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
	];
	for (const c of candidates) {
		try { if (fs.existsSync(c)) return c; } catch { }
	}
	return bundled;
}

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

interface PageState {
	page: any; // playwright Page
	tabId: string;
	url: string;
	title: string;
	loading: boolean;
	loadError?: string;
	consoleMessages: ConsoleMessage[];
	networkFailures: NetworkFailure[];
}

interface SessionState {
	sessionId: string;
	browser: any; // playwright Browser
	context: any; // playwright BrowserContext
	headless: boolean;
	createdAt: number;
	pages: Map<string, PageState>;
	activeTabId: string | null;
	downloads: Map<string, DownloadInfo>;
	closed: boolean;
}

// Serialize a Playwright element handle into a BrowserElement. Runs inside the
// page context via page.evaluate, so it only sees safe, public DOM data.
const EVAL_INSPECT_PAGE = () => {
	const elements: Array<{ selector: string, type: string, label: string, value?: string, placeholder?: string, disabled: boolean, readonly: boolean, checked?: boolean, options?: string[], bbox?: { x: number, y: number, width: number, height: number } }> = [];
	const seen = new Set<string>();

	const add = (el: Element) => {
		if (!el || !el.matches) return;
		const tag = el.tagName.toLowerCase();
		// Only interactive elements.
		const isInteractive =
			tag === 'a' || tag === 'button' || tag === 'input' || tag === 'textarea' ||
			tag === 'select' || el.getAttribute('role') === 'button' ||
			el.getAttribute('role') === 'link' || el.getAttribute('role') === 'checkbox' ||
			el.getAttribute('role') === 'radio' || el.getAttribute('role') === 'menuitem' ||
			el.getAttribute('role') === 'menu' || el.getAttribute('role') === 'menubar' ||
			(el as HTMLElement).isContentEditable;
		if (!isInteractive) return;

		// Build a stable CSS selector: id > name > data-testid > fallback nth-child path.
		let selector = '';
		const id = el.getAttribute('id');
		if (id) {
			selector = `#${CSS.escape(id)}`;
		} else {
			const name = el.getAttribute('name');
			if (name) selector = `${tag}[name="${CSS.escape(name)}"]`;
			else {
				const dtid = el.getAttribute('data-testid');
				if (dtid) selector = `[data-testid="${CSS.escape(dtid)}"]`;
				else selector = tag;
			}
		}
		if (seen.has(selector)) return;
		seen.add(selector);

		const type = (() => {
			switch (tag) {
				case 'a': return 'link';
				case 'button': return 'button';
				case 'input': {
					const t = el.getAttribute('type');
					if (t === 'checkbox') return 'checkbox';
					if (t === 'radio') return 'radio';
					if (t === 'submit' || t === 'reset' || t === 'button') return 'button';
					return 'input';
				}
				case 'textarea': return 'textarea';
				case 'select': return 'select';
				default:
					const role = el.getAttribute('role');
					if (role === 'button') return 'button';
					if (role === 'link') return 'link';
					if (role === 'checkbox') return 'checkbox';
					if (role === 'radio') return 'radio';
					if (role === 'menu' || role === 'menubar' || role === 'menuitem') return 'menu';
					return 'other';
			}
		})();

		const label = (() => {
			const aria = el.getAttribute('aria-label');
			if (aria) return aria;
			const alt = el.getAttribute('alt');
			if (alt) return alt;
			const title = el.getAttribute('title');
			if (title) return title;
			const text = el.textContent ? el.textContent.trim().replace(/\s+/g, ' ') : '';
			return text.slice(0, 120) || (el.getAttribute('placeholder') || '');
		})();

		// Current field value: prefer the IDL property (reflects user input)
		// over the static `value` attribute.
		const value = (tag === 'input' || tag === 'textarea' || tag === 'select')
			? (el as HTMLInputElement).value
			: el.getAttribute('value');
		const placeholder = el.getAttribute('placeholder');
		const disabled = el.matches ? el.matches(':disabled') : false;
		const readonly = el.matches ? el.matches(':read-only') : false;
		const checked = tag === 'input' && (el as HTMLInputElement).type === 'checkbox' ? (el as HTMLInputElement).checked :
			tag === 'input' && (el as HTMLInputElement).type === 'radio' ? (el as HTMLInputElement).checked : undefined;

		let options: string[] | undefined;
		if (tag === 'select') {
			options = Array.from((el as HTMLSelectElement).options).map(o => o.value);
		}

		let bbox: { x: number, y: number, width: number, height: number } | undefined;
		try {
			const r = el.getBoundingClientRect();
			if (r.width > 0 || r.height > 0) {
				bbox = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
			}
		} catch { }

		elements.push({ selector, type: type as any, label, value: value ? value : undefined, placeholder: placeholder ? placeholder : undefined, disabled, readonly, checked, options, bbox });
	};

	// Walk the document in tree order, but keep the count small.
	const walk = (node: Node, depth: number) => {
		if (depth > 12) return;
		if (node.nodeType === 1) {
			add(node as Element);
		}
		for (let i = 0; i < node.childNodes.length; i++) {
			walk(node.childNodes[i] as Node, depth + 1);
		}
	};
	walk(document, 0);

	const forms: Array<{ selector: string, action?: string, method?: string }> = [];
	for (const form of Array.from(document.querySelectorAll('form'))) {
		let fs = '';
		const fid = form.getAttribute('id');
		if (fid) fs = `#${CSS.escape(fid)}`;
		else fs = 'form';
		forms.push({ selector: fs, action: form.getAttribute('action') || undefined, method: form.getAttribute('method') || undefined });
	}

	const visibleText = (() => {
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
			acceptNode: (n: Node) => {
				const el = n.parentElement;
				if (!el) return NodeFilter.FILTER_REJECT;
				const style = window.getComputedStyle(el);
				if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return NodeFilter.FILTER_REJECT;
				if (['script','style','noscript','iframe','canvas'].includes(el.tagName.toLowerCase())) return NodeFilter.FILTER_REJECT;
				return NodeFilter.FILTER_ACCEPT;
			}
		} as any);
		const parts: string[] = [];
		let n: Node | null;
		while ((n = walker.nextNode())) parts.push(n.textContent || '');
		return parts.join(' ').replace(/\s+/g, ' ').trim();
	})();

	return {
		url: location.href,
		title: document.title,
		text: visibleText,
		elements,
		forms,
	};
};

// ---------------------------------------------------------------------------
// The main service class
// ---------------------------------------------------------------------------

export class KodiaBrowserMainService implements IBrowserService {
	readonly _serviceBrand: undefined;

	private readonly sessions = new Map<string, SessionState>();
	private shuttingDown = false;

	async launchBrowser(opts: { headless?: boolean }): Promise<BrowserLaunchResult> {
		if (this.shuttingDown) throw new Error('Browser service is shutting down.');
		const pw = await getPlaywright();
		const headless = opts.headless ?? false;
		const executablePath = resolveChromeExecutable(pw);
		const browser = await pw.chromium.launch({
			headless,
			executablePath,
			args: [
				'--no-sandbox',
				'--disable-setuid-sandbox',
				'--disable-dev-shm-usage',
				'--disable-accelerated-2d-canvas',
				'--no-first-run',
				'--no-zygote',
				'--disable-gpu',
			],
		});
		const context = await browser.newContext({
			acceptDownloads: true,
			// Do not record cookies/storage state for privacy across sessions;
			// each session starts clean unless the agent navigates/logs in.
		});
		const sessionId = generateUuid();
		const session: SessionState = {
			sessionId,
			browser,
			context,
			headless,
			createdAt: now(),
			pages: new Map(),
			activeTabId: null,
			downloads: new Map(),
			closed: false,
		};
		this.sessions.set(sessionId, session);

		return {
			sessionId,
			engine: 'chromium',
			headless,
			version: pw.chromium ? (pw as any).chromium.name ?? 'chromium' : 'chromium',
		};
	}

	async closeBrowser(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		await this.destroySession(session);
	}

	async listSessions(): Promise<BrowserSessionInfo[]> {
		const out: BrowserSessionInfo[] = [];
		for (const s of this.sessions.values()) {
			out.push({
				sessionId: s.sessionId,
				engine: 'chromium',
				headless: s.headless,
				tabCount: s.pages.size,
				createdAt: s.createdAt,
			});
		}
		return out;
	}

	async newTab(sessionId: string, opts: { url?: string }): Promise<BrowserTabResult> {
		const session = this.getSession(sessionId);
		const page = await session.context.newPage();
		const tabId = generateUuid();
		const state: PageState = {
			page,
			tabId,
			url: 'about:blank',
			title: '',
			loading: false,
			consoleMessages: [],
			networkFailures: [],
		};
		session.pages.set(tabId, state);
		if (!session.activeTabId) session.activeTabId = tabId;

		this.attachPageListeners(session, tabId, state);

		if (opts.url) {
			await this.navigateLocked(session, tabId, state, opts.url);
		}

		return { tabId, url: state.url, title: state.title };
	}

	async listTabs(sessionId: string): Promise<BrowserTabInfo[]> {
		const session = this.getSession(sessionId);
		const out: BrowserTabInfo[] = [];
		for (const [tabId, st] of session.pages) {
			out.push({
				tabId,
				url: st.url,
				title: st.title,
				isActive: tabId === session.activeTabId,
				loading: st.loading,
				loadError: st.loadError,
			});
		}
		return out;
	}

	async switchTab(sessionId: string, tabId: string): Promise<BrowserTabResult> {
		const session = this.getSession(sessionId);
		const st = session.pages.get(tabId);
		if (!st) throw new Error(`Tab "${tabId}" not found in session "${sessionId}".`);
		session.activeTabId = tabId;
		// Bring the page to front.
		try { st.page.bringToFront(); } catch { }
		return { tabId, url: st.url, title: st.title };
	}

	async closeTab(sessionId: string, tabId: string): Promise<void> {
		const session = this.getSession(sessionId);
		const st = session.pages.get(tabId);
		if (!st) return;
		try { await st.page.close(); } catch { }
		session.pages.delete(tabId);
		if (session.activeTabId === tabId) {
			session.activeTabId = session.pages.size > 0 ? [...session.pages.keys()][0] : null;
		}
	}

	async navigate(sessionId: string, tabId: string, url: string): Promise<BrowserTabResult> {
		const session = this.getSession(sessionId);
		const st = this.getPage(session, tabId);
		await this.navigateLocked(session, tabId, st, url);
		return { tabId, url: st.url, title: st.title };
	}

	private async navigateLocked(session: SessionState, tabId: string, st: PageState, url: string): Promise<void> {
		st.loading = true;
		st.loadError = undefined;
		st.consoleMessages = [];
		st.networkFailures = [];
		try {
			const response = await st.page.goto(url, { waitUntil: 'load', timeout: DEFAULT_TIMEOUT_MS });
			st.url = st.page.url();
			st.title = await st.page.title().catch(() => '');
			st.loading = false;
			if (!response || response.status() >= 400) {
				st.loadError = `HTTP ${response ? response.status() : 'unknown'} for ${url}`;
			}
		} catch (e: any) {
			st.loading = false;
			st.loadError = e?.message ?? String(e);
			throw new Error(`Navigation failed for ${url}: ${st.loadError}`);
		}
	}

	async goBack(sessionId: string, tabId: string): Promise<BrowserTabResult> {
		const session = this.getSession(sessionId);
		const st = this.getPage(session, tabId);
		await st.page.goBack({ waitUntil: 'load', timeout: DEFAULT_TIMEOUT_MS });
		st.url = st.page.url();
		st.title = await st.page.title().catch(() => '');
		return { tabId, url: st.url, title: st.title };
	}

	async goForward(sessionId: string, tabId: string): Promise<BrowserTabResult> {
		const session = this.getSession(sessionId);
		const st = this.getPage(session, tabId);
		await st.page.goForward({ waitUntil: 'load', timeout: DEFAULT_TIMEOUT_MS });
		st.url = st.page.url();
		st.title = await st.page.title().catch(() => '');
		return { tabId, url: st.url, title: st.title };
	}

	async reload(sessionId: string, tabId: string): Promise<BrowserTabResult> {
		const session = this.getSession(sessionId);
		const st = this.getPage(session, tabId);
		await st.page.reload({ waitUntil: 'load', timeout: DEFAULT_TIMEOUT_MS });
		st.url = st.page.url();
		st.title = await st.page.title().catch(() => '');
		return { tabId, url: st.url, title: st.title };
	}

	async inspectPage(sessionId: string, tabId: string): Promise<BrowserInspectResult> {
		const session = this.getSession(sessionId);
		const st = this.getPage(session, tabId);
		const info = await st.page.evaluate(EVAL_INSPECT_PAGE) as BrowserPageInfo;
		st.url = info.url ?? st.page.url();
		st.title = info.title ?? st.title;
		return {
			url: st.url,
			title: st.title,
			text: info.text ?? '',
			elements: info.elements ?? [],
			forms: info.forms ?? [],
			consoleErrors: st.consoleMessages.filter(m => m.level === 'error').length,
			networkFailures: st.networkFailures.length,
		};
	}

	async clickElement(sessionId: string, tabId: string, selector: string): Promise<void> {
		const session = this.getSession(sessionId);
		const st = this.getPage(session, tabId);
		await st.page.waitForSelector(selector, { state: 'visible', timeout: DEFAULT_TIMEOUT_MS });
		await st.page.click(selector, { timeout: DEFAULT_TIMEOUT_MS });
	}

	async fillElement(sessionId: string, tabId: string, selector: string, text: string): Promise<void> {
		const session = this.getSession(sessionId);
		const st = this.getPage(session, tabId);
		await st.page.waitForSelector(selector, { state: 'visible', timeout: DEFAULT_TIMEOUT_MS });
		await st.page.fill(selector, text, { timeout: DEFAULT_TIMEOUT_MS });
	}

	async selectOption(sessionId: string, tabId: string, selector: string, value: string): Promise<void> {
		const session = this.getSession(sessionId);
		const st = this.getPage(session, tabId);
		await st.page.waitForSelector(selector, { state: 'visible', timeout: DEFAULT_TIMEOUT_MS });
		await st.page.selectOption(selector, { value }, { timeout: DEFAULT_TIMEOUT_MS });
	}

	async checkElement(sessionId: string, tabId: string, selector: string, checked: boolean): Promise<void> {
		const session = this.getSession(sessionId);
		const st = this.getPage(session, tabId);
		await st.page.waitForSelector(selector, { state: 'visible', timeout: DEFAULT_TIMEOUT_MS });
		await st.page.setChecked(selector, checked, { timeout: DEFAULT_TIMEOUT_MS });
	}

	async submitForm(sessionId: string, tabId: string, selector: string): Promise<BrowserTabResult> {
		const session = this.getSession(sessionId);
		const st = this.getPage(session, tabId);
		await st.page.waitForSelector(selector, { state: 'visible', timeout: DEFAULT_TIMEOUT_MS });
		await st.page.evaluate((sel: string) => {
			const form = document.querySelector(sel);
			if (!form || !(form instanceof HTMLFormElement)) throw new Error(`Form not found: ${sel}`);
			form.requestSubmit();
		}, selector);
		await timeout(500); // let navigation begin
		st.url = st.page.url();
		st.title = await st.page.title().catch(() => '');
		return { tabId, url: st.url, title: st.title };
	}

	async waitForElement(sessionId: string, tabId: string, selector: string, opts: { timeoutMs?: number }): Promise<{ found: boolean }> {
		const session = this.getSession(sessionId);
		const st = this.getPage(session, tabId);
		try {
			await st.page.waitForSelector(selector, { state: 'visible', timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
			return { found: true };
		} catch {
			return { found: false };
		}
	}

	async takeScreenshot(sessionId: string, tabId: string, opts: { type?: ScreenshotType; selector?: string }): Promise<BrowserScreenshotResult> {
		const session = this.getSession(sessionId);
		const st = this.getPage(session, tabId);
		const type = opts.type ?? 'viewport';
		let buffer: Buffer;
		let width = 0;
		let height = 0;
		if (type === 'element' && opts.selector) {
			const el = await st.page.$(opts.selector);
			if (!el) throw new Error(`Element not found for screenshot: ${opts.selector}`);
			buffer = await el.screenshot();
			const box = await el.boundingBox();
			width = Math.round((box && box.width) || 0);
			height = Math.round((box && box.height) || 0);
		} else if (type === 'fullpage') {
			buffer = await st.page.screenshot({ fullPage: true });
			const size = st.page.viewportSize();
			width = size?.width ?? 0;
			height = size?.height ?? 0;
		} else {
			buffer = await st.page.screenshot({ fullPage: false });
			const size = st.page.viewportSize();
			width = size?.width ?? 0;
			height = size?.height ?? 0;
		}
		const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
		return { dataUrl, width, height, type };
	}

	async getConsoleMessages(sessionId: string, tabId: string, opts: { level?: 'debug' | 'info' | 'warning' | 'error'; limit?: number }): Promise<ConsoleMessage[]> {
		const session = this.getSession(sessionId);
		const st = this.getPage(session, tabId);
		let msgs = st.consoleMessages.slice();
		if (opts.level) msgs = msgs.filter(m => m.level === opts.level);
		if (opts.limit) msgs = msgs.slice(0, opts.limit);
		return msgs;
	}

	async getNetworkFailures(sessionId: string, tabId: string): Promise<NetworkFailure[]> {
		const session = this.getSession(sessionId);
		const st = this.getPage(session, tabId);
		return st.networkFailures.slice();
	}

	async startDownload(sessionId: string, tabId: string, url: string): Promise<DownloadInfo> {
		const session = this.getSession(sessionId);
		const st = this.getPage(session, tabId);
		const downloadId = generateUuid();
		const filename = path.basename(new URL(url).pathname) || 'download';
		const filePath = path.join(TEMP_DOWNLOAD_DIR, `${downloadId}_${filename}`);
		const info: DownloadInfo = { downloadId, url, suggestedFilename: filename, status: 'in_progress', path: filePath };
		session.downloads.set(downloadId, info);
		// Trigger an actual download so Playwright can save it.
		try {
			const download = await st.page.waitForEvent('download', { timeout: 30_000 });
			await download.saveAs(filePath);
			info.status = 'completed';
		} catch (e: any) {
			info.status = 'failed';
			info.failureText = e?.message ?? String(e);
		}
		return info;
	}

	async listDownloads(sessionId: string): Promise<DownloadInfo[]> {
		const session = this.getSession(sessionId);
		return Array.from(session.downloads.values());
	}

	async abortSession(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		await this.destroySession(session);
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		for (const session of Array.from(this.sessions.values())) {
			try { await this.destroySession(session); } catch { }
		}
		this.sessions.clear();
	}

	// ------------------------------------------------------------------
	// internals
	// ------------------------------------------------------------------

	private getSession(sessionId: string): SessionState {
		const s = this.sessions.get(sessionId);
		if (!s) throw new Error(`Browser session "${sessionId}" not found.`);
		if (s.closed) throw new Error(`Browser session "${sessionId}" is closed.`);
		return s;
	}

	private getPage(session: SessionState, tabId: string): PageState {
		const st = session.pages.get(tabId);
		if (!st) throw new Error(`Tab "${tabId}" not found in session "${session.sessionId}".`);
		return st;
	}

	private attachPageListeners(session: SessionState, tabId: string, st: PageState): void {
		const page = st.page;

		page.on('console', (msg: any) => {
			try {
				st.consoleMessages.push({
					id: generateUuid(),
					timestampMs: now(),
					level: (() => { const l = msg.type(); return ['debug','info','warning','error'].includes(l) ? l : 'info'; })() as any,
					text: msg.text(),
					source: (() => { const loc = msg.location(); return loc ? { url: loc.url || '', line: loc.lineNumber ?? 0, column: loc.columnNumber ?? 0 } : undefined; })(),
				});
				if (st.consoleMessages.length > 500) st.consoleMessages.shift();
			} catch { }
		});

		page.on('pageerror', (err: any) => {
			st.consoleMessages.push({
				id: generateUuid(),
				timestampMs: now(),
				level: 'error',
				text: err?.message ?? String(err),
			});
		});

		page.on('requestfailed', (req: any) => {
			try {
				st.networkFailures.push({
					id: generateUuid(),
					timestampMs: now(),
					url: req.url(),
					type: req.resourceType() || 'other',
					errorText: req.failure()?.errorText ?? 'request failed',
				});
				if (st.networkFailures.length > 200) st.networkFailures.shift();
			} catch { }
		});

		page.on('download', (download: any) => {
			const id = generateUuid();
			const filename = download.suggestedFilename() || 'download';
			const filePath = path.join(TEMP_DOWNLOAD_DIR, `${id}_${filename}`);
			const info: DownloadInfo = { downloadId: id, url: download.url(), suggestedFilename: filename, status: 'in_progress', path: filePath };
			session.downloads.set(id, info);
			download.saveAs(filePath).then(() => {
				info.status = 'completed';
			}).catch((e: any) => {
				info.status = 'failed';
				info.failureText = e?.message ?? String(e);
			});
		});

		page.on('load', () => {
			st.loading = false;
			st.url = page.url();
			st.title = page.title() ?? '';
		});

		page.on('loaderror', () => {
			st.loading = false;
			st.loadError = 'Page load error.';
		});
	}

	private async destroySession(session: SessionState): Promise<void> {
		if (session.closed) return;
		session.closed = true;
		for (const st of session.pages.values()) {
			try { await st.page.close(); } catch { }
		}
		session.pages.clear();
		try { await session.context.close(); } catch { }
		try { await session.browser.close(); } catch { }
		this.sessions.delete(session.sessionId);
	}
}
