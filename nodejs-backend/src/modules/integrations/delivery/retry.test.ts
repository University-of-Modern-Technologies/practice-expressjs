import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { AppError } from '../../../common/errors/app-error.js';
import { createCircuitBreaker } from './circuit-breaker.js';
import { DELIVERY_REJECTED, DELIVERY_TIMEOUT, DELIVERY_UNAVAILABLE } from './errors.js';
import { withRetry } from './retry.js';
import type { DeliveryTransport, DeliveryTransportResponse } from './transport.js';
import { withCircuitBreaker } from './with-circuit-breaker.js';

const ok = (): DeliveryTransportResponse => ({ status: 200, headers: {}, body: {} });
const status = (code: number, headers: Record<string, string> = {}): DeliveryTransportResponse => ({
  status: code,
  headers,
  body: {},
});

interface FakeTransport extends DeliveryTransport {
  readonly calls: number;
  readonly idempotentSeen: boolean[];
}

const fakeTransport = (script: ReadonlyArray<DeliveryTransportResponse | Error>): FakeTransport => {
  let index = 0;
  const idempotentSeen: boolean[] = [];
  return {
    kind: 'http',
    get calls() {
      return index;
    },
    idempotentSeen,
    send(request) {
      idempotentSeen.push(request.idempotent !== false);
      const next = script[Math.min(index, script.length - 1)];
      index += 1;
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next as DeliveryTransportResponse);
    },
  };
};

const timeoutError = (): Error => {
  const error = new Error('aborted');
  error.name = 'TimeoutError';
  return error;
};

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  throw new Error('Expected the call to reject');
};

describe('withRetry (delivery transport)', () => {
  let delay: jest.Mock<(ms: number) => Promise<void>>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    delay = jest.fn(() => Promise.resolve());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const request = (idempotent: boolean) => ({
    method: 'GET' as const,
    path: '/v1/shipments/1',
    idempotent,
  });

  it('makes exactly one attempt for a non-idempotent request, even after a timeout', async () => {
    const transport = fakeTransport([timeoutError(), ok()]);
    const wrapped = withRetry(transport, { delay, random: () => 1, maxAttempts: 3 });

    await expect(codeOf(wrapped.send(request(false)))).resolves.toBe(DELIVERY_TIMEOUT);
    expect(transport.calls).toBe(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it('retries an idempotent request on a transient status until it succeeds', async () => {
    const transport = fakeTransport([status(503), status(500), ok()]);
    const wrapped = withRetry(transport, {
      delay,
      random: () => 1,
      maxAttempts: 3,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
    });

    await expect(wrapped.send(request(true))).resolves.toMatchObject({ status: 200 });
    expect(transport.calls).toBe(3);
    expect(delay.mock.calls).toEqual([[100], [200]]);
  });

  it('does not retry a 4xx and translates it to DELIVERY_REJECTED immediately', async () => {
    const transport = fakeTransport([status(404)]);
    const wrapped = withRetry(transport, { delay, maxAttempts: 3 });

    await expect(codeOf(wrapped.send(request(true)))).resolves.toBe(DELIVERY_REJECTED);
    expect(transport.calls).toBe(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it('obeys Retry-After and gives up fast when it exceeds the configured ceiling', async () => {
    const transport = fakeTransport([status(503, { 'retry-after': '600' })]);
    const wrapped = withRetry(transport, { delay, maxAttempts: 3, maxRetryAfterMs: 10_000 });

    await expect(codeOf(wrapped.send(request(true)))).resolves.toBe(DELIVERY_UNAVAILABLE);
    expect(delay).not.toHaveBeenCalled();
  });

  it('lets the circuit breaker see every attempt, not just the first', async () => {
    // 5xx, 5xx, then success: with a threshold of 2 the breaker would open on
    // the second attempt if — and only if — it is consulted for each retry.
    const transport = fakeTransport([status(500), status(500), ok()]);
    const breaker = createCircuitBreaker({ failureThreshold: 2 });
    const wrapped = withRetry(withCircuitBreaker(transport, { breaker }), {
      delay,
      random: () => 1,
      maxAttempts: 3,
      baseBackoffMs: 1,
      maxBackoffMs: 1,
    });

    await expect(codeOf(wrapped.send(request(true)))).resolves.toBe(DELIVERY_UNAVAILABLE);
    // Two transient failures against a threshold of 2 opened the breaker
    // before a third attempt could even reach the transport.
    expect(transport.calls).toBe(2);
    expect(breaker.snapshot().state).toBe('open');
  });
});
