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

/** Longest single pause between two attempts, however large the base. */
export const MAX_RETRY_BACKOFF_MS = 5_000;
/**
 * Longest a completion may keep retrying, counted from its first attempt. The
 * caller is waiting on an HTTP request, and an answer of "unavailable" given
 * promptly serves them better than one given minutes later.
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
 * Wraps an `AiProvider` with retries for transient failures. The wrapped
 * provider decides, per attempt, whether a failure is worth retrying by
 * throwing a `RetryableAiFailure`; everything else is passed through as-is on
 * the first attempt.
 */
export const withRetry = (provider: AiProvider, options: WithRetryOptions = {}): AiProvider => {
  const { maxAttempts = 1, backoffMs = 0, logger, delay = defaultDelay, now = Date.now } = options;
  const attempts = Math.max(1, maxAttempts);

  return {
    name: provider.name,
    async complete(request) {
      let lastFailure: Error = aiUnavailableError();
      const startedAt = now();

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          return await provider.complete(request);
        } catch (error) {
          if (!(error instanceof RetryableAiFailure)) throw error;

          lastFailure = error.failure;
          logger?.warn({ attempt }, 'AI completion attempt failed; retrying');
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
