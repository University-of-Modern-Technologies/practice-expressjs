// Index creation is covered by its own suite; here it only has to be observable,
// without a collection the mocked handshake never actually opened.
jest.mock('./event-log.model.js', () => ({
  ensureEventLogIndexes: jest.fn(async () => undefined),
  getDomainEventModel: jest.fn(() => ({ collection: {} })),
}));

import mongoose from 'mongoose';
import pino from 'pino';

import { createTestConfig } from '../test/config.js';
import {
  connectEventStore,
  createEventStoreReadinessCheck,
  disconnectEventStore,
} from './connection.js';
import { ensureEventLogIndexes } from './event-log.model.js';

const config = createTestConfig();
const logger = pino({ level: 'silent' });
const RETRY_DELAY_MS = 20;

const waitFor = async (condition: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition was not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const DISCONNECTED = 0;
const CONNECTED = 1;

// The driver is never reached: `connect` is replaced, and the state a real
// handshake would leave behind is set on the connection by hand.
const setReadyState = (state: number): void => {
  (mongoose.connection as { readyState: number }).readyState = state;
};

describe('event store connection', () => {
  beforeEach(() => {
    setReadyState(DISCONNECTED);
    jest.spyOn(mongoose, 'disconnect').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await disconnectEventStore();
    jest.restoreAllMocks();
    setReadyState(DISCONNECTED);
  });

  it('keeps retrying a store that is down at startup and turns ready once it answers', async () => {
    const connect = jest
      .spyOn(mongoose, 'connect')
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockImplementation(async () => {
        await Promise.resolve();
        setReadyState(CONNECTED);
        return mongoose;
      });
    const readiness = createEventStoreReadinessCheck();

    // Startup is not blocked and does not fail on the unreachable store.
    await expect(
      connectEventStore(config, logger, { retryDelayMs: RETRY_DELAY_MS }),
    ).resolves.toBeUndefined();
    await expect(readiness.check()).rejects.toThrow('Event store is disconnected');

    await waitFor(() => connect.mock.calls.length >= 3);
    await waitFor(() => mongoose.connection.readyState === CONNECTED);

    await expect(readiness.check()).resolves.toBeUndefined();
  });

  it('creates the indexes on the connection that finally succeeds, production included', async () => {
    jest
      .spyOn(mongoose, 'connect')
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(mongoose);

    await connectEventStore(createTestConfig({ appEnv: 'production' }), logger, {
      retryDelayMs: RETRY_DELAY_MS,
    });
    expect(ensureEventLogIndexes).not.toHaveBeenCalled();

    await waitFor(() => jest.mocked(ensureEventLogIndexes).mock.calls.length === 1);
  });

  it('never leaves index creation to the schema', async () => {
    const connect = jest.spyOn(mongoose, 'connect').mockResolvedValue(mongoose);

    await connectEventStore(createTestConfig({ appEnv: 'production' }), logger);

    expect(connect.mock.calls[0]?.[1]).toMatchObject({ autoIndex: false });
    expect(ensureEventLogIndexes).toHaveBeenCalledTimes(1);
  });

  it('stops retrying once the store is disconnected for shutdown', async () => {
    const connect = jest.spyOn(mongoose, 'connect').mockRejectedValue(new Error('ECONNREFUSED'));

    await connectEventStore(config, logger, { retryDelayMs: RETRY_DELAY_MS });
    await disconnectEventStore();
    const attempts = connect.mock.calls.length;

    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * 4));
    expect(connect.mock.calls.length).toBe(attempts);
  });
});
