import { Readable } from 'node:stream';

import { describe, expect, it, jest } from '@jest/globals';
import type { Logger } from 'pino';

import type { AppConfig } from '../config/env.js';
import { createCacheService, createNoopCacheService, type CacheRedis } from './cache.service.js';

const config = { cacheTtlSeconds: 300 } as AppConfig;

const createLogger = (): Logger =>
  ({
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  }) as unknown as Logger;

interface RedisStub {
  get: jest.Mock<(key: string) => Promise<string | null>>;
  set: jest.Mock<(key: string, value: string, mode: string, ttl: number) => Promise<string>>;
  del: jest.Mock<(...keys: string[]) => Promise<number>>;
  scanStream: jest.Mock<(options: { match: string; count?: number }) => Readable>;
  options: { keyPrefix?: string };
}

const createRedisStub = (overrides: Partial<RedisStub> = {}): RedisStub => ({
  get: jest.fn(async () => null),
  set: jest.fn(async () => 'OK'),
  del: jest.fn(async () => 1),
  scanStream: jest.fn(() => Readable.from([], { objectMode: true })),
  options: {},
  ...overrides,
});

const asCacheRedis = (stub: RedisStub): CacheRedis => stub as unknown as CacheRedis;

describe('cache service', () => {
  it('returns the parsed value on a hit', async () => {
    const redis = createRedisStub({ get: jest.fn(async () => JSON.stringify({ id: 'user-1' })) });
    const cache = createCacheService(asCacheRedis(redis), config, createLogger());

    await expect(cache.get<{ id: string }>('users:1')).resolves.toEqual({ id: 'user-1' });
  });

  it('returns null on a miss', async () => {
    const cache = createCacheService(asCacheRedis(createRedisStub()), config, createLogger());

    await expect(cache.get('users:1')).resolves.toBeNull();
  });

  it('drops a corrupt entry and reports a miss', async () => {
    const redis = createRedisStub({ get: jest.fn(async () => 'not-json') });
    const logger = createLogger();
    const cache = createCacheService(asCacheRedis(redis), config, logger);

    await expect(cache.get('users:1')).resolves.toBeNull();
    expect(redis.del).toHaveBeenCalledWith('users:1');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('writes with the configured default ttl', async () => {
    const redis = createRedisStub();
    const cache = createCacheService(asCacheRedis(redis), config, createLogger());

    await cache.set('users:1', { id: 'user-1' });

    expect(redis.set).toHaveBeenCalledWith('users:1', '{"id":"user-1"}', 'EX', 300);
  });

  it('writes with an explicit ttl when one is given', async () => {
    const redis = createRedisStub();
    const cache = createCacheService(asCacheRedis(redis), config, createLogger());

    await cache.set('users:1', 1, 30);

    expect(redis.set).toHaveBeenCalledWith('users:1', '1', 'EX', 30);
  });

  it('refuses to cache undefined', async () => {
    const redis = createRedisStub();
    const cache = createCacheService(asCacheRedis(redis), config, createLogger());

    await cache.set('users:1', undefined);

    expect(redis.set).not.toHaveBeenCalled();
  });

  it('fails open when a read throws', async () => {
    const redis = createRedisStub({
      get: jest.fn(async () => {
        throw new Error('connection refused');
      }),
    });
    const logger = createLogger();
    const cache = createCacheService(asCacheRedis(redis), config, logger);

    await expect(cache.get('users:1')).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('fails open when a write throws', async () => {
    const redis = createRedisStub({
      set: jest.fn(async () => {
        throw new Error('connection refused');
      }),
    });
    const cache = createCacheService(asCacheRedis(redis), config, createLogger());

    await expect(cache.set('users:1', { id: 'user-1' })).resolves.toBeUndefined();
  });

  it('fails open when a delete throws', async () => {
    const redis = createRedisStub({
      del: jest.fn(async () => {
        throw new Error('connection refused');
      }),
    });
    const cache = createCacheService(asCacheRedis(redis), config, createLogger());

    await expect(cache.del(['a', 'b'])).resolves.toBeUndefined();
  });

  it('skips the delete command for an empty key list', async () => {
    const redis = createRedisStub();
    const cache = createCacheService(asCacheRedis(redis), config, createLogger());

    await cache.del([]);

    expect(redis.del).not.toHaveBeenCalled();
  });

  describe('remember', () => {
    it('returns the cached value without calling the loader', async () => {
      const redis = createRedisStub({ get: jest.fn(async () => '{"value":1}') });
      const loader = jest.fn(async () => ({ value: 2 }));
      const cache = createCacheService(asCacheRedis(redis), config, createLogger());

      await expect(cache.remember('k', 60, loader)).resolves.toEqual({ value: 1 });
      expect(loader).not.toHaveBeenCalled();
    });

    it('loads and stores the value on a miss', async () => {
      const redis = createRedisStub();
      const loader = jest.fn(async () => ({ value: 2 }));
      const cache = createCacheService(asCacheRedis(redis), config, createLogger());

      await expect(cache.remember('k', 60, loader)).resolves.toEqual({ value: 2 });
      expect(loader).toHaveBeenCalledTimes(1);
      expect(redis.set).toHaveBeenCalledWith('k', '{"value":2}', 'EX', 60);
    });

    it('still returns the loaded value when Redis is unavailable', async () => {
      const redis = createRedisStub({
        get: jest.fn(async () => {
          throw new Error('down');
        }),
        set: jest.fn(async () => {
          throw new Error('down');
        }),
      });
      const cache = createCacheService(asCacheRedis(redis), config, createLogger());

      await expect(cache.remember('k', 60, async () => 'from-database')).resolves.toBe(
        'from-database',
      );
    });
  });

  describe('invalidatePrefix', () => {
    it('scans with the client key prefix and deletes unprefixed keys', async () => {
      const redis = createRedisStub({
        options: { keyPrefix: 'crm:' },
        scanStream: jest.fn(() =>
          Readable.from([['crm:rbac:user-permissions:a', 'crm:rbac:user-permissions:b']], {
            objectMode: true,
          }),
        ),
      });
      const cache = createCacheService(asCacheRedis(redis), config, createLogger());

      await cache.invalidatePrefix('rbac:user-permissions:');

      expect(redis.scanStream).toHaveBeenCalledWith({
        match: 'crm:rbac:user-permissions:*',
        count: 200,
      });
      expect(redis.del).toHaveBeenCalledWith('rbac:user-permissions:a', 'rbac:user-permissions:b');
    });

    it('never issues the blocking KEYS command', () => {
      const redis = createRedisStub();

      expect(redis).not.toHaveProperty('keys');
    });

    it('ignores empty scan batches', async () => {
      const redis = createRedisStub({
        scanStream: jest.fn(() => Readable.from([[]], { objectMode: true })),
      });
      const cache = createCacheService(asCacheRedis(redis), config, createLogger());

      await cache.invalidatePrefix('rbac:');

      expect(redis.del).not.toHaveBeenCalled();
    });

    it('fails open when the scan stream errors', async () => {
      const stream = new Readable({ objectMode: true, read: () => undefined });
      const redis = createRedisStub({ scanStream: jest.fn(() => stream) });
      const logger = createLogger();
      const cache = createCacheService(asCacheRedis(redis), config, logger);

      const pending = cache.invalidatePrefix('rbac:');
      stream.destroy(new Error('scan failed'));

      await expect(pending).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });
  });
});

describe('noop cache service', () => {
  it('always misses and runs the loader', async () => {
    const cache = createNoopCacheService();
    const loader = jest.fn(async () => 'value');

    await expect(cache.get('k')).resolves.toBeNull();
    await expect(cache.set('k', 1)).resolves.toBeUndefined();
    await expect(cache.remember('k', 60, loader)).resolves.toBe('value');
    await expect(cache.remember('k', 60, loader)).resolves.toBe('value');
    expect(loader).toHaveBeenCalledTimes(2);
    await expect(cache.del('k')).resolves.toBeUndefined();
    await expect(cache.invalidatePrefix('k:')).resolves.toBeUndefined();
  });
});
