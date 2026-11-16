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
	// bounding box in CSS pixels of the viewport, when available
	bbox?: { x: number; y: number; width: number; height: number };
};

export type BrowserPageInfo = {
	url: string;
	title: string;
	text: string; // visible text, collapsed whitespace
	elements: BrowserElement[];
	forms: { selector: string; action?: string; method?: string }[];
	consoleErrors: number; // count of uncaught console errors captured since last inspect
	networkFailures: number;
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
	// absolute file path on disk when completed (may be empty while in progress)
	path?: string;
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
};

export type BrowserScreenshotResult = {
	// data URL (image/png base64) of the captured screenshot
	dataUrl: string;
	width: number;
	height: number;
	type: ScreenshotType;
};

export type BrowserInspectResult = {
	url: string;
	title: string;
	text: string;
	elements: BrowserElement[];
	forms: { selector: string; action?: string; method?: string }[];
	consoleErrors: number;
	networkFailures: number;
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
	clickElement(sessionId: string, tabId: string, selector: string): Promise<void>;
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
