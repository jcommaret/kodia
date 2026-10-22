/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import type { IProductConfiguration } from '../../../../../../../base/common/product.js';

/**
 * Kodia: the model picker's models are the ones set up in Kodia's settings. Kodia ships without
 * GitHub Copilot, so the picker never asks to sign in to Copilot, and always offers "Manage
 * Models...", which opens Kodia's settings (see the Agents window's handler for it).
 */
export function isKodiaProduct(product: Pick<IProductConfiguration, 'defaultChatAgent'>): boolean {
	return product.defaultChatAgent?.provider?.default?.id === 'void';
}
