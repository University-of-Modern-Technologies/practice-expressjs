import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { AppError } from '../../../common/errors/app-error.js';
import { createDeliveryClient, parseRetryAfterMs } from './client.js';
import {
  DELIVERY_INVALID_RESPONSE,
  DELIVERY_REJECTED,
  DELIVERY_TIMEOUT,
  DELIVERY_UNAVAILABLE,
} from './errors.js';
import type { DeliveryTransport, DeliveryTransportResponse } from './transport.js';

const validQuote = {
  quote_id: 'qte_1',
  carrier: 'Test Carrier',
  service: 'standard',
  amount: '12.50',
  currency: 'eur',
  estimated_days: 3,
  expires_at: '2026-01-01T00:00:00.000Z',
};

const validShipment = {
  shipment_id: 'shp_1',
  order_id: 'ord_1',
  status: 'CREATED',
  carrier: 'Test Carrier',
  tracking_number: 'TRK1',
  created_at: '2026-01-01T00:00:00.000Z',
  estimated_delivery_at: null,
};

const ok = (body: unknown): DeliveryTransportResponse => ({ status: 200, headers: {}, body });

const status = (code: number, headers: Record<string, string> = {}): DeliveryTransportResponse => ({
  status: code,
  headers,
  body: { error: 'upstream detail' },
});

interface FakeTransport extends DeliveryTransport {
  readonly calls: number;
}

/** Replays a scripted sequence; an `Error` entry is thrown instead of returned. */
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

const timeoutError = (): Error => {
  const error = new Error('The operation was aborted due to timeout');
  error.name = 'TimeoutError';
  return error;
};

const quoteRequest = {
  orderId: 'ord_1',
  origin: { country: 'PL', city: 'Warsaw', postalCode: '00-001', line1: 'Street 1' },
  destination: { country: 'DE', city: 'Berlin', postalCode: '10115', line1: 'Street 2' },
  parcel: { weightGrams: 1_000, lengthCm: 10, widthCm: 10, heightCm: 10 },
};

const shipmentRequest = {
  quoteId: 'qte_1',
  orderId: 'ord_1',
  destination: quoteRequest.destination,
  parcel: quoteRequest.parcel,
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

describe('delivery client', () => {
  let delay: jest.Mock<(ms: number) => Promise<void>>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    delay = jest.fn(() => Promise.resolve());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const clientFor = (
    transport: DeliveryTransport,
    overrides: Partial<Parameters<typeof createDeliveryClient>[0]> = {},
  ) =>
    createDeliveryClient({
      transport,
      delay,
      // Fixed jitter keeps the asserted backoff values deterministic.
      random: () => 1,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      ...overrides,
    });

  it('retries an idempotent call on 5xx and succeeds', async () => {
    const transport = fakeTransport([status(503), status(500), ok(validQuote)]);
    const client = clientFor(transport);

    await expect(client.requestQuote(quoteRequest)).resolves.toMatchObject({
      quoteId: 'qte_1',
      currency: 'EUR',
    });
    expect(transport.calls).toBe(3);
    // Full jitter with `random() === 1` gives the whole exponential window.
    expect(delay.mock.calls).toEqual([[100], [200]]);
  });

  it('does not retry a 4xx client error and reports it as rejected', async () => {
    const transport = fakeTransport([status(400)]);
    const client = clientFor(transport);

    await expect(codeOf(client.requestQuote(quoteRequest))).resolves.toBe(DELIVERY_REJECTED);
    expect(transport.calls).toBe(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it('never leaks the upstream body in the error surfaced to the caller', async () => {
    const client = clientFor(fakeTransport([status(400)]));

    await expect(client.requestQuote(quoteRequest)).rejects.toMatchObject({
      statusCode: 422,
      message: 'The delivery service rejected the request',
      details: undefined,
    });
  });

  it('maps an upstream 404 to a 404 rejection', async () => {
    const client = clientFor(fakeTransport([status(404)]));

    await expect(client.getShipment('missing')).rejects.toMatchObject({
      statusCode: 404,
      code: DELIVERY_REJECTED,
    });
  });

  it('translates an exhausted timeout into DELIVERY_TIMEOUT', async () => {
    const transport = fakeTransport([timeoutError(), timeoutError(), timeoutError()]);
    const client = clientFor(transport);

    await expect(codeOf(client.requestQuote(quoteRequest))).resolves.toBe(DELIVERY_TIMEOUT);
    expect(transport.calls).toBe(3);
  });

  it('does not retry a non-idempotent call after a timeout', async () => {
    const transport = fakeTransport([timeoutError(), ok(validShipment)]);
    const client = clientFor(transport);

    await expect(codeOf(client.createShipment(shipmentRequest))).resolves.toBe(DELIVERY_TIMEOUT);
    // Replaying a shipment creation could dispatch the parcel twice.
    expect(transport.calls).toBe(1);
  });

  it('translates a network error into DELIVERY_UNAVAILABLE', async () => {
    const client = clientFor(fakeTransport([new Error('ECONNRESET')]), { maxAttempts: 1 });

    await expect(codeOf(client.requestQuote(quoteRequest))).resolves.toBe(DELIVERY_UNAVAILABLE);
  });

  it('waits exactly as long as Retry-After asks', async () => {
    const transport = fakeTransport([status(429, { 'retry-after': '2' }), ok(validQuote)]);
    const client = clientFor(transport);

    await client.requestQuote(quoteRequest);
    expect(delay).toHaveBeenCalledWith(2_000);
  });

  it('accepts an HTTP-date Retry-After', () => {
    const nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    expect(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:05 GMT', nowMs)).toBe(5_000);
    expect(parseRetryAfterMs('not-a-date', nowMs)).toBeNull();
    expect(parseRetryAfterMs(undefined, nowMs)).toBeNull();
  });

  it('gives up instead of waiting out an unreasonable Retry-After', async () => {
    const client = clientFor(fakeTransport([status(503, { 'retry-after': '600' })]), {
      maxRetryAfterMs: 10_000,
    });

    await expect(codeOf(client.requestQuote(quoteRequest))).resolves.toBe(DELIVERY_UNAVAILABLE);
    expect(delay).not.toHaveBeenCalled();
  });

  it('rejects a malformed upstream payload with DELIVERY_INVALID_RESPONSE', async () => {
    const client = clientFor(fakeTransport([ok({ ...validQuote, estimated_days: 'three' })]));

    await expect(codeOf(client.requestQuote(quoteRequest))).resolves.toBe(
      DELIVERY_INVALID_RESPONSE,
    );
  });

  it('rejects a payload that lost a required field', async () => {
    const { quote_id: _removed, ...withoutId } = validQuote;
    const client = clientFor(fakeTransport([ok(withoutId)]));

    await expect(codeOf(client.requestQuote(quoteRequest))).resolves.toBe(
      DELIVERY_INVALID_RESPONSE,
    );
  });

  describe('circuit breaker', () => {
    it('opens after the failure threshold and short-circuits further calls', async () => {
      const transport = fakeTransport([status(500)]);
      const client = clientFor(transport, { maxAttempts: 1, failureThreshold: 2 });

      await expect(codeOf(client.requestQuote(quoteRequest))).resolves.toBe(DELIVERY_UNAVAILABLE);
      expect(client.health().circuitState).toBe('closed');

      await expect(codeOf(client.requestQuote(quoteRequest))).resolves.toBe(DELIVERY_UNAVAILABLE);
      expect(client.health().circuitState).toBe('open');

      const callsBefore = transport.calls;
      await expect(codeOf(client.requestQuote(quoteRequest))).resolves.toBe(DELIVERY_UNAVAILABLE);
      // The third call never reached the network.
      expect(transport.calls).toBe(callsBefore);
    });

    it('recovers through half-open when the probe succeeds', async () => {
      const transport = fakeTransport([status(500), status(500), ok(validQuote)]);
      const client = clientFor(transport, {
        maxAttempts: 1,
        failureThreshold: 2,
        cooldownMs: 30_000,
      });

      await expect(client.requestQuote(quoteRequest)).rejects.toThrow(AppError);
      await expect(client.requestQuote(quoteRequest)).rejects.toThrow(AppError);
      expect(client.health().circuitState).toBe('open');

      jest.advanceTimersByTime(29_999);
      await expect(codeOf(client.requestQuote(quoteRequest))).resolves.toBe(DELIVERY_UNAVAILABLE);
      expect(transport.calls).toBe(2);

      jest.advanceTimersByTime(2);
      await expect(client.requestQuote(quoteRequest)).resolves.toMatchObject({ quoteId: 'qte_1' });
      expect(transport.calls).toBe(3);
      expect(client.health().circuitState).toBe('closed');
      expect(client.health().consecutiveFailures).toBe(0);
    });

    it('re-opens when the half-open probe fails again', async () => {
      const transport = fakeTransport([status(500)]);
      const client = clientFor(transport, {
        maxAttempts: 1,
        failureThreshold: 1,
        cooldownMs: 10_000,
      });

      await expect(client.requestQuote(quoteRequest)).rejects.toThrow(AppError);
      expect(client.health().circuitState).toBe('open');

      jest.advanceTimersByTime(10_000);
      await expect(client.requestQuote(quoteRequest)).rejects.toThrow(AppError);
      expect(client.health().circuitState).toBe('open');
      expect(client.health().openedAt).toBe('2026-01-01T00:00:10.000Z');
    });

    it('keeps the circuit closed when the upstream only rejects our requests', async () => {
      const client = clientFor(fakeTransport([status(400)]), {
        maxAttempts: 1,
        failureThreshold: 2,
      });

      await expect(client.requestQuote(quoteRequest)).rejects.toThrow(AppError);
      await expect(client.requestQuote(quoteRequest)).rejects.toThrow(AppError);
      expect(client.health().circuitState).toBe('closed');
    });
  });

  it('reports health without exposing any upstream detail', async () => {
    const client = clientFor(fakeTransport([status(500)]), { maxAttempts: 1, failureThreshold: 1 });
    await expect(client.requestQuote(quoteRequest)).rejects.toThrow(AppError);

    expect(client.health()).toEqual({
      transport: 'http',
      circuitState: 'open',
      consecutiveFailures: 1,
      lastErrorAt: '2026-01-01T00:00:00.000Z',
      openedAt: '2026-01-01T00:00:00.000Z',
    });
  });
});
