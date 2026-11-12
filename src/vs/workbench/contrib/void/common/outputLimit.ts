/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// A model that reaches its output limit just stops: the reply ends mid-sentence, which reads as Kodia giving up on a
// request that was a little long. The limit comes from the provider (finish_reason "length", stop_reason "max_tokens",
// finishReason "MAX_TOKENS"), so Kodia says so at the end of the reply.

export const OUTPUT_LIMIT_NOTICE = '\n\n*The reply stops here: the model reached its output limit. Ask it to continue.*';

/** The reply, with the notice when the model stopped at its output limit. A reply with no text has nothing to complete. */
export function withOutputLimitNotice(text: string, reachedOutputLimit: boolean): string {
	return reachedOutputLimit && text.trim() ? text + OUTPUT_LIMIT_NOTICE : text;
}

/**
 * mlx_lm.server stops a reply at 512 tokens unless the request names a limit, and Kodia's requests did not: a reply a
 * little long was cut. An MLX model gets room for a long reply, whatever its context allows after the prompt.
 */
export const MLX_MIN_OUTPUT_TOKENS = 8_192;

export function mlxMaxOutputTokens(reservedOutputTokenSpace: number | null | undefined): number {
	return Math.max(reservedOutputTokenSpace ?? 0, MLX_MIN_OUTPUT_TOKENS);
}
