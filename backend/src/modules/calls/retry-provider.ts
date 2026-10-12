import type { Logger } from 'pino';

import { callProviderUnavailableError, type CallProvider } from './provider.js';

/**
 * Seam that lets a single-attempt provider mark a failure as transient
 * without deciding for its caller whether another attempt is worthwhile.
 * Anything thrown that is *not* this type (a payload that violates the
 * contract, a 4xx from the switchboard) is a permanent failure and must
 * propagate on the first attempt.
 */
export class RetryableCallProviderFailure extends Error {
  public constructor(public readonly failure: Error) {
    super(failure.message);
    this.name = 'RetryableCallProviderFailure';
  }
}

/** Longest single pause between two attempts, however large the base. */
export const MAX_RETRY_BACKOFF_MS = 5_000;
/**
 * Longest a fetch may keep retrying, counted from its first attempt. A sync
 * runs inside a request, and a caller waiting minutes for "unavailable" is
 * worse served than one told so promptly.
 */
export const MAX_RETRY_TOTAL_MS = 30_000;

export interface WithRetryOptions {
  readonly maxAttempts?: number | undefined;
  readonly backoffMs?: number | undefined;
  readonly logger?: Logger | undefined;
  /** Injectable sleep and clock keep the tests deterministic. */
  readonly delay?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
}

const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Wraps a `CallProvider` with a bounded number of attempts and an exponential
 * wait between them. Reading the journal is a pure read — the same batch twice
 * costs nothing and is deduplicated by `externalId` anyway — so every attempt
 * is safe to repeat.
 */
export const withRetry = (provider: CallProvider, options: WithRetryOptions = {}): CallProvider => {
  const { maxAttempts = 1, backoffMs = 0, logger, delay = defaultDelay, now = Date.now } = options;
  const attempts = Math.max(1, maxAttempts);

  return {
    name: provider.name,
    async fetchCalls(request) {
      let lastFailure: Error = callProviderUnavailableError();
      const startedAt = now();

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          return await provider.fetchCalls(request);
        } catch (error) {
          if (!(error instanceof RetryableCallProviderFailure)) throw error;

          lastFailure = error.failure;
          logger?.warn({ attempt }, 'Telephony journal fetch failed; retrying');
          if (attempt === attempts) throw lastFailure;
          const wait = Math.min(MAX_RETRY_BACKOFF_MS, backoffMs * 2 ** (attempt - 1));
          // Another attempt that could only start past the budget is not made.
          if (now() - startedAt + wait > MAX_RETRY_TOTAL_MS) throw lastFailure;
          await delay(wait);
        }
      }

      throw lastFailure;
    },
  };
};
