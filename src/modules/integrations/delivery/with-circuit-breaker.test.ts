import { describe, expect, it, jest } from '@jest/globals';

import { createCircuitBreaker } from './circuit-breaker.js';
import type { DeliveryTransport, DeliveryTransportResponse } from './transport.js';
import { CircuitOpenError, withCircuitBreaker } from './with-circuit-breaker.js';

const ok: DeliveryTransportResponse = { status: 200, headers: {}, body: { ok: true } };
const serverError: DeliveryTransportResponse = { status: 500, headers: {}, body: {} };
const clientError: DeliveryTransportResponse = { status: 400, headers: {}, body: {} };

interface FakeTransport extends DeliveryTransport {
  readonly calls: number;
}

const fakeTransport = (script: ReadonlyArray<DeliveryTransportResponse | Error>): FakeTransport => {
  let index = 0;
  return {
    kind: 'http',
    get calls() {
      return index;
    },
    send() {
      const next = script[Math.min(index, script.length - 1)];
      index += 1;
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next as DeliveryTransportResponse);
    },
  };
};

const request = {
  method: 'GET' as const,
  path: '/v1/shipments/1',
  signal: new AbortController().signal,
};

describe('withCircuitBreaker', () => {
  it('passes a successful response through untouched and reports success', () => {
    const breaker = createCircuitBreaker();
    const wrapped = withCircuitBreaker(fakeTransport([ok]), { breaker });

    return expect(wrapped.send(request)).resolves.toEqual(ok);
  });

  it('reports 5xx and network failures to the breaker but still returns/throws them', async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 2 });
    const wrapped = withCircuitBreaker(fakeTransport([serverError]), { breaker });

    await expect(wrapped.send(request)).resolves.toEqual(serverError);
    expect(breaker.snapshot().consecutiveFailures).toBe(1);
  });

  it('does not open the breaker on a 4xx: the service is alive, we are wrong', async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 1 });
    const wrapped = withCircuitBreaker(fakeTransport([clientError]), { breaker });

    await expect(wrapped.send(request)).resolves.toEqual(clientError);
    expect(breaker.snapshot().state).toBe('closed');
    expect(breaker.snapshot().consecutiveFailures).toBe(0);
  });

  it('short-circuits with CircuitOpenError once the breaker is open, without touching the transport', async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 1 });
    const transport = fakeTransport([serverError]);
    const wrapped = withCircuitBreaker(transport, { breaker });

    // First call trips the breaker open.
    await wrapped.send(request);
    expect(breaker.snapshot().state).toBe('open');

    const callsBefore = transport.calls;
    await expect(wrapped.send(request)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(transport.calls).toBe(callsBefore);
  });

  it('logs a warning when short-circuiting', async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 1 });
    const warn = jest.fn();
    const wrapped = withCircuitBreaker(fakeTransport([serverError]), {
      breaker,
      logger: { warn } as never,
    });

    await wrapped.send(request);
    await expect(wrapped.send(request)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(warn).toHaveBeenCalled();
  });
});
