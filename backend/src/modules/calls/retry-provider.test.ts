import { describe, expect, it, jest } from '@jest/globals';

import { AppError } from '../../common/errors/index.js';
import { callProviderUnavailableError, type CallProvider } from './provider.js';
import {
  MAX_RETRY_BACKOFF_MS,
  MAX_RETRY_TOTAL_MS,
  RetryableCallProviderFailure,
  withRetry,
} from './retry-provider.js';

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

describe('call provider retry budget', () => {
  const failing = () =>
    jest
      .fn<CallProvider['fetchCalls']>()
      .mockRejectedValue(new RetryableCallProviderFailure(callProviderUnavailableError()));

  it('caps a single pause however large the base', async () => {
    const delay = jest.fn(async (_ms: number) => undefined);
    const provider = withRetry(providerThat(failing()), {
      maxAttempts: 4,
      backoffMs: 4_000,
      delay,
      now: () => 0,
    });

    await expect(provider.fetchCalls(request)).rejects.toBeInstanceOf(AppError);
    expect(delay.mock.calls.map(([ms]) => ms)).toEqual([
      4_000,
      MAX_RETRY_BACKOFF_MS,
      MAX_RETRY_BACKOFF_MS,
    ]);
  });

  it('stops retrying once the total budget is spent', async () => {
    let clock = 0;
    const fetchCalls = failing();
    const provider = withRetry(providerThat(fetchCalls), {
      maxAttempts: 10,
      backoffMs: 5_000,
      delay: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });

    await expect(provider.fetchCalls(request)).rejects.toBeInstanceOf(AppError);
    expect(clock).toBeLessThanOrEqual(MAX_RETRY_TOTAL_MS);
    expect(fetchCalls.mock.calls.length).toBeLessThan(10);
  });
});
