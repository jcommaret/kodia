/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../base/common/uri.js';
import { Event } from '../../../../base/common/event.js';


export type CommandBarStateType = undefined | {
	sortedDiffZoneIds: string[]; // sorted by line number
	sortedDiffIds: string[]; // sorted by line number (computed)
	isStreaming: boolean; // is any diffZone streaming in this URI

	diffIdx: number | null; // must refresh whenever sortedDiffIds does so it's valid
}


export interface IVoidCommandBarService {
	readonly _serviceBrand: undefined;
	stateOfURI: { [uri: string]: CommandBarStateType };
	sortedURIs: URI[];
	activeURI: URI | null;

	onDidChangeState: Event<{ uri: URI }>;
	onDidChangeActiveURI: Event<{ uri: URI | null }>;

	getStreamState: (uri: URI) => 'streaming' | 'idle-has-changes' | 'idle-no-changes';
	setDiffIdx(uri: URI, newIdx: number | null): void;

	getNextDiffIdx(step: 1 | -1): number | null;
	getNextUriIdx(step: 1 | -1): number | null;
	goToDiffIdx(idx: number | null): void;
	goToURIIdx(idx: number | null): Promise<void>;

	acceptOrRejectAllFiles(opts: { behavior: 'reject' | 'accept' }): void;
	anyFileIsStreaming(): boolean;

}

export const IVoidCommandBarService = createDecorator<IVoidCommandBarService>('VoidCommandBarService');
