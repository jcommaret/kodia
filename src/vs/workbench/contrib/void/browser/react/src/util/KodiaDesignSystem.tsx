/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React from 'react';

export const KodiaCard = ({
	children,
	className = '',
	onClick,
}: {
	children: React.ReactNode;
	className?: string;
	onClick?: () => void;
}) => (
	<div
		onClick={onClick}
		className={`rounded-lg border border-void-border-2 bg-void-bg-3/70 p-3.5 transition-colors ${onClick ? 'cursor-pointer hover:border-void-border-1 hover:bg-void-bg-3' : ''} ${className}`}
	>
		{children}
	</div>
);

export const KodiaBadge = ({
	children,
	tone = 'neutral',
	className = '',
}: {
	children: React.ReactNode;
	tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
	className?: string;
}) => {
	const toneClasses = tone === 'accent'
		? 'bg-[var(--kodia-accent-soft)] text-void-fg-1 border-[var(--kodia-accent)]/40'
		: tone === 'success'
			? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
			: tone === 'warning'
				? 'bg-amber-500/15 text-amber-400 border-amber-500/30'
				: tone === 'danger'
					? 'bg-rose-500/15 text-rose-400 border-rose-500/30'
					: 'bg-void-bg-1 text-void-fg-3 border-void-border-2';
	return (
		<span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded-full border ${toneClasses} ${className}`}>
			{children}
		</span>
	);
};

export const KodiaStatTile = ({
	label,
	value,
	detail,
	icon,
	onClick,
}: {
	label: string;
	value: React.ReactNode;
	detail?: React.ReactNode;
	icon?: React.ReactNode;
	onClick?: () => void;
}) => (
	<KodiaCard onClick={onClick} className='flex flex-col gap-1'>
		<div className='flex items-center justify-between text-[11px] text-void-fg-3'>
			<span>{label}</span>
			{icon && <span className='opacity-75'>{icon}</span>}
		</div>
		<div className='text-base font-semibold text-void-fg-1 truncate'>{value}</div>
		{detail && <div className='text-[11px] text-void-fg-3 truncate'>{detail}</div>}
	</KodiaCard>
);

export const KodiaEmptyState = ({
	icon,
	title,
	description,
	action,
}: {
	icon: React.ReactNode;
	title: string;
	description: string;
	action?: React.ReactNode;
}) => (
	<div className='rounded-lg border border-dashed border-void-border-2 bg-void-bg-3/40 p-6 flex flex-col items-center text-center gap-2'>
		<div className='text-void-fg-3 opacity-80'>{icon}</div>
		<div className='text-xs font-medium text-void-fg-1'>{title}</div>
		<div className='text-[11px] text-void-fg-3 max-w-xs'>{description}</div>
		{action && <div className='mt-2'>{action}</div>}
	</div>
);

export const KodiaPrimaryButton = ({
	children,
	className = '',
	disabled,
	...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
	<button
		type='button'
		disabled={disabled}
		style={{ backgroundColor: 'var(--kodia-accent)', color: 'var(--kodia-accent-fg)' }}
		className={`inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-opacity ${disabled ? 'opacity-45 cursor-not-allowed' : 'hover:opacity-90 cursor-pointer'} ${className}`}
		{...props}
	>
		{children}
	</button>
);

export const KodiaSecondaryButton = ({
	children,
	className = '',
	disabled,
	...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
	<button
		type='button'
		disabled={disabled}
		className={`inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-void-border-2 bg-void-bg-1 text-void-fg-1 transition-colors ${disabled ? 'opacity-45 cursor-not-allowed' : 'hover:bg-void-bg-3 cursor-pointer'} ${className}`}
		{...props}
	>
		{children}
	</button>
);
