/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// A Mac can have several mlx-lm installs, and a new model needs a recent one: Qwen3.5 models ("Model type qwen3_5 not
// supported") need 0.30 or later. Kodia starts mlx_lm.server itself, and an app opened from the Dock has a short PATH,
// where `python3` is the one Xcode brings (Python 3.9 and an mlx-lm of last year). Kodia looks for the installs and
// starts the newest.

/** An install of mlx-lm: the Python it runs on, and its version. */
export interface IMlxInstall {
	readonly python: string;
	readonly version: string;
}

/** The numbers of a version, "0.31.3" or "0.30.0rc1": what is not a number ends it. */
function numbersOf(version: string): number[] {
	const numbers: number[] = [];
	for (const segment of version.trim().split('.')) {
		const match = /^\d+/.exec(segment);
		if (!match) {
			break;
		}
		numbers.push(Number(match[0]));
		if (match[0].length !== segment.length) {
			break;
		}
	}
	return numbers;
}

/** Negative if `a` is older than `b`, positive if newer. */
export function compareVersions(a: string, b: string): number {
	const x = numbersOf(a);
	const y = numbersOf(b);
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const diff = (x[i] ?? 0) - (y[i] ?? 0);
		if (diff !== 0) {
			return diff;
		}
	}
	return 0;
}

/** The newest install; the first of them when several have the same version, so the one the user's PATH names wins a tie. */
export function newestMlxInstall(installs: readonly IMlxInstall[]): IMlxInstall | undefined {
	let best: IMlxInstall | undefined;
	for (const install of installs) {
		if (!best || compareVersions(install.version, best.version) > 0) {
			best = install;
		}
	}
	return best;
}

/** The version a Python prints when asked for the version of mlx-lm (its last line), if it is one. */
export function versionFromOutput(output: string): string | undefined {
	const last = output.trim().split(/\r?\n/).pop()?.trim();
	return last && /^\d+(\.\d+)*/.test(last) ? last : undefined;
}

/** The Python an installed script (`mlx_lm.server`) runs on, from its first line. */
export function pythonOfScript(script: string): string | undefined {
	const first = script.split(/\r?\n/, 1)[0];
	const match = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(first);
	if (!match) {
		return undefined;
	}
	// "#!/usr/bin/env python3" names a command, found on the PATH
	return match[1].endsWith('/env') ? match[2] : match[1];
}

/**
 * Where a Python with mlx-lm is usually found, beyond the PATH: Homebrew, python.org's framework (one folder a minor
 * version), the conda distributions, and the isolated environments of uv and pipx.
 */
export function wellKnownPythons(home: string, frameworkVersions: readonly string[]): string[] {
	return [
		'/opt/homebrew/bin/python3',
		'/usr/local/bin/python3',
		...[...frameworkVersions].sort((a, b) => compareVersions(b, a)).map(version => `/Library/Frameworks/Python.framework/Versions/${version}/bin/python3`),
		`${home}/.local/share/uv/tools/mlx-lm/bin/python`,
		`${home}/.local/pipx/venvs/mlx-lm/bin/python`,
		...['miniforge3', 'mambaforge', 'miniconda3', 'anaconda3'].map(distribution => `${home}/${distribution}/bin/python`),
		// not /usr/bin/python3: where Xcode's tools are missing, running it opens the dialog that installs them
	];
}

/**
 * What mlx_lm.server answers (404) to a model its mlx-lm is too old to run: "Model type qwen3_5 not supported." The
 * message says what is wrong with the install, not what to do: this adds it.
 */
export function mlxErrorWithHint(message: string): string {
	const unsupported = /Model type (\S+?) not supported/.exec(message);
	return unsupported
		? `${message}\nThe mlx-lm that serves this model is too old for the "${unsupported[1]}" architecture. Update it with: python3 -m pip install --upgrade mlx-lm, then stop the running mlx_lm.server so that Kodia starts the new one.`
		: message;
}

// mlx_lm.server ends a reply with the model's end-of-turn token as text (Qwen's `<|im_end|>`, Llama's `<|eot_id|>`...)
// instead of stopping before it: the chat showed it at the end of every answer.
const END_OF_TURN_TOKENS = /(?:<\|im_end\|>|<\|endoftext\|>|<\|eot_id\|>|<\|end_of_text\|>|<\|end\|>|<\/s>)+\s*$/;

/** The reply without the end-of-turn tokens that end it: whatever comes before them is left as it is. */
export function withoutEndOfTurnTokens(text: string): string {
	return text.replace(END_OF_TURN_TOKENS, '');
}
