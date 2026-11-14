/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// When a request to the model fails, Kodia's chat and the Kodia agent of the Agents window both send it again before
// they give up, by the rules below: a local server that is still loading its model, or a provider that drops a
// connection, answers the second time.

/** How many times a request is sent, the first one included. */
export const MODEL_REQUEST_ATTEMPTS = 3

/** The wait before a request is sent again, in milliseconds. */
export const MODEL_RETRY_DELAY_MS = 2500

// what a provider says of a key it refuses, or of a request it will never take: sending it again changes nothing
const PERMANENT_ERROR = /\b(401|403)\b|invalid[\s_-]*api[\s_-]*key|incorrect api key|api key (is )?(not valid|invalid|missing)|unauthori[sz]ed|authentication|permission[\s_-]*denied|forbidden/i

/** Whether an error is one that sending the request again can't fix: a key the provider refuses. */
export const isPermanentModelError = (message: string | undefined): boolean => !!message && PERMANENT_ERROR.test(message)

/**
 * Whether a request that failed is sent again. `attempt` is how many times it was sent, and `shownReply` whether the
 * user already sees part of the reply, which a second request would write again from its start.
 */
export const shouldRetryModelRequest = ({ attempt, error, shownReply }: { attempt: number, error: string | undefined, shownReply?: boolean }): boolean =>
	attempt < MODEL_REQUEST_ATTEMPTS && !shownReply && !isPermanentModelError(error)
