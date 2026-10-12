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

describe('http call provider regressions', () => {
  const answering = (body: unknown) => transportThat(() => ({ status: 200, body })).transport;

  it.each(['', '   '])('reads an empty recording link %p as no recording', async (link) => {
    const provider = createProvider(answering([{ ...validRecord, recordingUrl: link }]));

    const [record] = await provider.fetchCalls({ limit: 10 });

    expect(record?.recordingUrl).toBeUndefined();
  });

  it('accepts null where a provider has no recording', async () => {
    const provider = createProvider(answering([{ ...validRecord, recordingUrl: null }]));

    const [record] = await provider.fetchCalls({ limit: 10 });

    expect(record?.recordingUrl).toBeUndefined();
  });

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'ftp://host/a.mp3', 'recordings/1'])(
    'refuses %p as a recording link',
    async (link) => {
      const provider = createProvider(answering([{ ...validRecord, recordingUrl: link }]));

      await expect(provider.fetchCalls({ limit: 10 })).rejects.toMatchObject(unavailable);
    },
  );

  it('refuses a batch longer than the limit it was asked for', async () => {
    const batch = [1, 2, 3].map((index) => ({ ...validRecord, externalId: `ext-${index}` }));
    const provider = createProvider(answering(batch));

    await expect(provider.fetchCalls({ limit: 2 })).rejects.toMatchObject(unavailable);
  });
});
