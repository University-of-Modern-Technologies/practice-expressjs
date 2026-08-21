import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { AppConfig } from '../config/env.js';

// Only the commands the cache actually needs are required, which keeps the
// service trivially testable with a plain object stand-in.
export type CacheRedis = Pick<Redis, 'get' | 'set' | 'del' | 'scanStream' | 'options'>;

export interface CacheService {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  remember<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T>;
  del(keys: string | readonly string[]): Promise<void>;
  invalidatePrefix(prefix: string): Promise<void>;
}

const SCAN_BATCH_SIZE = 200;

export const createCacheService = (
  redis: CacheRedis,
  config: AppConfig,
  logger: Logger,
): CacheService => {
  // ioredis prepends `keyPrefix` to key arguments but never to SCAN patterns,
  // and it never strips it from replies. Both directions are handled here.
  const keyPrefix = redis.options.keyPrefix ?? '';
  const stripKeyPrefix = (key: string): string =>
    key.startsWith(keyPrefix) ? key.slice(keyPrefix.length) : key;

  const service: CacheService = {
    async get<T>(key: string): Promise<T | null> {
      let raw: string | null;
      try {
        raw = await redis.get(key);
      } catch (error) {
        // Fail open: an unreachable cache must never break a request.
        logger.warn({ err: error, key }, 'Cache read failed, falling back to the source');
        return null;
      }
      if (raw === null) return null;

      try {
        return JSON.parse(raw) as T;
      } catch (error) {
        logger.warn({ err: error, key }, 'Discarding corrupt cache entry');
        await service.del(key);
        return null;
      }
    },

    async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
      if (value === undefined) {
        logger.warn({ key }, 'Refusing to cache an undefined value');
        return;
      }
      try {
        await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds ?? config.cacheTtlSeconds);
      } catch (error) {
        logger.warn({ err: error, key }, 'Cache write failed');
      }
    },

    async remember<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
      const cached = await service.get<T>(key);
      if (cached !== null) return cached;

      const value = await loader();
      await service.set(key, value, ttlSeconds);
      return value;
    },

    async del(keys: string | readonly string[]): Promise<void> {
      const list = typeof keys === 'string' ? [keys] : [...keys];
      if (list.length === 0) return;
      try {
        await redis.del(...list);
      } catch (error) {
        logger.warn({ err: error, keys: list }, 'Cache delete failed');
      }
    },

    async invalidatePrefix(prefix: string): Promise<void> {
      try {
        // SCAN is used instead of KEYS so a large keyspace never blocks Redis.
        const stream = redis.scanStream({
          match: `${keyPrefix}${prefix}*`,
          count: SCAN_BATCH_SIZE,
        });

        await new Promise<void>((resolve, reject) => {
          stream.on('data', (batch: string[]) => {
            if (batch.length === 0) return;
            // Pausing keeps memory bounded and guarantees `end` fires last.
            stream.pause();
            void service.del(batch.map(stripKeyPrefix)).finally(() => {
              stream.resume();
            });
          });
          stream.on('error', reject);
          stream.on('end', resolve);
        });
      } catch (error) {
        logger.warn({ err: error, prefix }, 'Cache prefix invalidation failed');
      }
    },
  };

  return service;
};

// Fallback used by services that are constructed without a cache, for example
// in unit tests. Every read is a miss and every write is discarded.
export const createNoopCacheService = (): CacheService => ({
  async get() {
    return null;
  },
  async set() {
    // Intentionally empty: nothing is stored.
  },
  async remember(_key, _ttlSeconds, loader) {
    return loader();
  },
  async del() {
    // Intentionally empty: nothing is stored.
  },
  async invalidatePrefix() {
    // Intentionally empty: nothing is stored.
  },
});
