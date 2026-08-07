import { describe, expect, it, jest } from '@jest/globals';

import { AppError } from '../../common/errors/app-error.js';
import { aiTimeoutError, aiUnavailableError, type AiProvider } from './provider.js';
import { RetryableAiFailure, withRetry } from './retry-provider.js';

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  throw new Error('Expected the call to reject');
};

const request = { system: 'sys', prompt: 'p', maxTokens: 16 };

describe('withRetry (AI provider)', () => {
  it('retries a transient failure and returns the eventual success', async () => {
    let calls = 0;
    const inner: AiProvider = {
      name: 'inner',
      complete: jest.fn(() => {
        calls += 1;
        if (calls === 1) return Promise.reject(new RetryableAiFailure(aiTimeoutError()));
        return Promise.resolve('done');
      }),
    };
    const provider = withRetry(inner, { maxAttempts: 2, delay: () => Promise.resolve() });

    await expect(provider.complete(request)).resolves.toBe('done');
    expect(inner.complete).toHaveBeenCalledTimes(2);
  });

  it('propagates a non-retryable failure after exactly one attempt', async () => {
    const inner: AiProvider = {
      name: 'inner',
      complete: jest.fn(() => Promise.reject(aiUnavailableError())),
    };
    const provider = withRetry(inner, { maxAttempts: 3, delay: () => Promise.resolve() });

    await expect(codeOf(provider.complete(request))).resolves.toBe('AI_UNAVAILABLE');
    expect(inner.complete).toHaveBeenCalledTimes(1);
  });

  it('throws the last transient failure once attempts are exhausted', async () => {
    const inner: AiProvider = {
      name: 'inner',
      complete: jest.fn(() => Promise.reject(new RetryableAiFailure(aiTimeoutError()))),
    };
    const provider = withRetry(inner, { maxAttempts: 2, delay: () => Promise.resolve() });

    await expect(codeOf(provider.complete(request))).resolves.toBe('AI_TIMEOUT');
    expect(inner.complete).toHaveBeenCalledTimes(2);
  });

  it('preserves the wrapped provider name', () => {
    const inner: AiProvider = { name: 'inner-name', complete: () => Promise.resolve('x') };
    expect(withRetry(inner).name).toBe('inner-name');
  });
});
