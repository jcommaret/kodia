/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Kodia: the Agents Window offers only the models shown in Kodia's model
 * dropdown. The renderer forwards them per agent provider id through the
 * {@link AgentHostShownModelsConfigKey} root config value.
 */

/**
 * The shown model ids for one agent, or `undefined` when the agent is not
 * filtered (Kodia forwarded nothing for it). The root config value is only
 * validated as an object, so entries are checked here.
 */
export function getShownModelIds(shownModels: Readonly<Record<string, unknown>> | undefined, provider: string): readonly string[] | undefined {
	const ids = shownModels?.[provider];
	return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : undefined;
}

/** `claude-sonnet-4-5-20250929` → `claude-sonnet-4-5`, `gpt-4o-2024-08-06` → `gpt-4o`. */
function withoutReleaseDate(id: string): string {
	return id.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '');
}

/**
 * Whether a model from an agent's catalog is one of the shown models. Ignores
 * case and a trailing release date, since agents often list a dated snapshot
 * (`claude-sonnet-4-5-20250929`) of the model Kodia lists (`claude-sonnet-4-5`).
 */
export function isShownModel(id: string, shownIds: readonly string[]): boolean {
	const lower = id.toLowerCase();
	const undated = withoutReleaseDate(lower);
	return shownIds.some(shownId => {
		const shown = shownId.toLowerCase();
		return shown === lower || shown === undated;
	});
}
