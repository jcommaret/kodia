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
 * The model id an agent actually runs, stripped of a selection prefix.
 * Codex publishes `@provider=openai:gpt-5.5`; the model Kodia lists is `gpt-5.5`.
 */
function bareModelId(id: string): string {
	const prefixed = /^@provider=[^:]+:(.+)$/.exec(id);
	const bare = prefixed?.[1] ?? id;
	try {
		return decodeURIComponent(bare);
	} catch {
		return bare;
	}
}

/**
 * One comparable form for a catalog id and a Kodia dropdown id.
 * Agents publish the same model under a different spelling: Claude's catalog
 * uses `claude-sonnet-4.6` where Kodia lists `claude-sonnet-4-6`, and either
 * side may carry a trailing release date.
 */
function canonicalModelId(id: string): string {
	return withoutReleaseDate(bareModelId(id.toLowerCase())).replaceAll('.', '-');
}

/**
 * Whether a model from an agent's catalog is one of the shown models.
 * A longer id (`gpt-5.5-codex`, `claude-sonnet-4`) does not match a shorter one.
 */
export function isShownModel(id: string, shownIds: readonly string[]): boolean {
	const canonical = canonicalModelId(id);
	return shownIds.some(shownId => canonicalModelId(shownId) === canonical);
}
