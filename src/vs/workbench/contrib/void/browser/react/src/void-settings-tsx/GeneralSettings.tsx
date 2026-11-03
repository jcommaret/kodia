/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useRef, useState } from 'react';
import { os } from '../../../../common/helpers/systemInfo.js'
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js'
import { VoidButtonBgDarken } from '../util/inputs.js'
import { useAccessor, useIsOptedOut } from '../util/services.js'
import { WarningBox } from './WarningBox.js'
import { IconLoading } from '../sidebar-tsx/SidebarChat.js'
import Severity from '../../../../../../../base/common/severity.js'
import { TransferEditorType } from '../../../extensionTransferTypes.js';
import { OPT_OUT_KEY } from '../../../../common/storageKeys.js';
import { StorageScope, StorageTarget } from '../../../../../../../platform/storage/common/storage.js';
import { AnimatedCheckmarkButton, ConfirmButton, SettingGroup, SettingsSection, SettingSwitch } from './SettingsControls.js'

export const OneClickSwitchButton = ({ fromEditor = 'VS Code', className = '' }: { fromEditor?: TransferEditorType, className?: string }) => {
	const accessor = useAccessor()
	const extensionTransferService = accessor.get('IExtensionTransferService')

	const [transferState, setTransferState] = useState<{ type: 'done', error?: string } | { type: | 'loading' | 'justfinished' }>({ type: 'done' })



	const onClick = async () => {
		if (transferState.type !== 'done') return

		setTransferState({ type: 'loading' })

		const errAcc = await extensionTransferService.transferExtensions(os, fromEditor)

		// Even if some files were missing, consider it a success if no actual errors occurred
		const hadError = !!errAcc
		if (hadError) {
			setTransferState({ type: 'done', error: errAcc })
		}
		else {
			setTransferState({ type: 'justfinished' })
			setTimeout(() => { setTransferState({ type: 'done' }); }, 3000)
		}
	}

	return <>
		<VoidButtonBgDarken className={`max-w-48 p-4 ${className}`} disabled={transferState.type !== 'done'} onClick={onClick}>
			{transferState.type === 'done' ? `Transfer from ${fromEditor}`
				: transferState.type === 'loading' ? <span className='text-nowrap flex flex-nowrap'>Transferring<IconLoading /></span>
					: transferState.type === 'justfinished' ? <AnimatedCheckmarkButton text='Settings Transferred' className='bg-none' />
						: null
			}
		</VoidButtonBgDarken>
		{transferState.type === 'done' && transferState.error ? <WarningBox text={transferState.error} /> : null}
	</>
}

// Kodia's settings or chats, to a JSON file and back
const ImportExport = () => {
	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const chatThreadsService = accessor.get('IChatThreadService')
	const notificationService = accessor.get('INotificationService')

	const fileInputSettingsRef = useRef<HTMLInputElement>(null)
	const fileInputChatsRef = useRef<HTMLInputElement>(null)
	const [inputKey, setInputKey] = useState(0) // a new input after each import, so the same file can be imported again

	const onDownload = (t: 'Chats' | 'Settings') => {
		const dataStr = JSON.stringify(t === 'Chats' ? chatThreadsService.state : voidSettingsService.state, null, 2)
		const blob = new Blob([dataStr], { type: 'application/json' })
		const url = URL.createObjectURL(blob)
		const a = document.createElement('a')
		a.href = url
		a.download = t === 'Chats' ? 'void-chats.json' : 'void-settings.json'
		a.click()
		URL.revokeObjectURL(url)
	}

	const handleUpload = (t: 'Chats' | 'Settings') => (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0]
		if (!file) return

		const reader = new FileReader();
		reader.onload = () => {
			try {
				const json = JSON.parse(reader.result as string);
				if (t === 'Chats') {
					chatThreadsService.dangerousSetState(json as any)
				}
				else {
					voidSettingsService.dangerousSetState(json as any)
				}
				notificationService.info(`${t} imported successfully!`)
			} catch (err) {
				notificationService.notify({ message: `Failed to import ${t}`, source: err + '', severity: Severity.Error, })
			}
		};
		reader.readAsText(file);
		e.target.value = '';
		setInputKey(k => k + 1)
	}

	return <div className='flex gap-8'>
		<div className='flex flex-col gap-2 max-w-48 w-full'>
			<input key={2 * inputKey} ref={fileInputSettingsRef} type='file' accept='.json' className='hidden' onChange={handleUpload('Settings')} />
			<VoidButtonBgDarken className='px-4 py-1 w-full' onClick={() => { fileInputSettingsRef.current?.click() }}>
				Import Settings
			</VoidButtonBgDarken>
			<VoidButtonBgDarken className='px-4 py-1 w-full' onClick={() => onDownload('Settings')}>
				Export Settings
			</VoidButtonBgDarken>
		</div>
		<div className='flex flex-col gap-2 max-w-48 w-full'>
			<input key={2 * inputKey + 1} ref={fileInputChatsRef} type='file' accept='.json' className='hidden' onChange={handleUpload('Chats')} />
			<VoidButtonBgDarken className='px-4 py-1 w-full' onClick={() => { fileInputChatsRef.current?.click() }}>
				Import Chats
			</VoidButtonBgDarken>
			<VoidButtonBgDarken className='px-4 py-1 w-full' onClick={() => onDownload('Chats')}>
				Export Chats
			</VoidButtonBgDarken>
		</div>
	</div>
}

const UsageDataSwitch = () => {
	const accessor = useAccessor()
	const storageService = accessor.get('IStorageService')
	const metricsService = accessor.get('IMetricsService')
	const isOptedOut = useIsOptedOut()
	return <SettingSwitch
		value={!isOptedOut}
		onChange={(share) => {
			storageService.store(OPT_OUT_KEY, !share, StorageScope.APPLICATION, StorageTarget.MACHINE)
			metricsService.capture(`Set metrics opt-out to ${!share}`, {}) // this only fires if it's enabled, so it's fine to have here
		}}
		label='Share anonymous usage data (applies after a restart)'
	/>
}

export const GeneralSection = () => {
	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const environmentService = accessor.get('IEnvironmentService')
	const nativeHostService = accessor.get('INativeHostService')
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const chatThreadsService = accessor.get('IChatThreadService')

	return <SettingsSection title='General'>
		<SettingGroup title='Transfer from another editor' description='Copy your editor settings into Kodia.'>
			<ErrorBoundary>
				<div className='flex flex-col gap-2'>
					<OneClickSwitchButton className='w-48' fromEditor="VS Code" />
					<OneClickSwitchButton className='w-48' fromEditor="Cursor" />
					<OneClickSwitchButton className='w-48' fromEditor="Windsurf" />
				</div>
			</ErrorBoundary>
		</SettingGroup>

		<SettingGroup title='Import and export' description={`Move Kodia's settings and chats in and out of Kodia, as JSON files.`}>
			<ImportExport />
		</SettingGroup>

		<SettingGroup title='Usage data' description='Very basic anonymous usage tracking helps keep Kodia running smoothly. Whatever this setting, Kodia never sees your code, messages, or API keys.'>
			<ErrorBoundary>
				<UsageDataSwitch />
			</ErrorBoundary>
		</SettingGroup>

		<SettingGroup title='Editor settings' description='Settings of the editor itself: preferences, keyboard shortcuts, and theme.'>
			<div className='flex flex-col gap-2 max-w-48 w-full'>
				<VoidButtonBgDarken className='px-4 py-1' onClick={() => { commandService.executeCommand('workbench.action.openSettings') }}>
					Editor Settings
				</VoidButtonBgDarken>
				<VoidButtonBgDarken className='px-4 py-1' onClick={() => { commandService.executeCommand('workbench.action.openGlobalKeybindings') }}>
					Keyboard Shortcuts
				</VoidButtonBgDarken>
				<VoidButtonBgDarken className='px-4 py-1' onClick={() => { commandService.executeCommand('workbench.action.selectTheme') }}>
					Theme
				</VoidButtonBgDarken>
				<VoidButtonBgDarken className='px-4 py-1' onClick={() => { nativeHostService.showItemInFolder(environmentService.logsHome.fsPath) }}>
					Open Logs
				</VoidButtonBgDarken>
			</div>
		</SettingGroup>

		<SettingGroup title='Onboarding'>
			<div className='max-w-48 w-full'>
				<VoidButtonBgDarken className='px-4 py-1 w-full' onClick={() => { voidSettingsService.setGlobalSetting('isOnboardingComplete', false) }}>
					Show Onboarding Again
				</VoidButtonBgDarken>
			</div>
		</SettingGroup>

		<SettingGroup title='Reset' description='Deletes Kodia’s settings or chats on this computer. Export them first to keep a copy.'>
			<div className='flex gap-2'>
				<ConfirmButton className='px-4 py-1' confirmText='Confirm Reset' onConfirm={() => { voidSettingsService.resetState(); }}>
					Reset Settings
				</ConfirmButton>
				<ConfirmButton className='px-4 py-1' confirmText='Confirm Reset' onConfirm={() => { chatThreadsService.resetState(); }}>
					Reset Chats
				</ConfirmButton>
			</div>
		</SettingGroup>
	</SettingsSection>
}
