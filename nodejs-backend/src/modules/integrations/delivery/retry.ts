import type { Logger } from 'pino';

import { CircuitOpenError } from './with-circuit-breaker.js';
import { deliveryRejectedError, deliveryTimeoutError, deliveryUnavailableError } from './errors.js';
import type { DeliveryTransport, DeliveryTransportResponse } from './transport.js';

export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BASE_BACKOFF_MS = 200;
export const DEFAULT_MAX_BACKOFF_MS = 2_000;
/** An upstream asking us to come back later than this is treated as "down". */
export const DEFAULT_MAX_RETRY_AFTER_MS = 10_000;

export interface WithRetryOptions {
  /** Per-attempt deadline enforced with `AbortSignal.timeout`. */
  readonly timeoutMs?: number | undefined;
  /** Total attempts for an idempotent call, including the first one. */
  readonly maxAttempts?: number | undefined;
  readonly baseBackoffMs?: number | undefined;
  readonly maxBackoffMs?: number | undefined;
  readonly maxRetryAfterMs?: number | undefined;
  readonly logger?: Logger | undefined;
  /** Injectable clock, randomness and sleep keep the tests deterministic. */
  readonly now?: (() => number) | undefined;
  readonly random?: (() => number) | undefined;
  readonly delay?: ((ms: number) => Promise<void>) | undefined;
}

const isTimeoutError = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

const isTransientStatus = (status: number): boolean => status === 429 || status >= 500;

const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * `Retry-After` is either a number of seconds or an HTTP date. Both forms are
 * honoured; anything else is ignored rather than trusted.
 */
export const parseRetryAfterMs = (value: string | undefined, nowMs: number): number | null => {
  if (value === undefined) return null;

  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return seconds <= 0 ? 0 : Math.round(seconds * 1_000);

  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - nowMs);
};

/**
 * Wraps a `DeliveryTransport` with attempt counting, exponential backoff with
 * full jitter, and `Retry-After` handling. Non-idempotent requests are sent
 * exactly once, since replaying e.g. a shipment creation after a timeout
 * could hand the customer two parcels.
 *
 * An open circuit (signalled by `CircuitOpenError`) fails fast: no wait, no
 * further attempts, regardless of how many attempts remain.
 */
export const withRetry = (
  transport: DeliveryTransport,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
    maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS,
    logger,
    now = Date.now,
    random = Math.random,
    delay = defaultDelay,
  }: WithRetryOptions = {},
): DeliveryTransport => {
  // Exponential backoff with full jitter: the nth retry waits a random slice of
  // an exponentially growing window, so a fleet of instances that failed at the
  // same moment does not come back in lockstep and knock the service over again.
  const backoffFor = (attempt: number): number => {
    const window = Math.min(maxBackoffMs, baseBackoffMs * 2 ** (attempt - 1));
    return Math.round(random() * window);
  };

  const waitBefore = async (
    attempt: number,
    response?: DeliveryTransportResponse,
  ): Promise<void> => {
    const retryAfter = parseRetryAfterMs(response?.headers['retry-after'], now());
    if (retryAfter !== null) {
      // The upstream told us exactly when to come back; obey it instead of
      // guessing — unless it asks for longer than we are willing to hold a
      // request open, in which case the call fails fast as unavailable.
      if (retryAfter > maxRetryAfterMs) throw deliveryUnavailableError();
      await delay(retryAfter);
      return;
    }
    await delay(backoffFor(attempt));
  };

  return {
    kind: transport.kind,
    async send(request) {
      const attempts = request.idempotent === false ? 1 : Math.max(1, maxAttempts);
      let lastFailure = deliveryUnavailableError();

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        let response: DeliveryTransportResponse;
        try {
          response = await transport.send({
            ...request,
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (error) {
          if (error instanceof CircuitOpenError) throw deliveryUnavailableError();

          lastFailure = isTimeoutError(error) ? deliveryTimeoutError() : deliveryUnavailableError();
          logger?.warn({ err: error, attempt, path: request.path }, 'Delivery call failed');
          if (attempt === attempts) throw lastFailure;
          await waitBefore(attempt);
          continue;
        }

        if (response.status >= 200 && response.status < 300) return response;

        if (isTransientStatus(response.status)) {
          lastFailure = deliveryUnavailableError();
          logger?.warn(
            { attempt, path: request.path, status: response.status },
            'Delivery call returned a transient error',
          );
          if (attempt === attempts) throw lastFailure;
          await waitBefore(attempt, response);
          continue;
        }

        // 4xx: the service is alive and is refusing *this* request. Retrying
        // would only repeat the mistake.
        logger?.warn(
          { path: request.path, status: response.status },
          'Delivery service rejected the request',
        );
        throw deliveryRejectedError(response.status);
      }

      throw lastFailure;
    },
  };
};
