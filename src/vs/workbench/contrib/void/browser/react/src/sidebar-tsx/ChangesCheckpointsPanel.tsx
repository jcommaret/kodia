/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useMemo, useState } from 'react';
import { BookmarkPlus, ChevronDown, ChevronRight, FileCode2, History, RotateCcw, Undo2 } from 'lucide-react';
import { URI } from '../../../../../../../base/common/uri.js';
import { useAccessor, useChatThreadsState, useFullChatThreadsStreamState } from '../util/services.js';
import { CheckpointEntry } from '../../../../common/chatThreadServiceTypes.js';
import { computeUnifiedDiff, FileUnifiedDiff } from '../../../../common/unifiedDiffView.js';

export const ChangesCheckpointsPanel: React.FC = () => {
	const accessor = useAccessor();
	const chatThreadService = accessor.get('IChatThreadService');
	const fileService = accessor.get('IFileService');
	const commandService = accessor.get('ICommandService');
	const notificationService = accessor.get('INotificationService');

	const threadsState = useChatThreadsState();
	const streamStates = useFullChatThreadsStreamState();
	const threadId = threadsState.currentThreadId;
	const thread = threadsState.allThreads[threadId];
	const isRunning = !!streamStates[threadId]?.isRunning;

	const [label, setLabel] = useState('');
	const [busyIdx, setBusyIdx] = useState<number | null>(null);
	const [saving, setSaving] = useState(false);
	const [expandedFile, setExpandedFile] = useState<string | null>(null);
	const [diffOfFile, setDiffOfFile] = useState<Record<string, FileUnifiedDiff | 'loading' | 'none'>>({});
	const [revertingFile, setRevertingFile] = useState<string | null>(null);

	const changedFiles = useMemo(() => {
		if (!thread) { return []; }
		return chatThreadService.getThreadChangedFiles(threadId);
	}, [chatThreadService, threadId, thread?.messages.length]);

	const checkpoints = useMemo(() => {
		if (!thread) { return []; }
		const list: { messageIdx: number; entry: CheckpointEntry; fileCount: number; files: string[] }[] = [];
		for (let i = 0; i < thread.messages.length; i++) {
			const msg = thread.messages[i];
			if (msg.role === 'checkpoint') {
				const files = Object.keys(msg.voidFileSnapshotOfURI ?? {});
				if (msg.label || files.length > 0) {
					list.push({ messageIdx: i, entry: msg, fileCount: files.length, files });
				}
			}
		}
		return list.reverse();
	}, [thread?.messages]);

	const toggleFileDiff = async (fsPath: string) => {
		if (expandedFile === fsPath) {
			setExpandedFile(null);
			return;
		}
		setExpandedFile(fsPath);
		setDiffOfFile(prev => ({ ...prev, [fsPath]: 'loading' }));
		try {
			const initialSnap = chatThreadService.getInitialFileSnapshot(threadId, fsPath);
			const beforeText = initialSnap && !initialSnap.absent && !initialSnap.isFolder ? initialSnap.entireFileCode : '';
			let afterText = '';
			try {
				afterText = (await fileService.readFile(URI.file(fsPath))).value.toString();
			} catch {
				afterText = '';
			}
			const diff = computeUnifiedDiff(beforeText, afterText, 2, 160);
			setDiffOfFile(prev => ({ ...prev, [fsPath]: diff.lines.length > 0 ? diff : 'none' }));
		} catch {
			setDiffOfFile(prev => ({ ...prev, [fsPath]: 'none' }));
		}
	};

	const handleRevertFile = async (fsPath: string) => {
		if (isRunning) {
			notificationService.info('Stop the active agent run before reverting a file.');
			return;
		}
		setRevertingFile(fsPath);
		try {
			const ok = await chatThreadService.revertSingleFile(threadId, fsPath);
			if (ok) {
				notificationService.info(`Reverted ${shortName(fsPath)} to pre-session state.`);
				setDiffOfFile(prev => ({ ...prev, [fsPath]: 'none' }));
			} else {
				notificationService.info(`No restorable pre-edit snapshot found for ${shortName(fsPath)}.`);
			}
		} finally {
			setRevertingFile(null);
		}
	};

	const handleSaveNamedCheckpoint = async (e: React.FormEvent) => {
		e.preventDefault();
		setSaving(true);
		try {
			const idx = await chatThreadService.createNamedCheckpoint(threadId, label || `Milestone ${checkpoints.length + 1}`);
			if (idx >= 0) {
				setLabel('');
				notificationService.info('Saved named checkpoint.');
			}
		} catch (err) {
			notificationService.error(`Could not save checkpoint: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setSaving(false);
		}
	};

	const handleRestore = async (messageIdx: number) => {
		if (isRunning) {
			notificationService.info('Stop the active agent run before restoring a checkpoint.');
			return;
		}
		setBusyIdx(messageIdx);
		try {
			await chatThreadService.restoreCheckpointAtIdx(threadId, messageIdx);
			notificationService.info('Restored files to checkpoint.');
		} catch (err) {
			notificationService.error(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setBusyIdx(null);
		}
	};

	const shortName = (fsPath: string) => fsPath.replace(/\\/g, '/').split('/').slice(-2).join('/');

	return (
		<div className="flex flex-col h-full overflow-y-auto p-3 gap-3 text-xs text-void-fg-1">
			{/* Header & Save Named Checkpoint */}
			<div className="flex flex-col gap-2 border border-void-border-2 rounded bg-void-bg-1 p-2.5">
				<div className="flex items-center justify-between">
					<span className="font-semibold flex items-center gap-1.5">
						<History size={13} />
						Changes & Checkpoints
					</span>
					<span className="text-[10px] text-void-fg-3">
						{changedFiles.length} file{changedFiles.length === 1 ? '' : 's'} · {checkpoints.length} snapshot{checkpoints.length === 1 ? '' : 's'}
					</span>
				</div>
				<form onSubmit={handleSaveNamedCheckpoint} className="flex items-center gap-1.5">
					<input
						type="text"
						value={label}
						onChange={e => setLabel(e.target.value)}
						placeholder="Checkpoint name (e.g. Before auth refactor)"
						className="flex-1 min-w-0 px-2 py-1 rounded bg-void-bg-2 border border-void-border-2 text-void-fg-1 placeholder:text-void-fg-4 outline-none text-[11px]"
					/>
					<button
						type="submit"
						disabled={saving}
						className="flex items-center gap-1 px-2 py-1 rounded bg-[#0e70c0] text-white hover:brightness-110 disabled:opacity-50 whitespace-nowrap text-[11px]"
					>
						<BookmarkPlus size={12} />
						{saving ? 'Saving...' : 'Save'}
					</button>
				</form>
			</div>

			{/* Unified Multi-File Diff Review */}
			<div className="flex flex-col gap-1.5">
				<div className="text-[11px] font-medium text-void-fg-3 uppercase tracking-wide">
					Session Diff Review ({changedFiles.length})
				</div>
				{changedFiles.length === 0 ? (
					<div className="text-void-fg-4 text-[11px] border border-dashed border-void-border-2 rounded p-2.5">
						No files have been modified in this conversation yet. File edits, writes, moves, and deletions appear here with inline diffs and 1-click revert.
					</div>
				) : (
					<div className="flex flex-col gap-1.5">
						{changedFiles.map(fsPath => {
							const isExpanded = expandedFile === fsPath;
							const diffState = diffOfFile[fsPath];
							return (
								<div key={fsPath} className="border border-void-border-2 rounded bg-void-bg-1 overflow-hidden">
									<div className="flex items-center justify-between gap-1.5 px-2 py-1.5 hover:bg-void-bg-3">
										<button
											type="button"
											onClick={() => void toggleFileDiff(fsPath)}
											className="flex items-center gap-1.5 min-w-0 flex-1 text-left"
											title={`Toggle unified diff for ${fsPath}`}
										>
											{isExpanded ? <ChevronDown size={11} className="shrink-0 text-void-fg-3" /> : <ChevronRight size={11} className="shrink-0 text-void-fg-3" />}
											<FileCode2 size={12} className="shrink-0 text-blue-400" />
											<span className="truncate font-mono text-[11px]">{shortName(fsPath)}</span>
											{diffState && typeof diffState === 'object' && (
												<span className="text-[10px] shrink-0 ml-1">
													<span className="text-green-400">+{diffState.added}</span>{' '}
													<span className="text-red-400">-{diffState.removed}</span>
												</span>
											)}
										</button>
										<div className="flex items-center gap-1 shrink-0">
											<button
												type="button"
												onClick={() => commandService.executeCommand('vscode.open', URI.file(fsPath))}
												className="px-1.5 py-0.5 rounded bg-void-bg-2 border border-void-border-2 hover:bg-void-bg-3 text-[10px]"
											>
												Open
											</button>
											<button
												type="button"
												disabled={isRunning || revertingFile === fsPath}
												onClick={() => void handleRevertFile(fsPath)}
												className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-void-bg-2 border border-void-border-2 hover:text-orange-400 text-[10px] disabled:opacity-50"
												title="Revert this file back to its pre-session state"
											>
												<Undo2 size={10} />
												{revertingFile === fsPath ? '...' : 'Revert'}
											</button>
										</div>
									</div>
									{isExpanded && (
										<div className="border-t border-void-border-2 bg-void-bg-2 max-h-60 overflow-auto font-mono text-[10px] leading-4">
											{diffState === 'loading' ? (
												<div className="p-2 text-void-fg-3">Computing diff...</div>
											) : diffState === 'none' || !diffState ? (
												<div className="p-2 text-void-fg-4">No textual differences vs initial session snapshot.</div>
											) : (
												<div>
													{diffState.lines.map((line, idx) => (
														<div
															key={idx}
															className={`px-2 whitespace-pre overflow-x-auto ${line.kind === 'add'
																? 'bg-green-500/15 text-green-300'
																: line.kind === 'del'
																	? 'bg-red-500/15 text-red-300'
																	: 'text-void-fg-3'
																}`}
														>
															<span className="inline-block w-3 select-none opacity-70">
																{line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
															</span>
															{line.text}
														</div>
													))}
													{diffState.truncated && (
														<div className="px-2 py-1 text-void-fg-4 italic">Diff truncated — click Open to inspect full file.</div>
													)}
												</div>
											)}
										</div>
									)}
								</div>
							);
						})}
					</div>
				)}
			</div>

			{/* Checkpoint Timeline */}
			<div className="flex flex-col gap-1.5">
				<div className="text-[11px] font-medium text-void-fg-3 uppercase tracking-wide">
					Checkpoint Timeline ({checkpoints.length})
				</div>
				{checkpoints.length === 0 ? (
					<div className="text-void-fg-4 text-[11px] border border-dashed border-void-border-2 rounded p-2.5">
						Checkpoints are captured automatically before every agent file edit and whenever you save a named checkpoint above.
					</div>
				) : (
					<div className="flex flex-col gap-1.5">
						{checkpoints.map(({ messageIdx, entry, fileCount, files }) => {
							const isActive = thread?.state.currCheckpointIdx === messageIdx;
							const isNamed = !!entry.label;
							return (
								<div
									key={messageIdx}
									className={`border rounded p-2 bg-void-bg-1 flex flex-col gap-1 ${isActive ? 'border-[#0e70c0]' : 'border-void-border-2'}`}
								>
									<div className="flex items-center justify-between gap-2">
										<div className="flex items-center gap-1.5 min-w-0">
											<span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${isNamed ? 'bg-[#0e70c0]/20 text-blue-300' : 'bg-void-bg-2 text-void-fg-3'}`}>
												{isNamed ? 'Named' : entry.type === 'tool_edit' ? 'Auto' : 'Turn'}
											</span>
											<span className="font-medium truncate">
												{entry.label ?? `Snapshot #${messageIdx}`}
											</span>
										</div>
										<button
											type="button"
											disabled={busyIdx !== null || isRunning}
											onClick={() => handleRestore(messageIdx)}
											className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-void-bg-2 border border-void-border-2 hover:bg-void-bg-3 text-[10px] disabled:opacity-50 shrink-0"
											title="Restore workspace files to this checkpoint"
										>
											<RotateCcw size={10} />
											{busyIdx === messageIdx ? 'Restoring...' : 'Restore'}
										</button>
									</div>
									<div className="text-[10px] text-void-fg-3 flex items-center justify-between">
										<span>{fileCount} snapshotted file{fileCount === 1 ? '' : 's'}{files.length > 0 ? `: ${files.slice(0, 2).map(shortName).join(', ')}${files.length > 2 ? '…' : ''}` : ''}</span>
										{entry.createdAt && <span>{new Date(entry.createdAt).toLocaleTimeString()}</span>}
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
};
