import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Logger } from 'pino';

import type { AppConfig } from '../config/env.js';

jest.mock('ioredis', () => {
  type Listener = (...args: unknown[]) => void;

  class FakeRedis {
    public static instances: FakeRedis[] = [];
    public readonly listeners = new Map<string, Listener>();
    public quitCalls = 0;
    public disconnectCalls = 0;
    public quitRejects = false;

    public constructor(
      public readonly url: string,
      public readonly options: Record<string, unknown>,
    ) {
      FakeRedis.instances.push(this);
    }

    public on(event: string, listener: Listener): this {
      this.listeners.set(event, listener);
      return this;
    }

    public emit(event: string, ...args: unknown[]): void {
      this.listeners.get(event)?.(...args);
    }

    public async quit(): Promise<void> {
      this.quitCalls += 1;
      if (this.quitRejects) throw new Error('quit failed');
    }

    public disconnect(): void {
      this.disconnectCalls += 1;
    }
  }

  return { __esModule: true, Redis: FakeRedis, default: FakeRedis };
});

interface FakeRedisInstance {
  url: string;
  options: Record<string, unknown>;
  quitCalls: number;
  disconnectCalls: number;
  quitRejects: boolean;
  emit(event: string, ...args: unknown[]): void;
}

const { Redis: FakeRedis } = jest.requireMock<{
  Redis: { instances: FakeRedisInstance[] };
}>('ioredis');

const config = {
  redisUrl: 'redis://localhost:6379',
  redisKeyPrefix: 'crm:',
} as AppConfig;

const createLogger = (): Logger =>
  ({
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  }) as unknown as Logger;

describe('redis client', () => {
  beforeEach(() => {
    FakeRedis.instances = [];
  });

  const lastInstance = (): (typeof FakeRedis.instances)[number] => {
    const instance = FakeRedis.instances.at(-1);
    if (!instance) throw new Error('No Redis client was constructed');
    return instance;
  };

  it('applies the configured url and key prefix', async () => {
    const { createRedisClient } = await import('./redis-client.js');
    createRedisClient(config, createLogger());

    expect(lastInstance().url).toBe('redis://localhost:6379');
    expect(lastInstance().options).toMatchObject({ keyPrefix: 'crm:', lazyConnect: false });
  });

  it('bounds retries per request and backs off with a capped delay', async () => {
    const { createRedisClient } = await import('./redis-client.js');
    createRedisClient(config, createLogger());

    const { maxRetriesPerRequest, retryStrategy } = lastInstance().options as {
      maxRetriesPerRequest: number;
      retryStrategy: (times: number) => number;
    };

    expect(maxRetriesPerRequest).toBeGreaterThan(0);
    expect(retryStrategy(1)).toBeLessThan(retryStrategy(5));
    expect(retryStrategy(1_000)).toBe(5_000);
  });

  it('logs connection errors instead of letting them escape', async () => {
    const logger = createLogger();
    const { createRedisClient } = await import('./redis-client.js');
    createRedisClient(config, logger);

    expect(() => {
      lastInstance().emit('error', new Error('ECONNREFUSED'));
    }).not.toThrow();
    expect(logger.error).toHaveBeenCalled();
  });

  it('closes the connection gracefully', async () => {
    const { createRedisClient, disconnectRedis } = await import('./redis-client.js');
    const client = createRedisClient(config, createLogger());

    await disconnectRedis(client);

    expect(lastInstance().quitCalls).toBe(1);
    expect(lastInstance().disconnectCalls).toBe(0);
  });

  it('forces a disconnect when a graceful quit fails', async () => {
    const { createRedisClient, disconnectRedis } = await import('./redis-client.js');
    const client = createRedisClient(config, createLogger());
    lastInstance().quitRejects = true;

    await expect(disconnectRedis(client)).resolves.toBeUndefined();

    expect(lastInstance().disconnectCalls).toBe(1);
  });
});
