import type { AppConfig } from '../config/env.js';

/**
 * Builds a fully populated configuration for unit tests so that adding a new
 * setting does not require touching every test that needs a config object.
 * The values point at loopback addresses only and are never used to reach a
 * real dependency: unit tests mock every client built from them.
 */
const baseTestConfig: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
  corsOrigins: ['http://localhost:5173'],
  jsonBodyLimit: '1mb',
  databaseUrl: 'postgresql://postgres:postgres@localhost:5432/practice_crm_test?schema=public',
  jwtAccessSecret: 'test-access-secret-with-at-least-32-characters',
  jwtRefreshSecret: 'test-refresh-secret-with-at-least-32-characters',
  redisUrl: 'redis://localhost:6379',
  redisKeyPrefix: 'crm-test:',
  cacheTtlSeconds: 300,
  rateLimitWindowSeconds: 60,
  rateLimitMaxRequests: 300,
  authRateLimitMaxRequests: 10,
  mongodbUrl: 'mongodb://localhost:27017/practice_events_test',
  eventLogRetentionDays: 90,
  wsPath: '/api/v1/realtime',
  shutdownGracePeriodMs: 10_000,
  shutdownTimeoutMs: 15_000,
  shutdownDrainDelayMs: 0,
  deliveryTimeoutMs: 5_000,
  deliveryMaxAttempts: 3,
  deliveryBaseBackoffMs: 100,
  deliveryMaxBackoffMs: 1_000,
  deliveryFailureThreshold: 5,
  deliveryCooldownMs: 30_000,
  deliveryQuoteCacheTtlSeconds: 60,
  aiTimeoutMs: 10_000,
  aiMaxAttempts: 2,
  aiMaxTokens: 400,
  aiMaxInputChars: 4_000,
  aiCacheTtlSeconds: 300,
  callProviderTimeoutMs: 5_000,
  callProviderMaxAttempts: 3,
  callProviderBackoffMs: 200,
  callSyncBatchSize: 100,
};

export const createTestConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  ...baseTestConfig,
  ...overrides,
});
