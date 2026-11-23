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
import type { BrowserVisualAuditResult, MultiViewportAuditResult, ViewportScreenshotCapture } from '../common/designIntelligenceTypes.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { timeout } from '../../../../base/common/async.js';
import { tmpdir } from 'os';
import * as path from 'path';
import * as fs from 'fs';

const TEMP_DOWNLOAD_DIR = path.join(tmpdir(), 'kodia-browser-downloads');
const SCREENSHOT_DIR = path.join(tmpdir(), 'kodia-browser-screenshots');
const NAVIGATION_START_GRACE_MS = 150;

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
	status?: number; // HTTP status of the main document
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

// Inspect the page. Runs inside the page context via page.evaluate (the function is serialized, so it must be
// self-contained), so it only sees public DOM data. Every element gets a selector that matches exactly that
// element, and the page is checked for layout defects a user would see (content wider than the viewport,
// controls covered by other elements or pushed off-screen, clipped text).
const EVAL_INSPECT_PAGE = (maxElements: number) => {
	const elements: Array<{ selector: string, type: string, label: string, value?: string, placeholder?: string, disabled: boolean, readonly: boolean, checked?: boolean, options?: string[], visible: boolean, inViewport: boolean, bbox?: { x: number, y: number, width: number, height: number } }> = [];
	const vw = document.documentElement.clientWidth;
	const vh = document.documentElement.clientHeight;

	const isUnique = (sel: string, el: Element) => {
		try { const m = document.querySelectorAll(sel); return m.length === 1 && m[0] === el; } catch { return false; }
	};
	// id > name > data-testid when unique, otherwise a tag:nth-of-type path from the nearest uniquely-identified
	// ancestor. Never a bare tag that matches several elements (an agent clicking it would hit the first one).
	const selectorOf = (el: Element): string => {
		const tag = el.tagName.toLowerCase();
		const id = el.getAttribute('id');
		if (id && isUnique(`#${CSS.escape(id)}`, el)) return `#${CSS.escape(id)}`;
		const name = el.getAttribute('name');
		if (name && isUnique(`${tag}[name="${CSS.escape(name)}"]`, el)) return `${tag}[name="${CSS.escape(name)}"]`;
		const dtid = el.getAttribute('data-testid');
		if (dtid && isUnique(`[data-testid="${CSS.escape(dtid)}"]`, el)) return `[data-testid="${CSS.escape(dtid)}"]`;
		const parts: string[] = [];
		let cur: Element | null = el;
		while (cur && cur !== document.documentElement) {
			const ctag = cur.tagName.toLowerCase();
			const cid = cur !== el ? cur.getAttribute('id') : null;
			if (cid && isUnique(`#${CSS.escape(cid)}`, cur)) { parts.unshift(`#${CSS.escape(cid)}`); break; }
			const parent: Element | null = cur.parentElement;
			if (!parent) { parts.unshift(ctag); break; }
			const sameTag = Array.from(parent.children).filter(c => c.tagName === cur!.tagName);
			parts.unshift(sameTag.length > 1 ? `${ctag}:nth-of-type(${sameTag.indexOf(cur) + 1})` : ctag);
			cur = parent;
		}
		return parts.join(' > ');
	};
	const isVisible = (el: Element) => {
		const r = el.getBoundingClientRect();
		if (r.width === 0 && r.height === 0) return false;
		for (let cur: Element | null = el; cur; cur = cur.parentElement) {
			const s = window.getComputedStyle(cur);
			if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
		}
		return true;
	};

	const INTERACTIVE = 'a[href], button, input:not([type="hidden"]), textarea, select, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="menu"], [role="menubar"], [contenteditable=""], [contenteditable="true"]';
	const interactive = Array.from(document.querySelectorAll(INTERACTIVE));
	const totalElements = interactive.length;

	const add = (el: Element) => {
		const tag = el.tagName.toLowerCase();
		const selector = selectorOf(el);

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
		const r = el.getBoundingClientRect();
		if (r.width > 0 || r.height > 0) {
			bbox = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
		}
		const visible = isVisible(el);
		const inViewport = visible && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;

		elements.push({ selector, type: type as any, label, value: value ? value : undefined, placeholder: placeholder ? placeholder : undefined, disabled, readonly, checked, options, visible, inViewport, bbox });
	};
	for (const el of interactive.slice(0, maxElements)) { add(el); }

	const forms: Array<{ selector: string, action?: string, method?: string }> = [];
	for (const form of Array.from(document.querySelectorAll('form'))) {
		forms.push({ selector: selectorOf(form), action: form.getAttribute('action') || undefined, method: form.getAttribute('method') || undefined });
	}

	// --- layout defects ---
	const layoutIssues: Array<{ kind: string, selector: string, detail: string }> = [];
	const MAX_ISSUES = 20;
	const describe = (el: Element) => {
		const t = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
		return `${selectorOf(el)}${t ? ` ("${t}")` : ''}`;
	};
	const all = Array.from(document.body ? document.body.querySelectorAll('*') : []).filter(el => !['script', 'style', 'noscript', 'template'].includes(el.tagName.toLowerCase()));

	// 1. content wider than the viewport: report the outermost elements that stick out (their parent does not),
	//    which is where the fixed width / negative margin / long word is.
	const scrollWidth = document.documentElement.scrollWidth;
	if (scrollWidth > vw + 1) {
		for (const el of all) {
			if (layoutIssues.length >= MAX_ISSUES) break;
			const r = el.getBoundingClientRect();
			if (r.width === 0 || r.right <= vw + 1 || !isVisible(el)) continue;
			const p = el.parentElement;
			const pr = p ? p.getBoundingClientRect() : null;
			if (p && p !== document.body && pr && pr.right > vw + 1) continue;
			layoutIssues.push({ kind: 'horizontal-overflow', selector: selectorOf(el), detail: `extends to x=${Math.round(r.right)}px but the viewport is ${vw}px wide (page scrolls sideways: document is ${scrollWidth}px wide)` });
		}
	}
	// 2. interactive elements a user cannot reach: covered by another element, or placed outside the page.
	for (const el of interactive.slice(0, maxElements)) {
		if (layoutIssues.length >= MAX_ISSUES) break;
		if (!isVisible(el)) continue;
		const r = el.getBoundingClientRect();
		if (r.right <= 0 || r.bottom <= 0 || r.left >= scrollWidth) {
			layoutIssues.push({ kind: 'offscreen', selector: selectorOf(el), detail: `interactive element is outside the page (x=${Math.round(r.left)}, y=${Math.round(r.top)}) and cannot be reached` });
			continue;
		}
		if (r.left < 0 || r.top < 0 || r.right > vw || r.bottom > vh) continue; // only check what is on screen now
		const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
		const hit = document.elementFromPoint(cx, cy);
		if (hit && hit !== el && !el.contains(hit) && !(hit as Element).contains(el)) {
			layoutIssues.push({ kind: 'covered', selector: selectorOf(el), detail: `the center of this control is covered by ${describe(hit)}, so clicks go to that element` });
		}
	}
	// 3. text cut off by an overflow-hidden box.
	for (const el of all) {
		if (layoutIssues.length >= MAX_ISSUES) break;
		const s = window.getComputedStyle(el);
		const clipsX = s.overflowX === 'hidden' || s.overflowX === 'clip';
		const clipsY = s.overflowY === 'hidden' || s.overflowY === 'clip';
		if (!clipsX && !clipsY) continue;
		if (!Array.from(el.childNodes).some(n => n.nodeType === 3 && (n.textContent || '').trim().length > 0)) continue;
		if (s.textOverflow === 'ellipsis' || !isVisible(el)) continue; // an ellipsis is a deliberate truncation
		const h = el as HTMLElement;
		if ((clipsX && h.scrollWidth > h.clientWidth + 1) || (clipsY && h.scrollHeight > h.clientHeight + 1)) {
			layoutIssues.push({ kind: 'clipped-text', selector: selectorOf(el), detail: `text is cut off: content is ${h.scrollWidth}x${h.scrollHeight}px in a ${h.clientWidth}x${h.clientHeight}px box with overflow hidden` });
		}
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
		totalElements,
		forms,
		viewport: { width: vw, height: vh },
		layoutIssues,
	};
};
const MAX_INSPECT_ELEMENTS = 300;

// ---------------------------------------------------------------------------
// The main service class
// ---------------------------------------------------------------------------

export class KodiaBrowserMainService implements IBrowserService {
	readonly _serviceBrand: undefined;

	private readonly sessions = new Map<string, SessionState>();
	private shuttingDown = false;

	async launchBrowser(opts: { headless?: boolean; viewport?: { width: number; height: number } }): Promise<BrowserLaunchResult> {
		if (this.shuttingDown) throw new Error('Browser service is shutting down.');
		const pw = await getPlaywright();
		const headless = opts.headless ?? false;
		const executablePath = resolveChromeExecutable(pw);
		const viewport = opts.viewport ?? { width: 1280, height: 800 };
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
			viewport,
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

		return this.tabResult(tabId, state);
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
		return this.tabResult(tabId, st);
	}

	// A fresh document: clear what was captured for the previous one, then load.
	private resetCapturedState(st: PageState): void {
		st.loading = true;
		st.loadError = undefined;
		st.status = undefined;
		st.consoleMessages = [];
		st.networkFailures = [];
	}

	// The HTTP status of the main document is part of the result: a 404/500 page still "loads".
	private recordResponse(st: PageState, response: any, what: string): void {
		st.loading = false;
		st.status = response ? response.status() : undefined;
		if (response && response.status() >= 400) {
			st.loadError = `HTTP ${response.status()} for ${what}`;
		}
	}

	private async refreshUrlAndTitle(st: PageState): Promise<void> {
		st.url = st.page.url();
		st.title = await st.page.title().catch(() => st.title);
	}

	private tabResult(tabId: string, st: PageState, navigated?: boolean): BrowserTabResult {
		return { tabId, url: st.url, title: st.title, status: st.status, loadError: st.loadError, ...(navigated !== undefined ? { navigated } : {}) };
	}

	private async navigateLocked(session: SessionState, tabId: string, st: PageState, url: string): Promise<void> {
		this.resetCapturedState(st);
		try {
			const response = await st.page.goto(url, { waitUntil: 'load', timeout: DEFAULT_TIMEOUT_MS });
			await this.refreshUrlAndTitle(st);
			this.recordResponse(st, response, url);
		} catch (e: any) {
			st.loading = false;
			st.loadError = e?.message ?? String(e);
			throw new Error(`Navigation failed for ${url}: ${st.loadError}`);
		}
	}

	private async historyStep(sessionId: string, tabId: string, step: 'goBack' | 'goForward' | 'reload'): Promise<BrowserTabResult> {
		const session = this.getSession(sessionId);
		const st = this.getPage(session, tabId);
		this.resetCapturedState(st);
		const response = await st.page[step]({ waitUntil: 'load', timeout: DEFAULT_TIMEOUT_MS });
		if (!response && step !== 'reload') {
			st.loading = false;
			throw new Error(step === 'goBack' ? 'There is no previous page in this tab\'s history.' : 'There is no next page in this tab\'s history.');
		}
		await this.refreshUrlAndTitle(st);
		this.recordResponse(st, response, st.url);
		return this.tabResult(tabId, st);
	}

	goBack(sessionId: string, tabId: string): Promise<BrowserTabResult> { return this.historyStep(sessionId, tabId, 'goBack'); }
	goForward(sessionId: string, tabId: string): Promise<BrowserTabResult> { return this.historyStep(sessionId, tabId, 'goForward'); }
	reload(sessionId: string, tabId: string): Promise<BrowserTabResult> { return this.historyStep(sessionId, tabId, 'reload'); }

	async inspectPage(sessionId: string, tabId: string): Promise<BrowserInspectResult> {
		const session = this.getSession(sessionId);
		const st = this.getPage(session, tabId);
		const info = await st.page.evaluate(EVAL_INSPECT_PAGE, MAX_INSPECT_ELEMENTS) as BrowserPageInfo;
		st.url = info.url ?? st.page.url();
		st.title = info.title ?? st.title;
		const errors = st.consoleMessages.filter(m => m.level === 'error');
		return {
			url: st.url,
			title: st.title,
			status: st.status,
			loadError: st.loadError,
			text: info.text ?? '',
			elements: info.elements ?? [],
			totalElements: info.totalElements ?? (info.elements ?? []).length,
			forms: info.forms ?? [],
			viewport: info.viewport,
			layoutIssues: info.layoutIssues ?? [],
			consoleErrors: errors.length,
			recentConsoleErrors: errors.slice(-5).map(m => m.text),
			networkFailures: st.networkFailures.length,
			recentNetworkFailures: st.networkFailures.slice(-5).map(f => `${f.url} — ${f.errorText}`),
		};
	}

	/**
	 * Run a page action that may start a navigation (a link click, a form submit) and, if it does, wait for the
	 * new document to load before returning — otherwise the agent inspects the old page (or a half-loaded one).
	 * A navigation is detected by the main-frame navigation request it issues.
	 */
	private async runPossiblyNavigatingAction(st: PageState, action: () => Promise<void>): Promise<boolean> {
		const page = st.page;
		let navigation: Promise<unknown> | undefined;
		const onRequest = (req: any) => {
			try {
				if (!navigation && req.isNavigationRequest() && req.frame() === page.mainFrame()) {
					this.resetCapturedState(st);
					const loaded = page.waitForEvent('load', { timeout: DEFAULT_TIMEOUT_MS }).catch(() => { });
					const responded = req.response().then((res: any) => {
						this.recordResponse(st, res, req.url());
						if (!res) { st.loadError = `Navigation to ${req.url()} failed: ${req.failure()?.errorText ?? 'no response'}`; }
						return res;
					}, () => null);
					// a request that fails (no response) never loads: don't wait the full timeout for it
					navigation = Promise.race([loaded, responded.then((res: any) => res ? loaded : undefined)]);
				}
			} catch { }
		};
		page.on('request', onRequest);
		try {
			await action();
			await timeout(NAVIGATION_START_GRACE_MS); // a click handler may navigate on the next tick
			if (navigation) { await navigation; }
		} finally {
			page.off('request', onRequest);
		}
		st.loading = false;
		await this.refreshUrlAndTitle(st);
		return !!navigation;
	}

	async clickElement(sessionId: string, tabId: string, selector: string): Promise<BrowserTabResult> {
		const session = this.getSession(sessionId);
		const st = this.getPage(session, tabId);
		await st.page.waitForSelector(selector, { state: 'visible', timeout: DEFAULT_TIMEOUT_MS });
		const matches = await st.page.$$eval(selector, (els: Element[]) => els.length).catch(() => 1);
		if (matches > 1) {
			throw new Error(`Selector "${selector}" matches ${matches} elements; use a selector that matches exactly one (browser_inspect_page lists one per element).`);
		}
		const navigated = await this.runPossiblyNavigatingAction(st, () => st.page.click(selector, { timeout: DEFAULT_TIMEOUT_MS }));
		return this.tabResult(tabId, st, navigated);
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
		await st.page.waitForSelector(selector, { state: 'attached', timeout: DEFAULT_TIMEOUT_MS });
		const navigated = await this.runPossiblyNavigatingAction(st, () => st.page.evaluate((sel: string) => {
			const form = document.querySelector(sel);
			if (!form || !(form instanceof HTMLFormElement)) { throw new Error(`No <form> matches ${sel}`); }
			form.requestSubmit();
		}, selector));
		return this.tabResult(tabId, st, navigated);
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

	async setViewport(sessionId: string, tabId: string, viewport: { width: number; height: number }): Promise<void> {
		const session = this.getSession(sessionId);
		const st = this.getPage(session, tabId);
		await st.page.setViewportSize(viewport);
	}

	async takeScreenshot(sessionId: string, tabId: string, opts: { type?: ScreenshotType; selector?: string }): Promise<BrowserScreenshotResult> {
		const session = this.getSession(sessionId);
		const st = this.getPage(session, tabId);
		const type = opts.type ?? 'viewport';
		let buffer: Buffer;
		let width = 0;
		let height = 0;
		if (type === 'element') {
			if (!opts.selector) throw new Error('An element screenshot needs a selector.');
			const el = await st.page.$(opts.selector);
			if (!el) throw new Error(`Element not found for screenshot: ${opts.selector}`);
			buffer = await el.screenshot();
			const box = await el.boundingBox();
			width = Math.round((box && box.width) || 0);
			height = Math.round((box && box.height) || 0);
		} else if (type === 'fullpage') {
			buffer = await st.page.screenshot({ fullPage: true });
			const size = await st.page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
			width = size.width;
			height = size.height;
		} else {
			buffer = await st.page.screenshot({ fullPage: false });
			const size = st.page.viewportSize();
			width = size?.width ?? 0;
			height = size?.height ?? 0;
		}
		// Also on disk, so the user (or a vision tool) can open it: the text result the model gets only says where.
		fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
		const filePath = path.join(SCREENSHOT_DIR, `${generateUuid()}.png`);
		fs.writeFileSync(filePath, buffer);
		const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
		return { dataUrl, width, height, type, path: filePath };
	}

	async auditDesignVisuals(sessionId: string, tabId: string): Promise<BrowserVisualAuditResult> {
		const session = this.getSession(sessionId);
		const st = this.getPage(session, tabId);
		const raw = await st.page.evaluate(() => {
			const vw = document.documentElement.clientWidth;
			const vh = document.documentElement.clientHeight;
			const scrollWidth = document.documentElement.scrollWidth;
			const scrollHeight = document.documentElement.scrollHeight;

			const selectorOf = (el: Element): string => {
				const tag = el.tagName.toLowerCase();
				const id = el.getAttribute('id');
				if (id) { return `#${id}`; }
				const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
				return cls ? `${tag}.${cls}` : tag;
			};

			const isVisible = (el: Element): boolean => {
				const r = el.getBoundingClientRect();
				if (r.width === 0 && r.height === 0) { return false; }
				for (let cur: Element | null = el; cur; cur = cur.parentElement) {
					const cs = window.getComputedStyle(cur);
					if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') { return false; }
				}
				return true;
			};

			const parseRgba = (colorStr: string): [number, number, number, number] | null => {
				const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)/i.exec(colorStr);
				if (!m) { return null; }
				return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] !== undefined ? Number(m[4]) : 1];
			};

			const luminance = (r: number, g: number, b: number): number => {
				const f = (c: number) => {
					const s = c / 255;
					return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
				};
				return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
			};

			const contrastRatio = (c1: [number, number, number], c2: [number, number, number]): number => {
				const l1 = luminance(c1[0], c1[1], c1[2]);
				const l2 = luminance(c2[0], c2[1], c2[2]);
				const hi = Math.max(l1, l2);
				const lo = Math.min(l1, l2);
				return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
			};

			const resolveEffectiveBg = (el: Element): [number, number, number] => {
				let cur: Element | null = el;
				while (cur) {
					const parsed = parseRgba(window.getComputedStyle(cur).backgroundColor);
					if (parsed && parsed[3] >= 0.85) {
						return [parsed[0], parsed[1], parsed[2]];
					}
					cur = cur.parentElement;
				}
				return [255, 255, 255];
			};

			// 1. Imagery checks
			const brokenImages: Array<{ src: string; alt: string; selector: string }> = [];
			const distortedImages: Array<{ src: string; naturalRatio: number; renderedRatio: number; selector: string }> = [];
			const missingAltImages: Array<{ src: string; selector: string }> = [];
			for (const img of Array.from(document.querySelectorAll('img'))) {
				const src = img.getAttribute('src') || img.currentSrc || '(no src)';
				const sel = selectorOf(img);
				if (!img.hasAttribute('alt')) {
					missingAltImages.push({ src, selector: sel });
				}
				if (!isVisible(img)) { continue; }
				if (!img.complete || img.naturalWidth === 0 || img.naturalHeight === 0) {
					brokenImages.push({ src, alt: img.getAttribute('alt') || '', selector: sel });
				} else {
					const r = img.getBoundingClientRect();
					if (r.width > 16 && r.height > 16) {
						const natRatio = img.naturalWidth / img.naturalHeight;
						const renRatio = r.width / r.height;
						const cs = window.getComputedStyle(img);
						const distortion = Math.max(natRatio / renRatio, renRatio / natRatio);
						if (distortion > 1.38 && cs.objectFit !== 'cover' && cs.objectFit !== 'contain') {
							distortedImages.push({
								src,
								naturalRatio: Math.round(natRatio * 100) / 100,
								renderedRatio: Math.round(renRatio * 100) / 100,
								selector: sel,
							});
						}
					}
				}
			}

			// 2. WCAG Contrast checks on visible text elements
			const contrastViolations: Array<{ selector: string; textSample: string; foreground: string; background: string; ratio: number; required: number }> = [];
			const textNodes = Array.from(document.querySelectorAll('h1, h2, h3, h4, p, a, button, label, li, td, th, span'));
			for (const el of textNodes.slice(0, 260)) {
				if (contrastViolations.length >= 20) { break; }
				if (!isVisible(el)) { continue; }
				const directText = Array.from(el.childNodes)
					.filter(n => n.nodeType === 3)
					.map(n => (n.textContent || '').trim())
					.join(' ')
					.trim();
				if (directText.length < 2) { continue; }
				const cs = window.getComputedStyle(el);
				const fg = parseRgba(cs.color);
				if (!fg || fg[3] < 0.2) { continue; }
				const bg = resolveEffectiveBg(el);
				const fontSize = parseFloat(cs.fontSize) || 16;
				const fontWeight = parseInt(cs.fontWeight, 10) || 400;
				const isLarge = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
				const required = isLarge ? 3.0 : 4.5;
				const ratio = contrastRatio([fg[0], fg[1], fg[2]], bg);
				if (ratio < required) {
					contrastViolations.push({
						selector: selectorOf(el),
						textSample: directText.slice(0, 48),
						foreground: cs.color,
						background: `rgb(${bg[0]}, ${bg[1]}, ${bg[2]})`,
						ratio,
						required,
					});
				}
			}

			// 3. Structural Accessibility checks
			const accessibilityIssues: Array<{ rule: string; severity: 'critical' | 'major' | 'minor'; selector: string; detail: string }> = [];
			if (!document.documentElement.getAttribute('lang')) {
				accessibilityIssues.push({ rule: 'html-has-lang', severity: 'major', selector: 'html', detail: 'Document <html> element is missing a lang attribute.' });
			}
			if (!document.querySelector('main, [role="main"]')) {
				accessibilityIssues.push({ rule: 'landmark-main', severity: 'minor', selector: 'body', detail: 'Page is missing a <main> landmark.' });
			}
			const headingCounts: Record<string, number> = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };
			let prevLevel = 0;
			let headingHierarchyValid = true;
			for (const h of Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))) {
				const tag = h.tagName.toLowerCase();
				headingCounts[tag] = (headingCounts[tag] || 0) + 1;
				const level = Number(tag.slice(1));
				if (prevLevel > 0 && level > prevLevel + 1) {
					headingHierarchyValid = false;
					if (accessibilityIssues.length < 25) {
						accessibilityIssues.push({ rule: 'heading-order', severity: 'minor', selector: selectorOf(h), detail: `Heading level skipped from h${prevLevel} to h${level}.` });
					}
				}
				prevLevel = level;
			}
			if (headingCounts.h1 === 0) {
				headingHierarchyValid = false;
				accessibilityIssues.push({ rule: 'page-has-h1', severity: 'major', selector: 'body', detail: 'Page has no <h1> heading.' });
			}
			for (const img of missingAltImages.slice(0, 8)) {
				accessibilityIssues.push({ rule: 'img-alt', severity: 'major', selector: img.selector, detail: `Image "${img.src}" is missing an alt attribute.` });
			}
			for (const input of Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea')).slice(0, 40)) {
				if (!isVisible(input)) { continue; }
				const id = input.getAttribute('id');
				const hasLabel = !!(input.getAttribute('aria-label') || input.getAttribute('aria-labelledby') || input.closest('label') || (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)));
				if (!hasLabel) {
					accessibilityIssues.push({ rule: 'form-label', severity: 'major', selector: selectorOf(input), detail: 'Interactive form control has no associated <label> or aria-label.' });
				}
			}
			for (const btn of Array.from(document.querySelectorAll('button, [role="button"], a[href]')).slice(0, 80)) {
				if (!isVisible(btn)) { continue; }
				const name = (btn.getAttribute('aria-label') || btn.getAttribute('title') || btn.textContent || '').trim();
				if (!name) {
					accessibilityIssues.push({ rule: 'interactive-accessible-name', severity: 'critical', selector: selectorOf(btn), detail: 'Icon-only button or link has no accessible name (add aria-label).' });
				}
			}

			// 4. Layout & Touch Target checks
			const layoutIssues: Array<{ kind: string; selector: string; detail: string }> = [];
			if (scrollWidth > vw + 1) {
				layoutIssues.push({ kind: 'horizontal-overflow', selector: 'document', detail: `Page overflows horizontally: scrollWidth=${scrollWidth}px > viewport=${vw}px.` });
			}
			const smallTouchTargets: Array<{ selector: string; width: number; height: number; label: string }> = [];
			const interactives = Array.from(document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, [role="button"]'));
			for (const el of interactives.slice(0, 120)) {
				if (!isVisible(el)) { continue; }
				const r = el.getBoundingClientRect();
				if (vw <= 768 && (r.width < 40 || r.height < 40) && smallTouchTargets.length < 15) {
					smallTouchTargets.push({
						selector: selectorOf(el),
						width: Math.round(r.width),
						height: Math.round(r.height),
						label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40),
					});
				}
			}

			// 5. Typography metrics
			const fontSet = new Set<string>();
			for (const el of [document.body, ...Array.from(document.querySelectorAll('h1, h2, h3, p, button'))].slice(0, 40)) {
				if (!el) { continue; }
				const fam = window.getComputedStyle(el).fontFamily.split(',')[0].replace(/['"]/g, '').trim();
				if (fam) { fontSet.add(fam); }
			}
			const bodySize = document.body ? parseFloat(window.getComputedStyle(document.body).fontSize) : null;
			const h1El = document.querySelector('h1');
			const h1Size = h1El ? parseFloat(window.getComputedStyle(h1El).fontSize) : null;
			const loadedFontCount = (document as any).fonts ? Array.from((document as any).fonts).filter((f: any) => f.status === 'loaded').length : 0;

			// Reduced motion stylesheet check
			let hasReducedMotionMediaRule = false;
			try {
				for (const sheet of Array.from(document.styleSheets)) {
					let rules: CSSRuleList | undefined;
					try { rules = sheet.cssRules; } catch { continue; }
					if (!rules) { continue; }
					for (const rule of Array.from(rules)) {
						if (rule.cssText && rule.cssText.includes('prefers-reduced-motion')) {
							hasReducedMotionMediaRule = true;
							break;
						}
					}
					if (hasReducedMotionMediaRule) { break; }
				}
			} catch { /* cross-origin stylesheets */ }

			// 6. Performance metrics
			const allNodes = document.querySelectorAll('*');
			let maxDomDepth = 0;
			for (let i = 0; i < Math.min(allNodes.length, 400); i++) {
				let depth = 0;
				let cur: Element | null = allNodes[i];
				while (cur && depth < 64) { depth++; cur = cur.parentElement; }
				if (depth > maxDomDepth) { maxDomDepth = depth; }
			}
			const navEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
			const resEntries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
			let totalTransferBytes = 0;
			const largestResources = resEntries
				.map(r => {
					const bytes = r.transferSize || r.encodedBodySize || 0;
					totalTransferBytes += bytes;
					return { name: r.name.slice(-80), type: r.initiatorType || 'other', bytes, durationMs: Math.round(r.duration) };
				})
				.sort((a, b) => b.bytes - a.bytes)
				.slice(0, 6);

			const clsEntries = performance.getEntriesByType('layout-shift') as Array<{ value?: number; hadRecentInput?: boolean }>;
			const cls = clsEntries.reduce((sum, e) => sum + (e.hadRecentInput ? 0 : (e.value || 0)), 0);

			return {
				url: location.href,
				title: document.title,
				viewport: { width: vw, height: vh },
				brokenImages,
				distortedImages,
				missingAltImages,
				contrastViolations,
				accessibilityIssues,
				layoutIssues,
				smallTouchTargets,
				typographyMetrics: {
					fontFamilies: Array.from(fontSet),
					loadedFontCount,
					bodyFontSizePx: bodySize ? Math.round(bodySize * 10) / 10 : null,
					h1FontSizePx: h1Size ? Math.round(h1Size * 10) / 10 : null,
					headingHierarchyValid,
					headingCounts,
				},
				performanceMetrics: {
					domNodeCount: allNodes.length,
					maxDomDepth,
					ttfbMs: navEntry ? Math.round(navEntry.responseStart - navEntry.requestStart) : null,
					domContentLoadedMs: navEntry ? Math.round(navEntry.domContentLoadedEventEnd) : null,
					loadCompleteMs: navEntry ? Math.round(navEntry.loadEventEnd) : null,
					resourceCount: resEntries.length,
					totalTransferBytes,
					largestResources,
					cumulativeLayoutShift: Math.round(cls * 1000) / 1000,
				},
				pageMetrics: {
					scrollWidth,
					scrollHeight,
					hasHorizontalOverflow: scrollWidth > vw + 1,
					visibleTextLength: (document.body?.innerText || '').trim().length,
					interactiveElementCount: interactives.length,
					hasReducedMotionMediaRule,
				},
			};
		});

		const consoleErrors = st.consoleMessages.filter(m => m.level === 'error').length;
		return {
			...raw,
			loadError: st.loadError,
			consoleErrors,
			networkFailures: st.networkFailures.length,
		};
	}

	async captureMultiViewportAudit(
		sessionId: string,
		tabId: string,
		opts?: { viewports?: ReadonlyArray<{ label: string; width: number; height: number }>; fullPage?: boolean },
	): Promise<MultiViewportAuditResult> {
		const session = this.getSession(sessionId);
		const st = this.getPage(session, tabId);
		const originalViewport = st.page.viewportSize() ?? { width: 1280, height: 800 };
		const viewports = opts?.viewports && opts.viewports.length > 0
			? opts.viewports
			: [
				{ label: 'mobile', width: 375, height: 812 },
				{ label: 'tablet', width: 768, height: 1024 },
				{ label: 'desktop', width: 1440, height: 900 },
			];

		const captures: ViewportScreenshotCapture[] = [];
		try {
			for (const vp of viewports) {
				await st.page.setViewportSize({ width: vp.width, height: vp.height });
				await timeout(120);
				const [audit, shot] = await Promise.all([
					this.auditDesignVisuals(sessionId, tabId),
					this.takeScreenshot(sessionId, tabId, { type: opts?.fullPage ? 'fullpage' : 'viewport' }),
				]);
				captures.push({
					label: vp.label,
					width: vp.width,
					height: vp.height,
					path: shot.path,
					dataUrl: shot.dataUrl,
					hasHorizontalOverflow: audit.pageMetrics.hasHorizontalOverflow,
					layoutIssueCount: audit.layoutIssues.length,
					brokenImageCount: audit.brokenImages.length,
					smallTouchTargetCount: audit.smallTouchTargets.length,
					audit,
				});
			}
		} finally {
			await st.page.setViewportSize(originalViewport).catch(() => { });
		}

		const allViewportsClean = captures.every(c => !c.hasHorizontalOverflow && c.layoutIssueCount === 0 && c.brokenImageCount === 0);
		const summary = captures
			.map(c => `${c.label} (${c.width}x${c.height}): ${c.hasHorizontalOverflow ? 'OVERFLOW' : 'ok'}, ${c.layoutIssueCount} layout issue(s), ${c.brokenImageCount} broken img, ${c.smallTouchTargetCount} small touch target(s)`)
			.join(' | ');

		return {
			url: st.url,
			title: st.title,
			capturedAt: new Date().toISOString(),
			captures,
			allViewportsClean,
			summary,
		};
	}

	async getConsoleMessages(sessionId: string, tabId: string, opts: { level?: 'debug' | 'info' | 'warning' | 'error'; limit?: number }): Promise<ConsoleMessage[]> {
		const session = this.getSession(sessionId);
		const st = this.getPage(session, tabId);
		let msgs = st.consoleMessages.slice();
		if (opts.level) msgs = msgs.filter(m => m.level === opts.level);
		if (opts.limit && opts.limit > 0) msgs = msgs.slice(-opts.limit); // the most recent ones
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
		// Relative URLs resolve against the tab's page, like a link would.
		const absolute = new URL(url, st.page.url() && st.page.url() !== 'about:blank' ? st.page.url() : undefined).toString();
		let filename = path.basename(new URL(absolute).pathname) || 'download';
		const info: DownloadInfo = { downloadId, url: absolute, suggestedFilename: filename, status: 'in_progress' };
		session.downloads.set(downloadId, info);
		// Fetched through the tab's browser context, so the session's cookies apply (was: waited for a download
		// event nothing triggered, so every call failed after 30s).
		try {
			const response = await session.context.request.get(absolute, { timeout: DEFAULT_TIMEOUT_MS });
			if (!response.ok()) { throw new Error(`HTTP ${response.status()} ${response.statusText()}`); }
			const disposition = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(response.headers()['content-disposition'] ?? '');
			if (disposition) { filename = path.basename(decodeURIComponent(disposition[1])); }
			const body: Buffer = await response.body();
			fs.mkdirSync(TEMP_DOWNLOAD_DIR, { recursive: true });
			const filePath = path.join(TEMP_DOWNLOAD_DIR, `${downloadId}_${filename}`);
			fs.writeFileSync(filePath, body);
			Object.assign(info, { suggestedFilename: filename, status: 'completed', path: filePath, sizeBytes: body.length });
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

	// Closes every session. New launches are refused only while that runs: the `browser_shutdown` tool calls this, and
	// it used to leave the flag set for good, so one cleanup call by a model disabled the browser until Kodia restarted
	// (seen in a live run).
	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		try {
			for (const session of Array.from(this.sessions.values())) {
				try { await this.destroySession(session); } catch { }
			}
			this.sessions.clear();
		} finally {
			this.shuttingDown = false;
		}
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
				text: `Uncaught ${err?.name && !String(err?.message).startsWith(err.name) ? `${err.name}: ` : ''}${err?.message ?? String(err)}`,
			});
			if (st.consoleMessages.length > 500) st.consoleMessages.shift();
		});

		// requestfailed only fires for transport errors; a 404 script or a 500 API call is a "successful" request.
		page.on('response', (res: any) => {
			try {
				if (res.status() >= 400) {
					st.networkFailures.push({ id: generateUuid(), timestampMs: now(), url: res.url(), type: res.request().resourceType() || 'other', errorText: `HTTP ${res.status()} ${res.statusText()}`.trim() });
					if (st.networkFailures.length > 200) st.networkFailures.shift();
				}
			} catch { }
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
			page.title().then((t: string) => { st.title = t; }, () => { }); // was assigned the unawaited Promise
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
