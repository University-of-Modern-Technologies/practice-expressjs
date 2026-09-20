import { z } from 'zod';

import { AppError } from '../../common/errors/app-error.js';
import { callDirections, callDispositions } from './types.js';

/**
 * Provider-agnostic port for the telephony journal.
 *
 * Everything above this interface — idempotent import, linking, recordings —
 * is written once and works with the in-repo stub, with an HTTP switchboard, or
 * with whatever the deployment actually has. The port is deliberately tiny: one
 * read of a batch, no call control, no webhooks. A narrow port is a port that
 * is easy to fake.
 */
export interface CallProviderFetchRequest {
  /** Upper bound on how many records one run may take. */
  readonly limit: number;
}

/** E.164 as the provider is documented to speak it: `+` then up to 15 digits. */
const phoneNumber = z
  .string()
  .trim()
  .max(32)
  .regex(/^\+[1-9]\d{1,14}$/, 'Invalid E.164 number');

/**
 * What we require of a record on the wire. A provider that answers with
 * anything else is treated as unavailable rather than half-trusted: importing
 * a call with a broken number would put the defect in the database, where it
 * outlives the bad response.
 */
export const callProviderRecordSchema = z.object({
  externalId: z.string().trim().min(1).max(64),
  direction: z.enum(callDirections),
  disposition: z.enum(callDispositions),
  fromNumber: phoneNumber,
  toNumber: phoneNumber,
  startedAt: z.string().datetime({ offset: true }),
  durationSeconds: z.number().int().min(0),
  recordingUrl: z.string().trim().max(512).optional(),
});

export type CallProviderRecord = z.infer<typeof callProviderRecordSchema>;

export const callProviderBatchSchema = z.array(callProviderRecordSchema);

export interface CallProvider {
  /** Identifies the implementation in responses and logs. */
  readonly name: string;
  fetchCalls(request: CallProviderFetchRequest): Promise<readonly CallProviderRecord[]>;
}

export const CALL_PROVIDER_UNAVAILABLE = 'CALL_PROVIDER_UNAVAILABLE';

/**
 * The single failure mode the module exposes for the provider: a timeout, a
 * refused connection, a 5xx and a payload that violates the contract all reach
 * the caller as the same thing, because they all mean "the journal could not
 * be read just now, try again". The distinguishing detail stays in the log,
 * on our side of the boundary.
 */
export const callProviderUnavailableError = (): AppError =>
  new AppError('The telephony provider is temporarily unavailable', 502, CALL_PROVIDER_UNAVAILABLE);
