import mongoose from 'mongoose';
import type { Logger } from 'pino';

import type { ReadinessCheck } from '../app/health/health.routes.js';
import type { AppConfig } from '../config/env.js';
import { ensureEventLogIndexes, getDomainEventModel } from './event-log.model.js';

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

/** Pause between handshakes while the store is unreachable. Same in both bases. */
export const EVENT_STORE_RETRY_DELAY_MS = 5_000;

export interface EventStoreConnectOptions {
  /** Overrides {@link EVENT_STORE_RETRY_DELAY_MS}; tests shorten it. */
  readonly retryDelayMs?: number;
}

let connectionPromise: Promise<void> | null = null;
let listenersBound = false;
let retryTimer: NodeJS.Timeout | null = null;
// Set by `disconnectEventStore`: a retry scheduled before shutdown must not
// reopen the connection afterwards.
let stopped = false;

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

const createIndexes = async (config: AppConfig, logger: Logger): Promise<void> => {
  try {
    await ensureEventLogIndexes(
      getDomainEventModel().collection,
      config.eventLogRetentionDays,
      logger,
    );
  } catch (error) {
    // Appends still work without the indexes; only reads slow down and the
    // retention window stops being enforced, which is what the log line says.
    logger.error({ err: error }, 'Failed to create the event log indexes');
  }
};

const clearRetry = (): void => {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
};

const attemptConnection = async (
  config: AppConfig,
  logger: Logger,
  retryDelayMs: number,
): Promise<void> => {
  connectionPromise ??= mongoose
    .connect(config.mongodbUrl, {
      serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
      connectTimeoutMS: CONNECT_TIMEOUT_MS,
      socketTimeoutMS: SOCKET_TIMEOUT_MS,
      maxPoolSize: MAX_POOL_SIZE,
      // Fail fast instead of queueing writes while the store is unreachable.
      bufferCommands: false,
      // Indexes are created explicitly below, in every environment.
      autoIndex: false,
    })
    .then(async () => {
      if (stopped) {
        // Shutdown began while the handshake was in flight.
        await mongoose.disconnect();
        return;
      }
      await createIndexes(config, logger);
    });

  try {
    await connectionPromise;
  } catch (error) {
    // Unlike a dropped connection, a failed first handshake is never retried
    // by the driver: it is retried here, in the background, until it succeeds.
    connectionPromise = null;
    logger.error(
      { err: error, retryInMs: retryDelayMs },
      'Failed to connect to the event store; retrying in the background',
    );
    if (stopped) return;
    clearRetry();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void attemptConnection(config, logger, retryDelayMs);
    }, retryDelayMs);
    // A pending retry must not keep the process alive on its own.
    retryTimer.unref();
  }
};

/**
 * Idempotent connect that never throws: a missing MongoDB must not prevent the
 * API from starting. A failed handshake is retried in the background with a
 * pause, so the store comes up later on its own and readiness turns green as
 * soon as it does; the indexes are created on that first successful connect.
 */
export const connectEventStore = async (
  config: AppConfig,
  logger: Logger,
  options: EventStoreConnectOptions = {},
): Promise<void> => {
  stopped = false;
  bindConnectionListeners(logger);
  await attemptConnection(config, logger, options.retryDelayMs ?? EVENT_STORE_RETRY_DELAY_MS);
};

export const disconnectEventStore = async (): Promise<void> => {
  stopped = true;
  clearRetry();
  connectionPromise = null;
  listenersBound = false;
  await mongoose.disconnect();
};

export const getEventStoreConnectionState = (): EventStoreConnectionState =>
  readyStates[mongoose.connection.readyState] ?? 'uninitialized';

export const isEventStoreConnected = (): boolean => getEventStoreConnectionState() === 'connected';

/** Readiness probe for `/api/health/ready`. */
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
