/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react'
import { GlobalSettingName, GlobalSettings } from '../../../../common/voidSettingsTypes.js'
import { VoidButtonBgDarken, VoidSwitch } from '../util/inputs.js'
import { useAccessor, useSettingsState } from '../util/services.js'

// The building blocks of the settings page: a section per page of the nav, groups of related settings in it,
// and the same few controls everywhere

export const SettingsSection = ({ title, description, children }: { title: string, description?: React.ReactNode, children: React.ReactNode }) => {
	return <section className='flex flex-col gap-10'>
		<header>
			<h2 className='text-2xl font-medium'>{title}</h2>
			{description && <div className='text-root text-void-fg-3 mt-1'>{description}</div>}
		</header>
		{children}
	</section>
}

export const SettingGroup = ({ title, description, children }: { title: string, description?: React.ReactNode, children: React.ReactNode }) => {
	return <div>
		<h3 className='text-lg font-medium'>{title}</h3>
		{description && <div className='text-sm text-void-fg-3 mt-1'>{description}</div>}
		<div className='flex flex-col gap-3 mt-3'>
			{children}
		</div>
	</div>
}

// The label says what the setting does when it's on, whatever its state
export const SettingSwitch = ({ value, onChange, label, description, disabled }: { value: boolean, onChange: (value: boolean) => void, label: React.ReactNode, description?: React.ReactNode, disabled?: boolean }) => {
	return <div>
		<div className='flex items-center gap-x-2'>
			<VoidSwitch size='xs' value={value} onChange={onChange} disabled={disabled} />
			<span className={`text-root text-void-fg-2 select-none ${disabled ? 'opacity-50' : 'cursor-pointer'}`} onClick={() => { if (!disabled) onChange(!value) }}>{label}</span>
		</div>
		{description && <div className='text-sm text-void-fg-3 mt-1 ml-9'>{description}</div>}
	</div>
}

type BooleanGlobalSettingName = { [K in GlobalSettingName]: GlobalSettings[K] extends boolean ? K : never }[GlobalSettingName]

export const GlobalSettingSwitch = ({ settingName, label, description }: { settingName: BooleanGlobalSettingName, label: React.ReactNode, description?: React.ReactNode }) => {
	const voidSettingsService = useAccessor().get('IVoidSettingsService')
	const value = !!useSettingsState().globalSettings[settingName]
	return <SettingSwitch value={value} onChange={(newVal) => voidSettingsService.setGlobalSetting(settingName, newVal)} label={label} description={description} />
}

export const AddButton = ({ disabled, text = 'Add', ...props }: { disabled?: boolean, text?: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) => {
	return <button
		disabled={disabled}
		className={`bg-[#0e70c0] px-3 py-1 text-white rounded-sm ${!disabled ? 'hover:bg-[#1177cb] cursor-pointer' : 'opacity-50 cursor-not-allowed bg-opacity-70'}`}
		{...props}
	>{text}</button>
}

// "+ Add a ..." under a list, which opens the list's add form
export const AddRowButton = ({ text, onClick }: { text: string, onClick: () => void }) => {
	return <div
		className='text-void-fg-4 flex flex-nowrap text-nowrap items-center hover:brightness-110 cursor-pointer w-fit'
		onClick={onClick}
	>
		<div className='flex items-center gap-1'>
			<Plus size={16} />
			<span>{text}</span>
		</div>
	</div>
}

// Asks for a second click to confirm, and cancels on a click elsewhere
export const ConfirmButton = ({ children, confirmText, onConfirm, className }: { children: React.ReactNode, confirmText: string, onConfirm: () => void, className?: string }) => {
	const [confirm, setConfirm] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!confirm) return;
		const handleClickOutside = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				setConfirm(false);
			}
		};
		document.addEventListener('click', handleClickOutside);
		return () => document.removeEventListener('click', handleClickOutside);
	}, [confirm]);
	return (
		<div ref={ref} className={`inline-block`}>
			<VoidButtonBgDarken className={className} onClick={() => {
				if (!confirm) {
					setConfirm(true);
				} else {
					onConfirm();
					setConfirm(false);
				}
			}}>
				{confirm ? confirmText : children}
			</VoidButtonBgDarken>
		</div>
	);
};

export const AnimatedCheckmarkButton = ({ text, className }: { text?: string, className?: string }) => {
	const [dashOffset, setDashOffset] = useState(40);

	useEffect(() => {
		const startTime = performance.now();
		const duration = 500; // 500ms animation

		const animate = (currentTime: number) => {
			const elapsed = currentTime - startTime;
			const progress = Math.min(elapsed / duration, 1);
			const newOffset = 40 - (progress * 40);

			setDashOffset(newOffset);

			if (progress < 1) {
				requestAnimationFrame(animate);
			}
		};

		const animationId = requestAnimationFrame(animate);
		return () => cancelAnimationFrame(animationId);
	}, []);

	return <div
		className={`flex items-center gap-1.5 w-fit
			${className ? className : `px-2 py-0.5 text-xs text-zinc-900 bg-zinc-100 rounded-sm`}
		`}
	>
		<svg className="size-4" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
			<path
				d="M5 13l4 4L19 7"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				style={{
					strokeDasharray: 40,
					strokeDashoffset: dashOffset
				}}
			/>
		</svg>
		{text}
	</div>
}
