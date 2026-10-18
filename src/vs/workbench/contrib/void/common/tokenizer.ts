/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { importAMDNodeModule } from '../../../../amdX.js';

// The workbench (browser/common) layer can't resolve bare npm specifiers at runtime — only
// electron-main gets plain Node `require`. gpt-tokenizer ships a UMD build, so it's loaded the
// same way as vscode-textmate/vscode-oniguruma: via the AMD-shim loader, from node_modules.
type GptTokenizerModule = typeof import('gpt-tokenizer');

let countTokensFn: GptTokenizerModule['countTokens'] | undefined;
void importAMDNodeModule<GptTokenizerModule>('gpt-tokenizer', 'dist/o200k_base.js')
	.then(mod => { countTokensFn = mod.countTokens })
	.catch(() => { /* keep using the fallback estimate below */ })

const FALLBACK_CHARS_PER_TOKEN = 4

// Local, offline BPE estimate (o200k_base) used to size/trim context. Not the exact tokenizer
// of every provider (Anthropic/Gemini/Mistral each have their own), but it's a far closer
// approximation than a flat chars-per-token ratio, with no network round-trip. Synchronous by
// design (used inside hot, non-async paths); falls back to a flat ratio until the module — kicked
// off at import time above — finishes its one-time async load.
export const estimateTokens = (text: string): number => {
	if (!text) return 0
	if (countTokensFn) return countTokensFn(text)
	return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN)
}
