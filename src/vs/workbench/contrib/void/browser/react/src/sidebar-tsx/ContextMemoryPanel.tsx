/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useState } from 'react';
import { BookOpen, RefreshCw, Save, Terminal, Webhook, Sparkles, Check } from 'lucide-react';
import { useAccessor } from '../util/services.js';
import { CustomSlashCommand } from '../../../../common/customCommands.js';
import { KodiaHookDefinition, KodiaHookExecutionEntry } from '../../../../common/kodiaHooks.js';
import { PROJECT_MEMORY_FILE_PATH } from '../../../../common/projectMemoryService.js';
import { estimateTokens } from '../../../../common/tokenizer.js';
import { CancellationToken } from '../../../../../../../base/common/cancellation.js';

export const ContextMemoryPanel = () => {
	const accessor = useAccessor();
	const projectMemoryService = accessor.get('IProjectMemoryService');
	const customCommandsService = accessor.get('ICustomCommandsService');
	const hooksService = accessor.get('IKodiaHooksMainService');
	const promptsService = accessor.get('IPromptsService');
	const workspaceContextService = accessor.get('IWorkspaceContextService');

	const [section, setSection] = useState<'memory' | 'commands' | 'hooks' | 'skills'>('memory');
	const [memoryDraft, setMemoryDraft] = useState<string>('');
	const [memoryDirty, setMemoryDirty] = useState(false);
	const [savedFlash, setSavedFlash] = useState(false);
	const [commands, setCommands] = useState<readonly CustomSlashCommand[]>([]);
	const [hooks, setHooks] = useState<KodiaHookDefinition[]>([]);
	const [hookAudit, setHookAudit] = useState<KodiaHookExecutionEntry[]>([]);
	const [skills, setSkills] = useState<{ name: string; description: string }[]>([]);
	const [refreshing, setRefreshing] = useState(false);

	const loadAll = useCallback(async () => {
		setRefreshing(true);
		try {
			await projectMemoryService.whenReady;
			const mem = projectMemoryService.getMemory();
			setMemoryDraft(mem);
			setMemoryDirty(false);

			const cmds = await customCommandsService.listCommands();
			setCommands(cmds);

			const folders = workspaceContextService.getWorkspace().folders.map(f => f.uri.fsPath);
			if (hooksService && folders.length > 0) {
				const [cfgHooks, audit] = await Promise.all([
					hooksService.listConfiguredHooks(folders),
					hooksService.getAuditLog(20),
				]);
				setHooks(cfgHooks);
				setHookAudit([...audit].reverse());
			}

			try {
				const foundSkills = await promptsService.findAgentSkills(CancellationToken.None);
				setSkills((foundSkills ?? []).map(s => ({ name: s.name, description: s.description ?? '' })));
			} catch {
				setSkills([]);
			}
		} finally {
			setRefreshing(false);
		}
	}, [projectMemoryService, customCommandsService, hooksService, promptsService, workspaceContextService]);

	useEffect(() => {
		void loadAll();
		const d = projectMemoryService.onDidChange(() => {
			if (!memoryDirty) {
				setMemoryDraft(projectMemoryService.getMemory());
			}
		});
		return () => d.dispose();
	}, [loadAll, projectMemoryService, memoryDirty]);

	const handleSaveMemory = async () => {
		await projectMemoryService.setMemory(memoryDraft);
		setMemoryDirty(false);
		setSavedFlash(true);
		setTimeout(() => setSavedFlash(false), 1800);
	};

	const memoryTokens = estimateTokens(memoryDraft);

	return (
		<div className='p-3 space-y-3 h-full overflow-y-auto text-void-fg-1'>
			<div className='flex items-center justify-between'>
				<div className='flex items-center gap-1.5'>
					<BookOpen size={14} className='text-void-fg-2' />
					<h2 className='text-xs font-semibold'>Project Context & Extensibility</h2>
				</div>
				<button
					type='button'
					onClick={() => void loadAll()}
					disabled={refreshing}
					title='Refresh context, commands, skills, and hooks'
					className='p-1 rounded hover:bg-void-bg-3 text-void-fg-3 hover:text-void-fg-1'
				>
					<RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
				</button>
			</div>

			{/* Sub-tabs */}
			<div className='flex flex-wrap gap-1 text-[11px]'>
				{([
					['memory', 'Memory'],
					['commands', `Commands (${commands.length})`],
					['hooks', `Hooks (${hooks.length})`],
					['skills', `Skills (${skills.length})`],
				] as const).map(([key, label]) => (
					<button
						key={key}
						type='button'
						onClick={() => setSection(key)}
						className={`px-2 py-0.5 rounded border transition-colors ${section === key
							? 'bg-void-bg-3 border-void-border-1 text-void-fg-1 font-medium'
							: 'bg-void-bg-1 border-void-border-2 text-void-fg-3 hover:text-void-fg-1'
							}`}
					>
						{label}
					</button>
				))}
			</div>

			{section === 'memory' && (
				<div className='space-y-2'>
					<div className='flex items-center justify-between text-[11px] text-void-fg-3'>
						<span className='font-mono truncate'>{PROJECT_MEMORY_FILE_PATH}</span>
						<span>~{memoryTokens} tokens</span>
					</div>
					<textarea
						value={memoryDraft}
						onChange={e => { setMemoryDraft(e.target.value); setMemoryDirty(true); }}
						placeholder={'## Architecture\nProject notes kept across Kodia sessions...'}
						rows={14}
						className='w-full p-2 text-xs font-mono rounded bg-void-bg-1 border border-void-border-2 text-void-fg-1 focus:outline-none focus:border-void-border-1 resize-y'
					/>
					<div className='flex items-center justify-between'>
						<span className='text-[10px] text-void-fg-4'>
							Loaded automatically into system prompts (budgeted to 15% of model window).
						</span>
						<button
							type='button'
							disabled={!memoryDirty}
							onClick={() => void handleSaveMemory()}
							className='flex items-center gap-1 px-2.5 py-1 text-xs rounded bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)] disabled:opacity-40'
						>
							{savedFlash ? <><Check size={12} /> Saved</> : <><Save size={12} /> Save</>}
						</button>
					</div>
				</div>
			)}

			{section === 'commands' && (
				<div className='space-y-1.5'>
					<div className='text-[11px] text-void-fg-3'>
						Custom slash commands discovered in <code className='px-1 bg-void-bg-3 rounded'>.kodia/commands/*.md</code> and <code className='px-1 bg-void-bg-3 rounded'>.claude/commands/*.md</code>. Type <code className='px-1 bg-void-bg-3 rounded'>/name</code> in Chat to run.
					</div>
					{commands.length === 0 ? (
						<div className='bg-void-bg-1 border border-void-border-2 rounded p-3 text-center text-xs text-void-fg-3'>
							No custom commands found in this workspace yet.
						</div>
					) : (
						commands.map(cmd => (
							<div key={cmd.name} className='bg-void-bg-1 border border-void-border-2 rounded p-2 space-y-0.5'>
								<div className='flex items-center justify-between'>
									<span className='text-xs font-mono font-medium flex items-center gap-1'>
										<Terminal size={11} className='text-blue-400' /> /{cmd.name}
										{cmd.argumentHint && <span className='text-void-fg-4 font-normal'>{cmd.argumentHint}</span>}
									</span>
									<span className='text-[9px] text-void-fg-4 uppercase'>{cmd.scope}</span>
								</div>
								<div className='text-[11px] text-void-fg-3'>{cmd.description}</div>
							</div>
						))
					)}
				</div>
			)}

			{section === 'hooks' && (
				<div className='space-y-2.5'>
					<div className='text-[11px] text-void-fg-3'>
						Lifecycle hooks configured in <code className='px-1 bg-void-bg-3 rounded'>.kodia/hooks.json</code> or <code className='px-1 bg-void-bg-3 rounded'>.claude/settings.json</code>.
					</div>
					{hooks.length === 0 ? (
						<div className='bg-void-bg-1 border border-void-border-2 rounded p-3 text-center text-xs text-void-fg-3'>
							No lifecycle hooks configured.
						</div>
					) : (
						<div className='space-y-1.5'>
							{hooks.map((h, i) => (
								<div key={`${h.event}-${i}`} className='bg-void-bg-1 border border-void-border-2 rounded p-2 space-y-0.5'>
									<div className='flex items-center justify-between'>
										<span className='text-xs font-medium flex items-center gap-1'>
											<Webhook size={11} className='text-amber-400' /> {h.event}
											{h.matcher && <code className='text-[10px] px-1 bg-void-bg-3 rounded text-void-fg-2'>{h.matcher}</code>}
										</span>
										<span className='text-[10px] text-void-fg-4'>{h.timeoutMs}ms</span>
									</div>
									<div className='text-[10px] font-mono text-void-fg-3 truncate' title={h.command}>{h.command}</div>
								</div>
							))}
						</div>
					)}

					{hookAudit.length > 0 && (
						<div className='space-y-1 pt-2 border-t border-void-border-2'>
							<div className='text-[11px] font-medium text-void-fg-2'>Recent Hook Executions</div>
							{hookAudit.map((entry, idx) => (
								<div key={idx} className='bg-void-bg-1 border border-void-border-2 rounded p-1.5 text-[10px] space-y-0.5'>
									<div className='flex justify-between'>
										<span className='font-medium'>{entry.event} → <span className={entry.decision === 'block' ? 'text-red-400' : 'text-green-400'}>{entry.decision}</span></span>
										<span className='text-void-fg-4 font-mono'>{entry.durationMs}ms (exit {entry.exitCode ?? '?'})</span>
									</div>
									{entry.reason && <div className='text-void-fg-3'>{entry.reason}</div>}
									{entry.error && <div className='text-red-400'>{entry.error}</div>}
								</div>
							))}
						</div>
					)}
				</div>
			)}

			{section === 'skills' && (
				<div className='space-y-1.5'>
					<div className='text-[11px] text-void-fg-3'>
						Skills discovered in <code className='px-1 bg-void-bg-3 rounded'>.kodia/skills</code>, <code className='px-1 bg-void-bg-3 rounded'>.agents/skills</code>, and <code className='px-1 bg-void-bg-3 rounded'>.claude/skills</code>.
					</div>
					{skills.length === 0 ? (
						<div className='bg-void-bg-1 border border-void-border-2 rounded p-3 text-center text-xs text-void-fg-3'>
							No skills found in this workspace.
						</div>
					) : (
						skills.map(skill => (
							<div key={skill.name} className='bg-void-bg-1 border border-void-border-2 rounded p-2 space-y-0.5'>
								<div className='text-xs font-medium flex items-center gap-1'>
									<Sparkles size={11} className='text-purple-400' /> {skill.name}
								</div>
								<div className='text-[11px] text-void-fg-3'>{skill.description}</div>
							</div>
						))
					)}
				</div>
			)}
		</div>
	);
};
