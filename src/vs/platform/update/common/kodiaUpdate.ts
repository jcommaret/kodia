/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

// Kodia: there is no update server. kodia-builder's update_version.sh writes, for each platform, a static
// `<updateUrl>/<quality>/<platform>/latest.json` describing the latest release (platform being e.g. darwin-arm64,
// win32-x64, win32-x64-user, win32-x64-archive or linux-x64). It answers 200 with that release whatever the
// version asking, where Microsoft's server answers 204 when there is nothing newer, so the client decides.

import { IProductService } from '../../product/common/productService.js';
import { IUpdate } from './update.js';

export function createKodiaUpdateURL(baseUpdateUrl: string, platform: string, quality: string): string {
	return `${baseUpdateUrl}/${quality}/${platform}/latest.json`;
}

/** This build's release name, "<VS Code version>-<Kodia version>" like its release tag, e.g. 1.141.0-2.5.5. */
export function getKodiaReleaseName(productService: IProductService): string | undefined {
	return productService.voidVersion ? `${productService.version}-${productService.voidVersion}` : undefined;
}

/** Whether release name `a` is newer than `b`, comparing "<VS Code version>-<Kodia version>" numerically. */
export function isNewerRelease(a: string, b: string): boolean {
	const parse = (name: string) => /^(\d+)\.(\d+)\.(\d+)-(\d+)\.(\d+)\.(\d+)$/.exec(name)?.slice(1).map(Number);
	const pa = parse(a), pb = parse(b);
	if (!pa || !pb) {
		return a !== b;
	}
	for (let i = 0; i < pa.length; i++) {
		if (pa[i] !== pb[i]) {
			return pa[i] > pb[i];
		}
	}
	return false;
}

/**
 * Whether the release a feed describes is an update for `current` (this build, or the pending update being
 * overwritten): another build, and a newer release when both have a release name. Never offers a downgrade, e.g.
 * when a build was installed by hand before its manifest was written.
 */
export function isNewerUpdate(update: IUpdate | null | undefined, current: IUpdate): update is IUpdate {
	if (!update || !update.url || !update.version || !update.productVersion) {
		return false;
	}
	if (update.version === current.version) {
		return false;
	}
	if (update.name && current.name) {
		return isNewerRelease(update.name, current.name);
	}
	return true;
}
