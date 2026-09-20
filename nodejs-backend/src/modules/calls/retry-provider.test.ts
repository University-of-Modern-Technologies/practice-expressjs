import { describe, expect, it, jest } from '@jest/globals';

import { AppError } from '../../common/errors/index.js';
import { callProviderUnavailableError, type CallProvider } from './provider.js';
import { RetryableCallProviderFailure, withRetry } from './retry-provider.js';

const request = { limit: 10 };

const providerThat = (fetchCalls: CallProvider['fetchCalls']): CallProvider => ({
  name: 'test',
  fetchCalls,
});

describe('call provider retries', () => {
  it('returns the first successful attempt without waiting', async () => {
    const delay = jest.fn(async (_ms: number) => undefined);
    const provider = withRetry(
      providerThat(() => Promise.resolve([])),
      { maxAttempts: 3, delay },
    );

    await expect(provider.fetchCalls(request)).resolves.toEqual([]);
    expect(delay).not.toHaveBeenCalled();
  });

  it('retries a transient failure and backs off further each time', async () => {
    const delay = jest.fn(async (_ms: number) => undefined);
    const fetchCalls = jest
      .fn<CallProvider['fetchCalls']>()
      .mockRejectedValueOnce(new RetryableCallProviderFailure(callProviderUnavailableError()))
      .mockRejectedValueOnce(new RetryableCallProviderFailure(callProviderUnavailableError()))
      .mockResolvedValueOnce([]);
    const provider = withRetry(providerThat(fetchCalls), {
      maxAttempts: 3,
      backoffMs: 100,
      delay,
    });

    await expect(provider.fetchCalls(request)).resolves.toEqual([]);
    expect(fetchCalls).toHaveBeenCalledTimes(3);
    expect(delay.mock.calls).toEqual([[100], [200]]);
  });

  it('gives up with the underlying failure once the attempts run out', async () => {
    const delay = jest.fn(async (_ms: number) => undefined);
    const fetchCalls = jest
      .fn<CallProvider['fetchCalls']>()
      .mockRejectedValue(new RetryableCallProviderFailure(callProviderUnavailableError()));
    const provider = withRetry(providerThat(fetchCalls), { maxAttempts: 2, delay });

    await expect(provider.fetchCalls(request)).rejects.toMatchObject({
      statusCode: 502,
      code: 'CALL_PROVIDER_UNAVAILABLE',
    } satisfies Partial<AppError>);
    expect(fetchCalls).toHaveBeenCalledTimes(2);
  });

  it('passes a permanent failure through on the first attempt', async () => {
    const fetchCalls = jest
      .fn<CallProvider['fetchCalls']>()
      .mockRejectedValue(callProviderUnavailableError());
    const provider = withRetry(providerThat(fetchCalls), { maxAttempts: 5 });

    await expect(provider.fetchCalls(request)).rejects.toBeInstanceOf(AppError);
    expect(fetchCalls).toHaveBeenCalledTimes(1);
  });
});
