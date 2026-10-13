/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import product from '../../../product/common/product.js';
import { IProductService } from '../../../product/common/productService.js';
import { createNativeAboutDialogDetails } from '../../electron-browser/dialog.js';

// Kodia's About dialog shows its own version next to VS Code's, without the Electron/Copilot runtime lines.
suite('Dialog', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function getDetails(voidVersion: string | undefined): { details: string; detailsToCopy: string } {
		const productService: IProductService = {
			_serviceBrand: undefined,
			...product,
			voidVersion,
		};
		return createNativeAboutDialogDetails(productService);
	}

	test('shows the Kodia version', () => {
		const { details, detailsToCopy } = getDetails('2.4.3');
		assert.ok(details.includes('Kodia Version: 2.4.3'));
		assert.ok(detailsToCopy.includes('Kodia Version: 2.4.3'));
	});

	test('omits Copilot runtime versions', () => {
		const { details } = getDetails('2.4.3');
		assert.ok(!details.includes('@github/copilot'));
	});
});
