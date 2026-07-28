import { describe, expect, it, jest } from '@jest/globals';
import type { Logger } from 'pino';

import type { CacheRedis } from '../cache/index.js';
import { createTestConfig } from '../test/config.js';
import { MOCK_AI_PROVIDER_NAME } from '../modules/ai/mock-provider.js';
import { createInfraStack } from './index.js';

const fakeLogger = (): Logger =>
  ({ warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() }) as unknown as Logger;

const fakeRedis = (): CacheRedis =>
  ({
    get: jest.fn(async () => null),
    set: jest.fn(async () => 'OK'),
    del: jest.fn(async () => 0),
    scanStream: jest.fn(),
    options: { keyPrefix: '' },
  }) as unknown as CacheRedis;

describe('createInfraStack', () => {
  it('defaults to the live profile, matching the pre-existing per-component behaviour', () => {
    const stack = createInfraStack({
      config: createTestConfig(),
      redis: fakeRedis(),
      logger: fakeLogger(),
    });

    expect(stack.profile).toBe('live');
    expect(stack.aiProvider.name).toBe(MOCK_AI_PROVIDER_NAME);
  });

  it('forwards the configured endpoint and base URL when live', () => {
    const logger = fakeLogger();
    const stack = createInfraStack({
      config: createTestConfig({
        infraProfile: 'live',
        aiEndpointUrl: 'https://example.invalid/complete',
        deliveryBaseUrl: 'https://example.invalid/delivery',
      }),
      redis: fakeRedis(),
      logger,
    });

    expect(stack.aiProvider.name).not.toBe(MOCK_AI_PROVIDER_NAME);
    // Both settings are present, so neither factory falls back to its stand-in
    // and neither warns about running on one.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('forces every stand-in at once when offline, even with real settings configured', async () => {
    const logger = fakeLogger();
    const redis = fakeRedis();
    const stack = createInfraStack({
      config: createTestConfig({
        infraProfile: 'offline',
        aiEndpointUrl: 'https://example.invalid/complete',
        deliveryBaseUrl: 'https://example.invalid/delivery',
      }),
      redis,
      logger,
    });

    expect(stack.profile).toBe('offline');
    expect(stack.aiProvider.name).toBe(MOCK_AI_PROVIDER_NAME);

    // The cache never touches the Redis client it was handed.
    await stack.cache.set('some-key', 'value');
    await stack.cache.get('some-key');
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('uses the real cache in the live profile', async () => {
    const redis = fakeRedis();
    const stack = createInfraStack({
      config: createTestConfig({ infraProfile: 'live' }),
      redis,
      logger: fakeLogger(),
    });

    await stack.cache.set('some-key', 'value');
    expect(redis.set).toHaveBeenCalled();
  });
});
