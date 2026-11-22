/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useState } from 'react';
import { useAccessor, useSettingsState } from '../util/services.js';
import { SearchProviderCard } from './SearchProviderCard.js';
import { WebSearchProviderName, SearchProviderSettings, IWebSearchService } from '../../../../common/webSearchTypes.js';
import { DEFAULT_SEARCH_PROVIDER_SETTINGS, SEARCH_PROVIDER_DISPLAY_INFO, validateNvidiaRerankerSettings, normalizeNvidiaRerankerSettings, getDefaultNvidiaRerankerSettings, validateSearchCacheSettings, normalizeSearchCacheSettings, getDefaultSearchCacheSettings } from '../../../../common/webSearchSettings.js';
import { SettingGroup, SettingSwitch } from './SettingsControls.js';
import { IVoidSettingsService } from '../../../../common/voidSettingsService.js';
import { IMetricsService } from '../../../../common/metricsService.js';
import { INotificationService } from '../../../../../../../platform/notification/common/notification.js';
import Severity from '../../../../../../../base/common/severity.js';
import { VoidSimpleInputBox } from '../util/inputs.js';

const WEB_SEARCH_PROVIDERS: WebSearchProviderName[] = [
	'brave',
	'tavily',
	'exa',
	'you',
	'nvidia',
	'duckduckgo',
];

export const SearchProvidersSettings = () => {
	const accessor = useAccessor();
	const settingsState = useSettingsState();
	const metricsService = accessor.get('IMetricsService');
	const voidSettingsService = accessor.get('IVoidSettingsService');
	const webSearchService = accessor.get('IWebSearchService');
	const notificationService = accessor.get('INotificationService');

	// Safe access to settings with fallbacks
	const globalSettings = settingsState?.globalSettings ?? {};
	const webSearchProviders = globalSettings.webSearchProviders ?? DEFAULT_SEARCH_PROVIDER_SETTINGS;
	const freeOnly = globalSettings.webSearchFreeOnly ?? true;
	// Reranker settings
	const rerankerEnabled = globalSettings.webSearchRerankerEnabled ?? false;
	const rerankerMaxPassages = globalSettings.webSearchRerankerMaxPassages ?? 20;
	// Cache settings
	const cacheEnabled = globalSettings.webSearchCacheEnabled ?? false;
	const cacheTTL = globalSettings.webSearchCacheTTL ?? 3600;

	// Track drag state for drag-and-drop reordering
	const [draggedId, setDraggedId] = useState<WebSearchProviderName | null>(null);
	// Track which provider is currently being tested to prevent duplicate requests
	const [testingProvider, setTestingProvider] = useState<WebSearchProviderName | 'nvidia-reranker' | null>(null);

	const handleDragStart = (e: React.DragEvent, providerName: WebSearchProviderName) => {
		setDraggedId(providerName);
		e.dataTransfer.effectAllowed = 'move';
	};

	const handleDragOver = (e: React.DragEvent) => {
		e.preventDefault();
		e.dataTransfer.dropEffect = 'move';
	};

	const handleDrop = (e: React.DragEvent, targetProvider: WebSearchProviderName) => {
		e.preventDefault();
		if (!draggedId || draggedId === targetProvider) return;

		// Get current providers sorted by priority
		const currentProviders = [...WEB_SEARCH_PROVIDERS].sort(
			(a, b) => webSearchProviders[a].priority - webSearchProviders[b].priority
		);

		const draggedIndex = currentProviders.indexOf(draggedId);
		const targetIndex = currentProviders.indexOf(targetProvider);

		if (draggedIndex === -1 || targetIndex === -1) return;

		// Reorder
		const newProviders = [...currentProviders];
		newProviders.splice(draggedIndex, 1);
		newProviders.splice(targetIndex, 0, draggedId);

		// Update priorities
		const newProvidersSettings = { ...webSearchProviders };
		newProviders.forEach((provider, index) => {
			newProvidersSettings[provider] = {
				...webSearchProviders[provider],
				priority: index,
			};
		});

		// Save updated settings
		voidSettingsService.setGlobalSetting('webSearchProviders', newProvidersSettings);
	};

	const handleSettingsChange = useCallback(async (providerName: WebSearchProviderName, changes: Partial<SearchProviderSettings>) => {
		// Guard against undefined state - fall back to defaults if not yet initialized
		const serviceState = voidSettingsService?.state;
		const serviceGlobalSettings = serviceState?.globalSettings;
		const serviceWebSearchProviders = serviceGlobalSettings?.webSearchProviders ?? DEFAULT_SEARCH_PROVIDER_SETTINGS;

		const currentSettings = serviceWebSearchProviders[providerName];

		const newSettings = {
			...currentSettings,
			...changes,
		};

		// For NVIDIA, don't persist apiKey (it's managed by the NVIDIA LLM provider)
		if (providerName === 'nvidia') {
			delete newSettings.apiKey;
		}

		await voidSettingsService.setSearchProviderSettings(providerName, newSettings);
	}, [voidSettingsService]);

	const handleRerankerSettingsChange = useCallback(async (changes: { webSearchRerankerEnabled?: boolean; webSearchRerankerMaxPassages?: number }) => {
		const validation = validateNvidiaRerankerSettings(changes);
		if (!validation.valid) {
			notificationService.notify({
				message: `Invalid reranker settings: ${validation.errors.join(', ')}`,
				severity: Severity.Error,
			});
			return;
		}

		const normalized = normalizeNvidiaRerankerSettings(changes);

		await voidSettingsService.setGlobalSetting('webSearchRerankerEnabled', normalized.webSearchRerankerEnabled);
		await voidSettingsService.setGlobalSetting('webSearchRerankerMaxPassages', normalized.webSearchRerankerMaxPassages);
	}, [voidSettingsService, notificationService]);

	const handleCacheSettingsChange = useCallback(async (changes: { webSearchCacheEnabled?: boolean; webSearchCacheTTL?: number }) => {
		const validation = validateSearchCacheSettings(changes);
		if (!validation.valid) {
			notificationService.notify({
				message: `Invalid cache settings: ${validation.errors.join(', ')}`,
				severity: Severity.Error,
			});
			return;
		}

		const normalized = normalizeSearchCacheSettings(changes);

		await voidSettingsService.setGlobalSetting('webSearchCacheEnabled', normalized.webSearchCacheEnabled);
		await voidSettingsService.setGlobalSetting('webSearchCacheTTL', normalized.webSearchCacheTTL);
	}, [voidSettingsService, notificationService]);

	const handleTestConnection = useCallback(async (providerName: WebSearchProviderName) => {
		// Prevent duplicate requests
		if (testingProvider !== null) {
			return;
		}

		const providerSettings = webSearchProviders[providerName];
		const displayInfo = SEARCH_PROVIDER_DISPLAY_INFO[providerName];

		// Check if provider is enabled
		if (!providerSettings?.enabled) {
			notificationService.warn(`${displayInfo.title} is disabled. Enable it first to test the connection.`);
			return;
		}

		// For providers that don't require API keys (DuckDuckGo, NVIDIA)
		if (providerName === 'duckduckgo' || providerName === 'nvidia') {
			notificationService.info(`${displayInfo.title} does not require an API key. Connection test skipped.`);
			return;
		}

		// For all providers requiring API keys - test via IWebSearchService.testProviderConnection
		setTestingProvider(providerName);
		metricsService.capture('Web Search Test Connection', { provider: providerName });

		try {
			const result = await webSearchService.testProviderConnection(providerName);

			if (result.success) {
				notificationService.info(`${displayInfo.title} connection successful!`);
			} else {
				notificationService.notify({
					message: result.message,
					source: providerName,
					severity: Severity.Error,
				});
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			notificationService.notify({
				message: `${displayInfo.title} connection failed: ${errorMessage}`,
				source: errorMessage,
				severity: Severity.Error,
			});
		} finally {
			setTestingProvider(null);
		}
		return;
	}, [metricsService, notificationService, webSearchService, webSearchProviders, testingProvider]);

	const handleTestRerankerConnection = useCallback(async () => {
		// Prevent duplicate requests
		if (testingProvider !== null) {
			return;
		}

		setTestingProvider('nvidia-reranker');
		metricsService.capture('Web Search Test Connection', { provider: 'nvidia-reranker' });

		try {
			const result = await webSearchService.testRerankerConnection();

			if (result.success) {
				notificationService.info('NVIDIA reranker connection successful!');
			} else {
				notificationService.notify({
					message: result.message,
					source: 'nvidia-reranker',
					severity: Severity.Error,
				});
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			notificationService.notify({
				message: `NVIDIA reranker connection failed: ${errorMessage}`,
				source: errorMessage,
				severity: Severity.Error,
			});
		} finally {
			setTestingProvider(null);
		}
	}, [metricsService, notificationService, webSearchService, testingProvider]);

	return (
		<SettingGroup title='Web Search Providers' description='Configure search providers for web search and agent tools. Drag to reorder priority.'>
			<div className='mb-4'>
				<SettingSwitch
					value={freeOnly}
					onChange={(newVal) => {
						voidSettingsService.setGlobalSetting('webSearchFreeOnly', newVal);
					}}
					label='Strict free-only mode (zero-spend enforcement)'
					description='When enabled, only providers with verified free access will be used. Local usage counters are estimates only, not authoritative provider balances.'
				/>
			</div>

			<SettingGroup title='NVIDIA Nemotron Reranker' description='Optional post-processing to reorder search results by relevance using NVIDIA Nemotron-3.5-Rerank-8B.'>
				<div className='mb-4'>
					<SettingSwitch
						value={rerankerEnabled}
						onChange={(newVal) => {
							handleRerankerSettingsChange({ webSearchRerankerEnabled: newVal });
						}}
						label='Enable NVIDIA reranking'
						description="When enabled, search queries and selected result snippets are sent to NVIDIA's hosted Nemotron-3.5-Rerank-8B service to reorder results by relevance. This sends your search query and result text to NVIDIA's servers. Disabled by default."
					/>
				</div>

				<div className='mb-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-md text-xs text-void-fg-2'>
					<p className='font-medium mb-1 text-amber-400'>Privacy Notice</p>
					<ul className='list-disc pl-5 space-y-1'>
						<li>This feature sends your search query and selected result snippets to NVIDIA&apos;s hosted reranking API.</li>
						<li>Data is processed on NVIDIA&apos;s servers, not locally.</li>
						<li>NVIDIA&apos;s hosted service terms may allow submitted inputs and outputs to be recorded or used to improve their services.</li>
						<li>Do not enable for confidential, sensitive, or proprietary searches unless you accept NVIDIA&apos;s applicable data-handling terms.</li>
						<li>This feature is opt-in and disabled by default.</li>
					</ul>
				</div>

				<div className='mb-4 flex flex-col gap-1'>
					<label className='text-xs font-medium text-void-fg-2'>Maximum passages to rerank</label>
					<VoidSimpleInputBox
						value={String(rerankerMaxPassages)}
						onChangeValue={(newVal) => {
							const num = parseInt(newVal, 10);
							if (!isNaN(num)) {
								handleRerankerSettingsChange({ webSearchRerankerMaxPassages: num });
							}
						}}
						placeholder='20'
						type='number'
						min={1}
						max={100}
						compact={true}
					/>
					<div className='text-xs text-void-fg-3'>Maximum number of search result passages sent to NVIDIA for reranking per query. Higher values may improve relevance but increase latency and cost. Default: 20.</div>
				</div>

				<div className='mb-4 flex items-center gap-3'>
					<button
						type='button'
						onClick={handleTestRerankerConnection}
						disabled={testingProvider !== null}
						style={{ backgroundColor: 'var(--kodia-accent)', color: 'var(--kodia-accent-fg)' }}
						className='px-3 py-1.5 rounded-md text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-opacity hover:opacity-90'
					>
						{testingProvider === 'nvidia-reranker' ? 'Testing connection…' : 'Test NVIDIA Reranker Connection'}
					</button>
				</div>

				<div className='text-xs text-void-fg-3'>
					<p>Requires an NVIDIA API key configured in the NVIDIA cloud provider settings above. No separate key is needed.</p>
				</div>
			</SettingGroup>

			<SettingGroup title='Search Result Cache' description='Optional in-memory cache for search results to reduce API calls and improve response time for repeated queries.'>
				<div className='mb-4'>
					<SettingSwitch
						value={cacheEnabled}
						onChange={(newVal) => {
							handleCacheSettingsChange({ webSearchCacheEnabled: newVal });
						}}
						label='Enable search result caching'
						description="When enabled, successful search results are cached in memory for faster repeated queries. Cached results are stored in application memory only and expire after the configured TTL. Disabled by default."
					/>
				</div>

				<div className='mb-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-md text-xs text-void-fg-2'>
					<p className='font-medium mb-1 text-amber-400'>Cache Behavior</p>
					<ul className='list-disc pl-5 space-y-1'>
						<li>Only successful search results are cached.</li>
						<li>Cache is stored in application memory only (not persisted to disk).</li>
						<li>Cache is cleared when the application restarts.</li>
						<li>Each provider has its own cache entries.</li>
						<li>Cache entries expire after the configured TTL.</li>
						<li>Reranked results are cached after reranking is applied.</li>
					</ul>
				</div>

				<div className='mb-4 flex flex-col gap-1'>
					<label className='text-xs font-medium text-void-fg-2'>Maximum cache TTL (seconds)</label>
					<VoidSimpleInputBox
						value={String(cacheTTL)}
						onChangeValue={(newVal) => {
							const num = parseInt(newVal, 10);
							if (!isNaN(num)) {
								handleCacheSettingsChange({ webSearchCacheTTL: num });
							}
						}}
						placeholder='3600'
						type='number'
						min={60}
						max={86400}
						compact={true}
					/>
					<div className='text-xs text-void-fg-3'>Time-to-live for cache entries in seconds. Minimum: 60 (1 minute), Maximum: 86400 (24 hours). Default: 3600 (1 hour).</div>
				</div>

				<div className='text-xs text-void-fg-3'>
					<p>Cache is stored in application memory only and is cleared on restart.</p>
					<p>Reranked results are cached after reranking is applied.</p>
				</div>
			</SettingGroup>

			<div className='space-y-4'>
				{WEB_SEARCH_PROVIDERS.map((providerName) => {
					const settings = webSearchProviders[providerName];
					const isTesting = testingProvider === providerName;

					return (
						<SearchProviderCard
							key={providerName}
							providerName={providerName}
							settings={settings}
							onSettingsChange={(name, changes) =>
								handleSettingsChange(name as WebSearchProviderName, changes)
							}
							onTestConnection={() =>
								handleTestConnection(providerName)
							}
							hasExistingKey={!!settings?.apiKey}
							onDragStart={handleDragStart}
							onDragOver={handleDragOver}
							onDrop={(e, target) =>
								handleDrop(e, target as WebSearchProviderName)
							}
							onDragEnd={() => setDraggedId(null)}
							draggedId={draggedId}
							isTesting={isTesting}
						/>
					);
				})}
			</div>
		</SettingGroup>
	);
};