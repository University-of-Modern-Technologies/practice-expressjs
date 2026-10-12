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
 * A recording is something a browser is about to open, so only a web address
 * is accepted from the provider: any other scheme (`javascript:`, `file:`,
 * `data:`) in that field is a contract violation, not a link to hand out.
 */
const RECORDING_URL_PATTERN = /^https?:\/\/[^\s/?#]+\S*$/i;

/**
 * Upper bound on one batch. A provider that answers with more than this is
 * misbehaving, and importing an unbounded batch inside one request is how a
 * sync turns into an outage of its own making. The configured sync size is
 * never allowed above it.
 */
export const MAX_PROVIDER_BATCH_SIZE = 500;

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
  recordingUrl: z
    .string()
    .trim()
    .max(512)
    // An empty link is the provider saying "no recording" in its own words.
    .transform((value) => (value === '' ? undefined : value))
    .refine((value) => value === undefined || RECORDING_URL_PATTERN.test(value), {
      message: 'Expected an http(s) URL',
    })
    .nullable()
    .transform((value) => value ?? undefined)
    .optional(),
});

export type CallProviderRecord = z.infer<typeof callProviderRecordSchema>;

export const callProviderBatchSchema = z
  .array(callProviderRecordSchema)
  .max(MAX_PROVIDER_BATCH_SIZE);

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
