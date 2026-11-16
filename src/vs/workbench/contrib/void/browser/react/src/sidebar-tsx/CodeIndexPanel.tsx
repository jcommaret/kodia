/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useState } from 'react';

import { ProxyChannel } from '../../../../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../../../../platform/ipc/common/mainProcessService.js';
import { ICodeIndexService, SearchResult } from '../../../common/codeIndexServiceTypes.js';
import { useAccessor } from '../util/services.js';

export const CodeIndexPanel = () => {
	const accessor = useAccessor()
	const mainProcessService = accessor.get('IMainProcessService')
	const codeIndexService = ProxyChannel.toService<ICodeIndexService>(mainProcessService.getChannel('void-channel-code-index'))

	const [indexing, setIndexing] = useState(false)
	const [indexStats, setIndexStats] = useState<{ totalFiles: number, totalChunks: number, lastIndexed: number | null } | null>(null)
	const [searchResults, setSearchResults] = useState<SearchResult[]>([])
	const [searchQuery, setSearchQuery] = useState('')
	const [searchType, setSearchType] = useState<'semantic' | 'keyword' | 'hybrid'>('semantic')
	const [searching, setSearching] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const refreshStats = useCallback(async () => {
		if (!codeIndexService) return
		try {
			const stats = await codeIndexService.getStats()
			setIndexStats(stats)
		} catch (e) {
			console.error('Failed to get index stats:', e)
		}
	}, [codeIndexService])

	useEffect(() => {
		refreshStats()
	}, [refreshStats])

	const handleIndex = async () => {
		if (!codeIndexService) {
			setError('Code index service not available. Please reload Kodia.')
			return
		}
		setIndexing(true)
		setError(null)
		try {
			await codeIndexService.indexWorkspace()
			await refreshStats()
		} catch (e: any) {
			setError(`Indexing failed: ${e?.message ?? String(e)}`)
		} finally {
			setIndexing(false)
		}
	}

	const handleSearch = async () => {
		if (!searchQuery.trim()) return
		if (!codeIndexService) {
			setError('Code index service not available')
			return
		}
		setSearching(true)
		setError(null)
		try {
			let results: SearchResult[]
			if (searchType === 'semantic') {
				results = await codeIndexService.semanticSearch(searchQuery, 10)
			} else if (searchType === 'keyword') {
				results = await codeIndexService.keywordSearch(searchQuery, 10)
			} else {
				results = await codeIndexService.hybridSearch(searchQuery, 10)
			}
			setSearchResults(results)
		} catch (e: any) {
			setError(`Search failed: ${e?.message ?? String(e)}`)
		} finally {
			setSearching(false)
		}
	}

	const handleClear = () => {
		setSearchResults([])
		setSearchQuery('')
		setError(null)
	}

	return (
		<div className='p-3 space-y-3 min-w-0'>
			<div className='flex items-center gap-2 mb-2'>
				<h2 className='text-xs font-semibold text-void-fg-1'>🔍 Code Index</h2>
				{indexing && <span className='text-[10px] text-void-fg-3 animate-pulse'>Indexing...</span>}
			</div>

			{indexStats && (
				<div className='flex flex-wrap gap-2 text-[10px] text-void-fg-3 bg-void-bg-2 p-2 rounded border border-void-border-2/50'>
					<span className='flex-1'>📁 Files: {indexStats.totalFiles}</span>
					<span className='flex-1'>🧩 Chunks: {indexStats.totalChunks}</span>
					<span className='flex-1'>{indexStats.lastIndexed ? `Last: ${new Date(indexStats.lastIndexed).toLocaleTimeString()}` : 'Never'}</span>
				</div>
			)}

			<div className='flex flex-wrap gap-2'>
				<button
					onClick={handleIndex}
					disabled={indexing}
					className='flex-1 min-w-[55px] px-2 py-1.5 text-xs rounded border border-void-border-2 bg-void-bg-2 text-void-fg-1 hover:bg-void-bg-3 disabled:opacity-50 whitespace-nowrap'
				>
					{indexing ? 'Indexing...' : 'Index Codebase'}
				</button>
				<button
					onClick={refreshStats}
					disabled={indexing}
					className='min-w-[50px] px-2 py-1.5 text-xs rounded border border-void-border-2 bg-void-bg-2 text-void-fg-1 hover:bg-void-bg-3 disabled:opacity-50 whitespace-nowrap'
				>
					Refresh
				</button>
			</div>

			<div className='flex flex-wrap gap-1.5'>
				<select
					value={searchType}
					onChange={e => setSearchType(e.target.value as any)}
					className='text-xs border border-void-border-2 bg-void-bg-2 p-1 rounded text-void-fg-1 min-w-[55px]'
				>
					<option value='semantic'>Semantic</option>
					<option value='keyword'>Keyword</option>
					<option value='hybrid'>Hybrid</option>
				</select>
				<input
					type='text'
					placeholder='Search code...'
					value={searchQuery}
					onChange={e => setSearchQuery(e.target.value)}
					onKeyDown={e => e.key === 'Enter' && handleSearch()}
					className='flex-1 min-w-[80px] text-xs border border-void-border-2 bg-void-bg-2 p-1 rounded text-void-fg-1 placeholder-void-fg-4'
				/>
				<button
					onClick={handleSearch}
					disabled={searching || !searchQuery.trim()}
					className='min-w-[45px] px-2 py-1.5 text-[10px] rounded border border-void-border-2 bg-void-bg-2 text-void-fg-1 hover:bg-void-bg-3 disabled:opacity-50 whitespace-nowrap'
				>
					{searching ? 'Searching...' : 'Search'}
				</button>
				<button
					onClick={handleClear}
					className='min-w-[40px] px-2 py-1.5 text-[10px] rounded border border-void-border-2 bg-void-bg-2 text-void-fg-3 hover:bg-void-bg-3 whitespace-nowrap'
				>
					Clear
				</button>
			</div>

			{error && (
				<div className='text-[10px] text-red-500 bg-red-500/10 p-2 rounded border border-red-500/30 break-words'>
					{error}
				</div>
			)}

			{searchResults.length > 0 && (
				<div className='space-y-1 max-h-[200px] overflow-y-auto'>
					{searchResults.map((r, i) => (
						<div key={i} className='p-1.5 border border-void-border-2 bg-void-bg-1 rounded text-[9px]'>
							<div className='flex items-center gap-1 mb-0.5'>
								<span className='text-[9px] font-semibold text-void-fg-3 uppercase'>{r.kind}</span>
								<span className='text-[9px] text-void-fg-3 truncate'>{r.filePath.split('/').pop()}</span>
								<span className='text-[9px] text-void-fg-4'>:${r.startLine}</span>
								<span className='ml-auto text-[9px] text-void-fg-3'>score: ${(r.score * 100).toFixed(0)}%</span>
							</div>
							<div className='text-void-fg-2 font-medium truncate'>{r.name}</div>
							<div className='text-[9px] text-void-fg-3 mt-0.5 truncate'>{r.content.replace(/\n/g, ' ')}</div>
						</div>
					))}
				</div>
			)}

			{searchResults.length === 0 && searchQuery && !searching && (
				<div className='text-[10px] text-void-fg-3 italic'>No results found.</div>
			)}
		</div>
	)
}
