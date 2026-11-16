/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useState } from 'react';
import { SearchProviderSettings, WebSearchProviderName } from '../../../../common/webSearchTypes.js';
import { SEARCH_PROVIDER_DISPLAY_INFO } from '../../../../common/webSearchSettings.js';
import { useAccessor } from '../util/services.js';
import { VoidButtonBgDarken, VoidSwitch } from '../util/inputs.js';
import { ChatMarkdownRender } from '../markdown/ChatMarkdownRender.js';
import { GripVertical, Eye, EyeOff } from 'lucide-react';

interface SearchProviderCardProps {
	providerName: WebSearchProviderName;
	settings: SearchProviderSettings;
	onSettingsChange: (providerName: WebSearchProviderName, changes: Partial<SearchProviderSettings>) => void;
	onTestConnection: () => void;
	hasExistingKey: boolean;
	onDragStart: (e: React.DragEvent, providerName: WebSearchProviderName) => void;
	onDragOver: (e: React.DragEvent) => void;
	onDrop: (e: React.DragEvent, targetProvider: WebSearchProviderName) => void;
	onDragEnd: () => void;
	draggedId: WebSearchProviderName | null;
	isTesting?: boolean;
}

export const SearchProviderCard = ({
	providerName,
	settings,
	onSettingsChange,
	onTestConnection,
	hasExistingKey,
	onDragStart,
	onDragOver,
	onDrop,
	onDragEnd,
	draggedId,
	isTesting = false,
}: SearchProviderCardProps) => {
	const displayInfo = SEARCH_PROVIDER_DISPLAY_INFO[providerName];
	const isNvidia = providerName === 'nvidia';
	const isDuckDuckGo = providerName === 'duckduckgo';
	const [showKey, setShowKey] = useState(false);
	const [inputValue, setInputValue] = useState(settings?.apiKey || '');
	const [showWarning, setShowWarning] = useState(false);

	const accessor = useAccessor();
	const metricsService = accessor.get('IMetricsService');
	const voidSettingsService = accessor.get('IVoidSettingsService');

	const formatPriority = (priority: number) => `${priority + 1}`;

	return (
		<div
			draggable={true}
			onDragStart={(e) => onDragStart(e, providerName)}
			onDragOver={onDragOver}
			onDrop={(e) => onDrop(e, providerName)}
			onDragEnd={onDragEnd}
			className={`flex flex-col gap-4 p-4 rounded-lg border border-void-border-2 bg-void-bg-1 ${draggedId === providerName ? 'opacity-50' : ''}`}
		>
			{/* Header: Drag handle + Provider info */}
			<div className='flex items-start gap-4'>
				{/* Drag handle */}
				<div
					className='flex flex-col items-center justify-center text-void-fg-3 cursor-grab shrink-0'
					onMouseDown={(e) => e.preventDefault()}
				>
					<GripVertical className='size-5 text-void-fg-4 hover:text-void-fg-2' />
					<span className='text-xs text-void-fg-4'>{formatPriority(settings?.priority ?? 0)}</span>
				</div>

				{/* Provider info */}
				<div className='flex-1 min-w-0'>
					<div className='flex items-center gap-2'>
						<h4 className='font-medium truncate'>{displayInfo.title}</h4>
						{providerName === 'nvidia' && (
							<span className='text-xs px-2 py-0.5 rounded bg-purple-500/20 text-purple-400'>Reuses NVIDIA LLM key</span>
						)}
						{providerName === 'duckduckgo' && (
							<span className='text-xs px-2 py-0.5 rounded bg-green-500/20 text-green-400'>No API key required</span>
						)}
					</div>
					<div className='text-sm text-void-fg-3 mt-1'>{displayInfo.description}</div>
					<div className='text-xs text-void-fg-4 mt-1'>
						<ChatMarkdownRender string={`[Documentation](${displayInfo.docsUrl})`} chatMessageLocation={undefined} />
					</div>
				</div>
			</div>

			{/* Settings - vertical stack */}
			<div className='space-y-3 pt-2 border-t border-void-border-2'>
				{/* Enable toggle */}
				<div className='flex items-center gap-3'>
					<VoidSwitch
						value={settings?.enabled ?? false}
						onChange={(newVal) => onSettingsChange(providerName, { enabled: newVal })}
						size='sm'
					/>
					<label className='text-sm text-void-fg-3 w-24 shrink-0'>Enabled</label>
					<span className='text-sm text-void-fg-3'>{settings?.enabled ? 'Enabled' : 'Disabled'}</span>
				</div>

				{/* API Key input (not for DDG or NVIDIA) */}
				{!isDuckDuckGo && !isNvidia && (
					<div className='flex items-center gap-3'>
						<label className='text-sm text-void-fg-3 w-24 shrink-0' htmlFor={`apiKey-${providerName}`}>API Key</label>
						<div className='flex-1 min-w-0 flex items-center gap-2'>
							<input
								id={`apiKey-${providerName}`}
								type={showKey ? 'text' : 'password'}
								value={inputValue}
								onChange={(e) => {
									const value = e.target.value;
									setInputValue(value);
									setShowWarning(value.length > 0 && value.length < 10);
								}}
								onBlur={() => {
									if (inputValue !== settings?.apiKey) {
										onSettingsChange(providerName, { apiKey: inputValue });
									}
								}}
								placeholder={settings?.apiKey ? '••••••••' : 'Enter API key'}
								className='flex-1 min-w-0 px-2 py-1 text-sm bg-void-bg-2 border border-void-border-2 rounded focus:border-void-border-1 focus:outline-none'
							/>
							<button
								type='button'
								onClick={() => setShowKey(!showKey)}
								className='text-void-fg-4 hover:text-void-fg-2 shrink-0'
								aria-label={showKey ? 'Hide key' : 'Show key'}
							>
								{showKey ? <Eye size={14} /> : <EyeOff size={14} />}
							</button>
							{showWarning && (
								<span className='text-xs text-yellow-500 shrink-0'>Key seems short</span>
							)}
						</div>
					</div>
				)}

				{/* Max Results */}
				<div className='flex items-center gap-3'>
					<label className='text-sm text-void-fg-3 w-24 shrink-0' htmlFor={`maxResults-${providerName}`}>Max Results</label>
					<input
						id={`maxResults-${providerName}`}
						type='number'
						min='1'
						max='50'
						value={settings?.maxResults ?? 10}
						onChange={(e) => onSettingsChange(providerName, { maxResults: parseInt(e.target.value) || 10 })}
						className='w-24 px-2 py-1 text-sm bg-void-bg-2 border border-void-border-2 rounded focus:border-void-border-1 focus:outline-none'
					/>
				</div>

				{/* Timeout */}
				<div className='flex items-center gap-3'>
					<label className='text-sm text-void-fg-3 w-24 shrink-0' htmlFor={`timeout-${providerName}`}>Timeout (ms)</label>
					<input
						id={`timeout-${providerName}`}
						type='number'
						min='1000'
						max='60000'
						step='1000'
						value={settings?.timeoutMs ?? 15000}
						onChange={(e) => onSettingsChange(providerName, { timeoutMs: parseInt(e.target.value) || 15000 })}
						className='w-28 px-2 py-1 text-sm bg-void-bg-2 border border-void-border-2 rounded focus:border-void-border-1 focus:outline-none'
					/>
				</div>

				{/* Test connection button + Docs link */}
				<div className='flex items-center gap-3'>
					<div className='w-24 shrink-0'></div>
					<VoidButtonBgDarken
						onClick={onTestConnection}
						className='px-3 py-1 text-xs'
						disabled={!(settings?.enabled ?? false) || isTesting}
					>
						{isTesting ? 'Testing...' : 'Test Connection'}
					</VoidButtonBgDarken>
					<a
						href={displayInfo.docsUrl}
						target='_blank'
						rel='noopener noreferrer'
						className='text-xs text-void-fg-4 hover:text-void-fg-2'
					>
						Docs
					</a>
				</div>
			</div>
		</div>
	);
};