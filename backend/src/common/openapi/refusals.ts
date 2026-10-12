/**
 * Refusals a route declares in the published description of the API.
 *
 * The description reads a route's request schema and its success body from
 * code. What it cannot know is what the service underneath may refuse with: a
 * stale version, a missing record, a state that forbids the move. Those answers
 * exist only as errors thrown somewhere below the handler, so each route names
 * them by hand, where it is registered, so a reviewer sees both at once.
 *
 * 400 and 500 are not listed: the document builder adds them by rule (see
 * `UNIVERSAL_RESPONSES`).
 */
import type { ZodOpenApiResponseObject } from 'zod-openapi';

import { errorResponseSchema } from './schemas.js';

/** What each error status means; the body is always the shared error envelope. */
export const RESPONSE_DESCRIPTIONS = {
  400: 'Invalid request',
  401: 'Authentication is missing or invalid',
  403: 'Not enough permissions for this operation',
  404: 'The requested resource was not found',
  409: 'The operation conflicts with the current state of the resource',
  422: 'The request is well-formed but cannot be processed',
  500: 'Internal server error',
  502: 'An external service returned an unexpected response',
  503: 'A service is temporarily unavailable',
  504: 'An external service did not respond in time',
} as const;

/** The statuses a route declares itself; 400 and 500 are added by rule. */
export type RefusalStatus = Exclude<keyof typeof RESPONSE_DESCRIPTIONS, 400 | 500>;

export type Refusals = Readonly<Partial<Record<`${RefusalStatus}`, ZodOpenApiResponseObject>>>;

/** A response that carries the error envelope. */
const errorResponse = (status: keyof typeof RESPONSE_DESCRIPTIONS): ZodOpenApiResponseObject => ({
  description: RESPONSE_DESCRIPTIONS[status],
  content: { 'application/json': { schema: errorResponseSchema } },
});

/**
 * Answers the document adds on its own. Any handler can fail, so every
 * operation declares 500; only the business API validates its input, so 400
 * is declared on every operation under `/api/v1` and nowhere else.
 */
export const UNIVERSAL_RESPONSES = {
  badRequest: errorResponse(400),
  internalServerError: errorResponse(500),
} as const;

/** The `responses` entries for the refusals an operation can answer with. */
export const refusals = (...statuses: readonly RefusalStatus[]): Refusals =>
  Object.fromEntries(statuses.map((status) => [String(status), errorResponse(status)]));
