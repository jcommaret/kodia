/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

// ---------------------------------------------------------------------------
// Browser automation service types
//
// This service lives in the Electron main process (it spawns a real Chromium
// process through Playwright) and is exposed to the renderer/workbench through
// an IPC channel. All data that crosses the channel must be JSON-serializable.
// ---------------------------------------------------------------------------

export type BrowserEngine = 'chromium';

export type ScreenshotType = 'viewport' | 'fullpage' | 'element';

export type ConsoleLevel = 'debug' | 'info' | 'warning' | 'error';

export type BrowserTabInfo = {
	tabId: string;
	url: string;
	title: string;
	isActive: boolean;
	loading: boolean;
	loadError?: string;
};

export type BrowserSessionInfo = {
	sessionId: string;
	engine: BrowserEngine;
	headless: boolean;
	tabCount: number;
	createdAt: number;
};

// An interactive element discovered on a page. The selector can be passed back
// to click / fill / check / select / screenshot to act on that element.
export type BrowserElement = {
	selector: string;
	type: 'button' | 'link' | 'input' | 'textarea' | 'select' | 'checkbox' | 'radio' | 'menu' | 'other';
	label: string;
	value?: string;
	placeholder?: string;
	disabled: boolean;
	readonly: boolean;
	checked?: boolean;
	options?: string[]; // for <select>
	// rendered (not display:none / visibility:hidden / opacity:0, and has a size)
	visible: boolean;
	// visible and at least partly inside the current viewport
	inViewport: boolean;
	// bounding box in CSS pixels of the viewport, when available
	bbox?: { x: number; y: number; width: number; height: number };
};

// A layout defect a user would see, found by measuring the rendered page (not by looking at a screenshot).
export type BrowserLayoutIssue = {
	kind: 'horizontal-overflow' | 'covered' | 'offscreen' | 'clipped-text';
	selector: string;
	detail: string;
};

// What the in-page inspection script returns.
export type BrowserPageInfo = {
	url: string;
	title: string;
	text: string; // visible text, collapsed whitespace
	elements: BrowserElement[];
	totalElements: number; // interactive elements on the page (elements may be capped)
	forms: { selector: string; action?: string; method?: string }[];
	viewport: BrowserViewport;
	layoutIssues: BrowserLayoutIssue[];
};

export type ConsoleMessage = {
	id: string;
	timestampMs: number;
	level: ConsoleLevel;
	text: string;
	source?: { url: string; line: number; column: number };
};

export type NetworkFailure = {
	id: string;
	timestampMs: number;
	url: string;
	type: string; // e.g. 'XMLHttpRequest', 'fetch', 'Script', 'Image', ...
	// short failure description (e.g. 'net::ERR_CONNECTION_REFUSED')
	errorText: string;
};

export type DownloadInfo = {
	downloadId: string;
	url: string;
	suggestedFilename: string;
	status: 'in_progress' | 'completed' | 'failed' | 'cancelled';
	// absolute file path on disk, only once completed
	path?: string;
	sizeBytes?: number;
	failureText?: string;
};

export type BrowserLaunchResult = {
	sessionId: string;
	engine: BrowserEngine;
	headless: boolean;
	version: string;
};

export type BrowserViewport = {
	width: number;
	height: number;
};

export type BrowserTabResult = {
	tabId: string;
	url: string;
	title: string;
	// HTTP status of the main document, when one was loaded over HTTP(S)
	status?: number;
	// set when the page failed to load or answered with HTTP >= 400
	loadError?: string;
	// click / submit only: whether the action navigated to a new document
	navigated?: boolean;
};

export type BrowserScreenshotResult = {
	// data URL (image/png base64) of the captured screenshot
	dataUrl: string;
	width: number;
	height: number;
	type: ScreenshotType;
	// the PNG on disk
	path: string;
};

export type BrowserInspectResult = {
	url: string;
	title: string;
	status?: number;
	loadError?: string;
	text: string;
	elements: BrowserElement[];
	totalElements: number;
	forms: { selector: string; action?: string; method?: string }[];
	viewport: BrowserViewport;
	layoutIssues: BrowserLayoutIssue[];
	consoleErrors: number; // errors captured since the current document started loading
	recentConsoleErrors: string[];
	networkFailures: number;
	recentNetworkFailures: string[];
};

export interface IBrowserService {
	readonly _serviceBrand: undefined;

	// --- lifecycle ---
	launchBrowser(opts: { headless?: boolean; viewport?: { width: number; height: number } }): Promise<BrowserLaunchResult>;
	closeBrowser(sessionId: string): Promise<void>;
	listSessions(): Promise<BrowserSessionInfo[]>;

	// --- tabs ---
	newTab(sessionId: string, opts: { url?: string }): Promise<BrowserTabResult>;
	listTabs(sessionId: string): Promise<BrowserTabInfo[]>;
	switchTab(sessionId: string, tabId: string): Promise<BrowserTabResult>;
	closeTab(sessionId: string, tabId: string): Promise<void>;

	// --- navigation ---
	navigate(sessionId: string, tabId: string, url: string): Promise<BrowserTabResult>;
	goBack(sessionId: string, tabId: string): Promise<BrowserTabResult>;
	goForward(sessionId: string, tabId: string): Promise<BrowserTabResult>;
	reload(sessionId: string, tabId: string): Promise<BrowserTabResult>;

	// --- page inspection ---
	inspectPage(sessionId: string, tabId: string): Promise<BrowserInspectResult>;

	// --- element interaction ---
	clickElement(sessionId: string, tabId: string, selector: string): Promise<BrowserTabResult>;
	fillElement(sessionId: string, tabId: string, selector: string, text: string): Promise<void>;
	selectOption(sessionId: string, tabId: string, selector: string, value: string): Promise<void>;
	checkElement(sessionId: string, tabId: string, selector: string, checked: boolean): Promise<void>;
	submitForm(sessionId: string, tabId: string, selector: string): Promise<BrowserTabResult>;

	// --- waiting ---
	waitForElement(sessionId: string, tabId: string, selector: string, opts: { timeoutMs?: number }): Promise<{ found: boolean }>;
	setViewport(sessionId: string, tabId: string, viewport: { width: number; height: number }): Promise<void>;

	// --- screenshots ---
	takeScreenshot(sessionId: string, tabId: string, opts: { type?: ScreenshotType; selector?: string }): Promise<BrowserScreenshotResult>;

	// --- console / network ---
	getConsoleMessages(sessionId: string, tabId: string, opts: { level?: ConsoleLevel; limit?: number }): Promise<ConsoleMessage[]>;
	getNetworkFailures(sessionId: string, tabId: string): Promise<NetworkFailure[]>;

	// --- downloads ---
	startDownload(sessionId: string, tabId: string, url: string): Promise<DownloadInfo>;
	listDownloads(sessionId: string): Promise<DownloadInfo[]>;

	// --- lifecycle control ---
	abortSession(sessionId: string): Promise<void>;
	shutdown(): Promise<void>;
}

export const IBrowserService = createDecorator<IBrowserService>('browserService');
