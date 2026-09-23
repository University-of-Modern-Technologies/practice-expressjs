import { describe, expect, it, jest } from '@jest/globals';

import { AppError } from '../../common/errors/index.js';
import {
  createHttpCallProvider,
  type CallProviderTransport,
  type CallProviderTransportResponse,
} from './http-provider.js';

const validRecord = {
  externalId: 'ext-1',
  direction: 'INBOUND',
  disposition: 'ANSWERED',
  fromNumber: '+14155551001',
  toNumber: '+14155550100',
  startedAt: '2026-01-01T09:00:00.000Z',
  durationSeconds: 58,
};

const transportThat = (
  send: (index: number) => CallProviderTransportResponse | Promise<never>,
): { transport: CallProviderTransport; calls: () => number } => {
  let index = 0;
  return {
    transport: {
      send: async () => {
        index += 1;
        return send(index);
      },
    },
    calls: () => index,
  };
};

const createProvider = (transport: CallProviderTransport) =>
  createHttpCallProvider({
    baseUrl: 'https://telephony.invalid',
    transport,
    maxAttempts: 2,
    backoffMs: 0,
    delay: jest.fn(async (_ms: number) => undefined),
  });

const unavailable = {
  statusCode: 502,
  code: 'CALL_PROVIDER_UNAVAILABLE',
} satisfies Partial<AppError>;

describe('http call provider', () => {
  it('returns the validated batch from a healthy response', async () => {
    const { transport } = transportThat(() => ({ status: 200, body: [validRecord] }));

    await expect(createProvider(transport).fetchCalls({ limit: 10 })).resolves.toEqual([
      validRecord,
    ]);
  });

  it('retries a transient status and succeeds on the next attempt', async () => {
    const { transport, calls } = transportThat((index) =>
      index === 1 ? { status: 503, body: undefined } : { status: 200, body: [validRecord] },
    );

    await expect(createProvider(transport).fetchCalls({ limit: 10 })).resolves.toHaveLength(1);
    expect(calls()).toBe(2);
  });

  it('reports a refused request as unavailable without repeating it', async () => {
    // A 4xx means our request was wrong; asking again changes nothing.
    const { transport, calls } = transportThat(() => ({ status: 403, body: undefined }));

    await expect(createProvider(transport).fetchCalls({ limit: 10 })).rejects.toMatchObject(
      unavailable,
    );
    expect(calls()).toBe(1);
  });

  it('treats a timeout on the wire as a transient failure', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const { transport, calls } = transportThat(() => Promise.reject(timeout));

    await expect(createProvider(transport).fetchCalls({ limit: 10 })).rejects.toMatchObject(
      unavailable,
    );
    expect(calls()).toBe(2);
  });

  it('refuses a batch that violates the contract instead of importing it', async () => {
    // A broken number imported once outlives the bad response it came in, so
    // the whole batch is rejected rather than half-trusted.
    const { transport, calls } = transportThat(() => ({
      status: 200,
      body: [{ ...validRecord, fromNumber: '415-555-1001' }],
    }));

    await expect(createProvider(transport).fetchCalls({ limit: 10 })).rejects.toMatchObject(
      unavailable,
    );
    expect(calls()).toBe(1);
  });
});
