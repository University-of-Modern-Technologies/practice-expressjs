import { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { AppConfig } from '../config/env.js';

// Reconnect backoff: grows linearly with the attempt count and is capped so a
// long outage never turns into a busy loop.
const RETRY_STEP_MS = 200;
const RETRY_MAX_DELAY_MS = 5_000;

// A command is abandoned after a couple of attempts instead of hanging: the
// cache layer is expected to fail open and fall back to the database.
const MAX_RETRIES_PER_REQUEST = 2;

const CONNECT_TIMEOUT_MS = 5_000;

export const createRedisClient = (config: AppConfig, logger: Logger): Redis => {
  // Unit tests build the whole application graph without infrastructure, so the
  // socket is opened on first use there instead of at construction time. That
  // keeps suites free of background reconnect timers that would outlive them.
  const isTest = config.nodeEnv === 'test';

  const client = new Redis(config.redisUrl, {
    keyPrefix: config.redisKeyPrefix,
    lazyConnect: isTest,
    maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,
    enableOfflineQueue: !isTest,
    connectTimeout: CONNECT_TIMEOUT_MS,
    retryStrategy: (times: number) => Math.min(times * RETRY_STEP_MS, RETRY_MAX_DELAY_MS),
  });

  // Without an `error` listener ioredis re-emits the failure on the process and
  // brings the API down; the cache is optional, so errors are only logged.
  client.on('error', (error: unknown) => {
    logger.error({ err: error }, 'Redis client error');
  });
  client.on('connect', () => {
    logger.debug('Redis connection established');
  });
  client.on('ready', () => {
    logger.info('Redis client ready');
  });
  client.on('reconnecting', (delayMs: number) => {
    logger.warn({ delayMs }, 'Reconnecting to Redis');
  });
  client.on('end', () => {
    logger.info('Redis connection closed');
  });

  return client;
};

export const disconnectRedis = async (client: Redis): Promise<void> => {
  // A client that never opened a socket would otherwise dial the server just to
  // deliver QUIT, leaving a live connection behind at shutdown.
  if (client.status === 'wait' || client.status === 'end') {
    client.disconnect();
    return;
  }

  try {
    // QUIT drains in-flight commands; a forced disconnect is the last resort.
    await client.quit();
  } catch {
    client.disconnect();
  }
};
