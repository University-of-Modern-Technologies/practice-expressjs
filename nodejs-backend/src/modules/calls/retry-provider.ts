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

export interface WithRetryOptions {
  readonly maxAttempts?: number | undefined;
  readonly backoffMs?: number | undefined;
  readonly logger?: Logger | undefined;
  /** Injectable sleep keeps the tests deterministic. */
  readonly delay?: ((ms: number) => Promise<void>) | undefined;
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
  const { maxAttempts = 1, backoffMs = 0, logger, delay = defaultDelay } = options;
  const attempts = Math.max(1, maxAttempts);

  return {
    name: provider.name,
    async fetchCalls(request) {
      let lastFailure: Error = callProviderUnavailableError();

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          return await provider.fetchCalls(request);
        } catch (error) {
          if (!(error instanceof RetryableCallProviderFailure)) throw error;

          lastFailure = error.failure;
          logger?.warn({ attempt }, 'Telephony journal fetch failed; retrying');
          if (attempt === attempts) throw lastFailure;
          await delay(backoffMs * 2 ** (attempt - 1));
        }
      }

      throw lastFailure;
    },
  };
};
