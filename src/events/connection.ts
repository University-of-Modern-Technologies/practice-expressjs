import mongoose from 'mongoose';
import type { Logger } from 'pino';

import type { ReadinessCheck } from '../app/health/health.routes.js';
import type { AppConfig } from '../config/env.js';

export type EventStoreConnectionState =
  'disconnected' | 'connected' | 'connecting' | 'disconnecting' | 'uninitialized';

const readyStates: Record<number, EventStoreConnectionState> = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
  99: 'uninitialized',
};

const SERVER_SELECTION_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 45_000;
const MAX_POOL_SIZE = 10;

let connectionPromise: Promise<void> | null = null;
let listenersBound = false;

const bindConnectionListeners = (logger: Logger): void => {
  if (listenersBound) return;
  listenersBound = true;

  const connection = mongoose.connection;

  // The event store is complementary storage: losing it must degrade, not crash.
  connection.on('error', (error: unknown) => {
    logger.error({ err: error }, 'Event store connection error');
  });
  connection.on('connected', () => {
    logger.info('Event store connected');
  });
  connection.on('disconnected', () => {
    logger.warn('Event store disconnected');
  });
  connection.on('reconnected', () => {
    logger.info('Event store reconnected');
  });
};

/**
 * Idempotent connect. Failures are logged and swallowed so a missing MongoDB never
 * prevents the API from starting; mongoose keeps retrying in the background.
 */
export const connectEventStore = async (config: AppConfig, logger: Logger): Promise<void> => {
  bindConnectionListeners(logger);

  connectionPromise ??= mongoose
    .connect(config.mongodbUrl, {
      serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
      connectTimeoutMS: CONNECT_TIMEOUT_MS,
      socketTimeoutMS: SOCKET_TIMEOUT_MS,
      maxPoolSize: MAX_POOL_SIZE,
      // Fail fast instead of queueing writes while the store is unreachable.
      bufferCommands: false,
      autoIndex: config.nodeEnv !== 'production',
    })
    .then(() => undefined);

  try {
    await connectionPromise;
  } catch (error) {
    // Allow a later call to retry the initial handshake.
    connectionPromise = null;
    logger.error({ err: error }, 'Failed to connect to the event store');
  }
};

export const disconnectEventStore = async (): Promise<void> => {
  connectionPromise = null;
  listenersBound = false;
  await mongoose.disconnect();
};

export const getEventStoreConnectionState = (): EventStoreConnectionState =>
  readyStates[mongoose.connection.readyState] ?? 'uninitialized';

export const isEventStoreConnected = (): boolean => getEventStoreConnectionState() === 'connected';

/** Readiness probe for `/health/ready`. */
export const createEventStoreReadinessCheck = (): ReadinessCheck => ({
  name: 'event-store',
  check: async (): Promise<void> => {
    const state = getEventStoreConnectionState();
    if (state !== 'connected') {
      throw new Error(`Event store is ${state}`);
    }
    await Promise.resolve();
  },
});
