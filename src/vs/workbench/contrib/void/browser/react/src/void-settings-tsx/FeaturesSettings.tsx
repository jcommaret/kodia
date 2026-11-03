/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useMemo } from 'react';
import { displayInfoOfFeatureName, FeatureName } from '../../../../common/voidSettingsTypes.js'
import { os } from '../../../../common/helpers/systemInfo.js'
import { VoidCustomDropdownBox } from '../util/inputs.js'
import { useAccessor, useSettingsState } from '../util/services.js'
import { ModelDropdown } from './ModelDropdown.js'
import { GlobalSettingSwitch, SettingGroup, SettingsSection } from './SettingsControls.js'

const dropdownClassName = 'text-xs text-void-fg-3 bg-void-bg-1 border border-void-border-1 rounded p-0.5 px-1'

const FastApplyMethodDropdown = () => {
	const accessor = useAccessor()
	const voidSettingsService = accessor.get('IVoidSettingsService')
	const enableFastApply = useSettingsState().globalSettings.enableFastApply

	const options = useMemo(() => [true, false], [])

	const onChangeOption = useCallback((newVal: boolean) => {
		voidSettingsService.setGlobalSetting('enableFastApply', newVal)
	}, [voidSettingsService])

	return <VoidCustomDropdownBox
		className={dropdownClassName}
		options={options}
		selectedOption={enableFastApply}
		onChangeOption={onChangeOption}
		getOptionDisplayName={(val) => val ? 'Fast Apply' : 'Slow Apply'}
		getOptionDropdownName={(val) => val ? 'Fast Apply' : 'Slow Apply'}
		getOptionDropdownDetail={(val) => val ? 'Output Search/Replace blocks' : 'Rewrite whole files'}
		getOptionsEqual={(a, b) => a === b}
	/>

}

// A setting's name and its control, on one line
const LabeledControl = ({ label, children }: { label: string, children: React.ReactNode }) => {
	return <div className='flex items-center gap-x-2'>
		<span className='text-root text-void-fg-2'>{label}</span>
		{children}
	</div>
}

const FeatureModel = ({ featureName }: { featureName: FeatureName }) => {
	return <LabeledControl label='Model'>
		<ModelDropdown featureName={featureName} className={dropdownClassName} />
	</LabeledControl>
}

export const FeaturesSection = () => {
	const { syncApplyToChat, syncSCMToChat, enableAutocomplete } = useSettingsState().globalSettings
	return <SettingsSection title='Features' description={`Kodia's AI features, and the model each one uses.`}>
		<SettingGroup title='Chat' description='Ask questions, or let the agent work on your code. You can also change the model from the chat.'>
			<FeatureModel featureName='Chat' />
		</SettingGroup>

		<SettingGroup title={displayInfoOfFeatureName('Ctrl+K')} description={`Edits the selected code in place (${os === 'mac' ? '⌘K' : 'Ctrl+K'}).`}>
			<FeatureModel featureName='Ctrl+K' />
		</SettingGroup>

		<SettingGroup title='Apply' description={`Writes the code of a chat answer into your files.`}>
			<GlobalSettingSwitch settingName='syncApplyToChat' label='Use the Chat model' />
			{!syncApplyToChat && <FeatureModel featureName='Apply' />}
			<LabeledControl label='Method'>
				<FastApplyMethodDropdown />
			</LabeledControl>
		</SettingGroup>

		<SettingGroup title='Autocomplete' description='Experimental: works only with fill-in-the-middle (FIM) models, such as qwen2.5-coder with Ollama (try qwen2.5-coder:3b).'>
			<GlobalSettingSwitch settingName='enableAutocomplete' label='Suggest code as you type' />
			{enableAutocomplete && <FeatureModel featureName='Autocomplete' />}
		</SettingGroup>

		<SettingGroup title='Commit messages' description='Writes a commit message from your changes, in Source Control.'>
			<GlobalSettingSwitch settingName='syncSCMToChat' label='Use the Chat model' />
			{!syncSCMToChat && <FeatureModel featureName='SCM' />}
		</SettingGroup>

		<SettingGroup title='Selection buttons'>
			<GlobalSettingSwitch settingName='showInlineSuggestions' label='Show "Add to Chat" and "Edit Inline" when you select code' />
		</SettingGroup>
	</SettingsSection>
}
