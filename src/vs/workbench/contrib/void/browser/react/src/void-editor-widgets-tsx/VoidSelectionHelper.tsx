/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { useAccessor, useIsDark } from '../util/services.js';
import '../styles.css';
import { VOID_CTRL_K_ACTION_ID, VOID_CTRL_L_ACTION_ID } from '../../../actionIDs.js';
import {
	KODIA_EDITOR_DEPENDENCIES_ACTION_ID,
	KODIA_EDITOR_EXPLAIN_ACTION_ID,
	KODIA_EDITOR_FIX_DIAGNOSTICS_ACTION_ID,
	KODIA_EDITOR_GENERATE_TESTS_ACTION_ID,
	KODIA_EDITOR_PERFORMANCE_ACTION_ID,
	KODIA_EDITOR_REFACTOR_ACTION_ID,
	KODIA_EDITOR_SECURITY_REVIEW_ACTION_ID,
} from '../../../kodiaEditorActions.js';
import { ChevronDown, MessageSquarePlus, PencilLine, Settings, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { VoidSelectionHelperProps } from '../../../../../../contrib/void/browser/voidSelectionHelperWidget.js';
import { VOID_OPEN_SETTINGS_ACTION_ID } from '../../../voidSettingsPane.js';

export const VoidSelectionHelperMain = (props: VoidSelectionHelperProps) => {
	const isDark = useIsDark();
	return (
		<div className={`@@void-scope ${isDark ? 'dark' : ''}`}>
			<VoidSelectionHelper {...props} />
		</div>
	);
};

const AI_QUICK_ACTIONS: readonly { id: string; label: string }[] = [
	{ id: KODIA_EDITOR_EXPLAIN_ACTION_ID, label: 'Explain Code' },
	{ id: KODIA_EDITOR_FIX_DIAGNOSTICS_ACTION_ID, label: 'Fix Errors & Diagnostics' },
	{ id: KODIA_EDITOR_GENERATE_TESTS_ACTION_ID, label: 'Generate Tests' },
	{ id: KODIA_EDITOR_REFACTOR_ACTION_ID, label: 'Refactor Selection' },
	{ id: KODIA_EDITOR_SECURITY_REVIEW_ACTION_ID, label: 'Review Security' },
	{ id: KODIA_EDITOR_PERFORMANCE_ACTION_ID, label: 'Analyze Performance' },
	{ id: KODIA_EDITOR_DEPENDENCIES_ACTION_ID, label: 'Explain Dependencies' },
	{ id: 'kodia.predictNextEdit', label: 'Predict Next Edit (Jump)' },
];

const VoidSelectionHelper = ({ rerenderKey }: VoidSelectionHelperProps) => {
	const accessor = useAccessor();
	const keybindingService = accessor.get('IKeybindingService');
	const commandService = accessor.get('ICommandService');

	const ctrlLKeybind = keybindingService.lookupKeybinding(VOID_CTRL_L_ACTION_ID);
	const ctrlKKeybind = keybindingService.lookupKeybinding(VOID_CTRL_K_ACTION_ID);

	const [reactRerenderCount, setReactRerenderKey] = useState(rerenderKey);
	const [clickState, setClickState] = useState<'init' | 'clickedOption' | 'menuOpen'>('init');

	useEffect(() => {
		const disposable = commandService.onWillExecuteCommand(e => {
			if (e.commandId === VOID_CTRL_L_ACTION_ID || e.commandId === VOID_CTRL_K_ACTION_ID || e.commandId.startsWith('kodia.editor.')) {
				setClickState('clickedOption');
			}
		});
		return () => disposable.dispose();
	}, [commandService]);

	if (reactRerenderCount !== rerenderKey) {
		setReactRerenderKey(rerenderKey);
		setClickState('init');
	}

	if (clickState === 'clickedOption') {
		return null;
	}

	const runCmd = (commandId: string) => {
		void commandService.executeCommand(commandId);
		setClickState('clickedOption');
	};

	return (
		<div className='pointer-events-auto select-none z-[1000] relative'>
			<div className='flex items-center flex-nowrap text-nowrap rounded-md shadow-lg border border-void-border-2 bg-void-bg-2/95 backdrop-blur-sm text-[11px] overflow-hidden'>
				{ctrlLKeybind && (
					<button
						type='button'
						onClick={() => runCmd(VOID_CTRL_L_ACTION_ID)}
						className='flex items-center gap-1 px-2.5 py-1.5 text-void-fg-1 hover:bg-void-bg-1 transition-colors cursor-pointer'
						title='Add selection to Kodia Chat'
					>
						<MessageSquarePlus size={12} className='opacity-80' />
						<span>Chat</span>
						<kbd className='ml-0.5 px-1 py-0.5 text-[10px] rounded bg-[var(--vscode-keybindingLabel-background)] text-[var(--vscode-keybindingLabel-foreground)] border border-[var(--vscode-keybindingLabel-border)]'>
							{ctrlLKeybind.getLabel()}
						</kbd>
					</button>
				)}

				{ctrlLKeybind && ctrlKKeybind && <div className='w-px h-4 bg-void-border-3' />}

				{ctrlKKeybind && (
					<button
						type='button'
						onClick={() => runCmd(VOID_CTRL_K_ACTION_ID)}
						className='flex items-center gap-1 px-2.5 py-1.5 text-void-fg-1 hover:bg-void-bg-1 transition-colors cursor-pointer'
						title='Edit selection inline with Kodia'
					>
						<PencilLine size={12} className='opacity-80' />
						<span>Edit</span>
						<kbd className='ml-0.5 px-1 py-0.5 text-[10px] rounded bg-[var(--vscode-keybindingLabel-background)] text-[var(--vscode-keybindingLabel-foreground)] border border-[var(--vscode-keybindingLabel-border)]'>
							{ctrlKKeybind.getLabel()}
						</kbd>
					</button>
				)}

				<div className='w-px h-4 bg-void-border-3' />

				<button
					type='button'
					onClick={() => setClickState(s => s === 'menuOpen' ? 'init' : 'menuOpen')}
					className={`flex items-center gap-1 px-2.5 py-1.5 transition-colors cursor-pointer ${clickState === 'menuOpen' ? 'bg-void-bg-1 text-void-fg-1' : 'text-void-fg-2 hover:bg-void-bg-1 hover:text-void-fg-1'}`}
					title='Kodia AI Actions for this selection'
				>
					<Sparkles size={12} className='text-blue-400' />
					<span>AI Actions</span>
					<ChevronDown size={11} className={`transition-transform ${clickState === 'menuOpen' ? 'rotate-180' : ''}`} />
				</button>
			</div>

			{clickState === 'menuOpen' && (
				<div className='mt-1 w-52 rounded-md shadow-xl border border-void-border-2 bg-void-bg-2 py-1 text-[11px] flex flex-col'>
					{AI_QUICK_ACTIONS.map(action => (
						<button
							key={action.id}
							type='button'
							onClick={() => runCmd(action.id)}
							className='w-full text-left px-3 py-1.5 text-void-fg-1 hover:bg-void-bg-1 transition-colors cursor-pointer'
						>
							{action.label}
						</button>
					))}
					<div className='my-1 border-t border-void-border-3' />
					<button
						type='button'
						onClick={() => runCmd(VOID_OPEN_SETTINGS_ACTION_ID)}
						className='w-full text-left px-3 py-1.5 text-void-fg-3 hover:text-void-fg-1 hover:bg-void-bg-1 flex items-center gap-1.5 transition-colors cursor-pointer'
					>
						<Settings size={11} />
						<span>Configure Selection Bar…</span>
					</button>
				</div>
			)}
		</div>
	);
};
