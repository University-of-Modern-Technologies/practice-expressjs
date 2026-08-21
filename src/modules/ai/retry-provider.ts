import type { Logger } from 'pino';

import { aiUnavailableError, type AiProvider } from './provider.js';

/**
 * Seam that lets a single-attempt provider mark a failure as transient
 * without deciding for its caller whether another attempt is worthwhile.
 * Anything thrown that is *not* this type (an invalid payload, a 4xx from the
 * endpoint) is a permanent failure and must propagate on the first attempt.
 */
export class RetryableAiFailure extends Error {
  public constructor(public readonly failure: Error) {
    super(failure.message);
    this.name = 'RetryableAiFailure';
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
 * Wraps an `AiProvider` with retries for transient failures. The wrapped
 * provider decides, per attempt, whether a failure is worth retrying by
 * throwing a `RetryableAiFailure`; everything else is passed through as-is on
 * the first attempt.
 */
export const withRetry = (provider: AiProvider, options: WithRetryOptions = {}): AiProvider => {
  const { maxAttempts = 1, backoffMs = 0, logger, delay = defaultDelay } = options;
  const attempts = Math.max(1, maxAttempts);

  return {
    name: provider.name,
    async complete(request) {
      let lastFailure: Error = aiUnavailableError();

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          return await provider.complete(request);
        } catch (error) {
          if (!(error instanceof RetryableAiFailure)) throw error;

          lastFailure = error.failure;
          logger?.warn({ attempt }, 'AI completion attempt failed; retrying');
          if (attempt === attempts) throw lastFailure;
          await delay(backoffMs * 2 ** (attempt - 1));
        }
      }

      throw lastFailure;
    },
  };
};
