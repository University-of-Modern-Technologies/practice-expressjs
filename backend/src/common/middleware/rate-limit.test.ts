import type { NextFunction, Request, Response } from 'express';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import type { Logger } from 'pino';

import type { AppConfig } from '../../config/env.js';
import { AppError } from '../errors/app-error.js';

jest.mock('express-rate-limit', () => {
  const calls: unknown[] = [];
  return {
    __esModule: true,
    __calls: calls,
    rateLimit: (options: unknown) => {
      calls.push(options);
      return () => undefined;
    },
    // Mirrors the real helper closely enough to assert it was applied.
    ipKeyGenerator: (ip: string, subnet: number) => `${ip}/${String(subnet)}`,
  };
});

jest.mock('rate-limit-redis', () => {
  class RedisStore {
    public constructor(public readonly options: Record<string, unknown>) {}
  }
  return { __esModule: true, RedisStore, default: RedisStore };
});

const { __calls: rateLimitCalls } = jest.requireMock<{ __calls: RateLimitOptions[] }>(
  'express-rate-limit',
);

interface RateLimitOptions {
  windowMs: number;
  limit: number;
  standardHeaders: string;
  legacyHeaders: boolean;
  passOnStoreError: boolean;
  skip: (request?: Request) => boolean;
  keyGenerator: (request: Request) => string;
  handler: (request: Request, response: Response, next: NextFunction) => void;
  store: { options: { prefix: string; sendCommand: (...args: string[]) => unknown } };
}

const baseConfig = {
  appEnv: 'production',
  redisKeyPrefix: 'crm:',
  rateLimitWindowSeconds: 60,
  rateLimitMaxRequests: 300,
  authRateLimitMaxRequests: 10,
  jwtAccessSecret: 'rate-limit-test-access-secret-of-32-chars',
} as AppConfig;

const accessToken = (
  claims: Record<string, unknown>,
  secret = baseConfig.jwtAccessSecret,
): string => jwt.sign(claims, secret, { expiresIn: 60 });

const createLogger = (): Logger =>
  ({ warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }) as unknown as Logger;

const createRedis = (): { call: jest.Mock<(...args: string[]) => Promise<string>> } => ({
  call: jest.fn(() => Promise.resolve('ok')),
});

const lastOptions = (): RateLimitOptions => {
  const options = rateLimitCalls.at(-1);
  if (!options) throw new Error('The rate limiter was not configured');
  return options;
};

const requestWith = (overrides: Partial<Request>): Request => overrides as Request;

describe('rate limit middleware', () => {
  beforeEach(() => {
    rateLimitCalls.length = 0;
  });

  it('uses the configured window and request budget', async () => {
    const { createRateLimiter } = await import('./rate-limit.js');
    createRateLimiter(createRedis(), baseConfig, createLogger());

    expect(lastOptions().windowMs).toBe(60_000);
    expect(lastOptions().limit).toBe(300);
  });

  it('uses the stricter auth budget for the auth limiter', async () => {
    const { createAuthRateLimiter } = await import('./rate-limit.js');
    createAuthRateLimiter(createRedis(), baseConfig, createLogger());

    expect(lastOptions().limit).toBe(10);
  });

  it('emits draft-7 headers and disables the legacy ones', async () => {
    const { createRateLimiter } = await import('./rate-limit.js');
    createRateLimiter(createRedis(), baseConfig, createLogger());

    expect(lastOptions().standardHeaders).toBe('draft-7');
    expect(lastOptions().legacyHeaders).toBe(false);
  });

  it('fails open when the store is unavailable', async () => {
    const { createRateLimiter } = await import('./rate-limit.js');
    createRateLimiter(createRedis(), baseConfig, createLogger());

    expect(lastOptions().passOnStoreError).toBe(true);
  });

  it('is disabled in the test environment', async () => {
    const { createRateLimiter } = await import('./rate-limit.js');

    createRateLimiter(createRedis(), baseConfig, createLogger());
    expect(lastOptions().skip()).toBe(false);

    createRateLimiter(createRedis(), { ...baseConfig, appEnv: 'test' }, createLogger());
    expect(lastOptions().skip()).toBe(true);
  });

  it('keys by the user of a valid access token, before any route authenticates', async () => {
    const { createRateLimiter } = await import('./rate-limit.js');
    createRateLimiter(createRedis(), baseConfig, createLogger());

    const token = accessToken({ type: 'access', sub: 'user-1', sessionId: 'session-1' });
    const key = lastOptions().keyGenerator(
      requestWith({ headers: { authorization: `bearer ${token}` }, ip: '10.0.0.1' }),
    );

    expect(key).toBe('user:user-1');
  });

  it('falls back to the address for a token it cannot trust', async () => {
    const { createRateLimiter } = await import('./rate-limit.js');
    createRateLimiter(createRedis(), baseConfig, createLogger());

    const foreign = accessToken(
      { type: 'access', sub: 'u' },
      'another-secret-of-at-least-32-chars',
    );
    const unusable = [
      'Bearer not-a-token',
      `Bearer ${foreign}`,
      `Bearer ${accessToken({ type: 'refresh', sub: 'user-1' })}`,
      `Basic ${accessToken({ type: 'access', sub: 'user-1' })}`,
    ];
    for (const authorization of unusable) {
      const key = lastOptions().keyGenerator(
        requestWith({ headers: { authorization }, ip: '10.0.0.1' }),
      );
      expect(key).toBe('10.0.0.1/64');
    }
  });

  it('falls back to the normalized client ip for anonymous requests', async () => {
    const { createRateLimiter } = await import('./rate-limit.js');
    createRateLimiter(createRedis(), baseConfig, createLogger());

    expect(lastOptions().keyGenerator(requestWith({ headers: {}, ip: '10.0.0.1' }))).toBe(
      '10.0.0.1/64',
    );
  });

  it('leaves reading and ending a session out of the strict auth budget', async () => {
    const { createAuthRateLimiter, isAuthBudgetExempt } = await import('./rate-limit.js');
    createAuthRateLimiter(createRedis(), baseConfig, createLogger());

    const at = (path: string): Request => requestWith({ baseUrl: '/api/v1/auth', path });
    expect(lastOptions().skip(at('/me'))).toBe(true);
    expect(lastOptions().skip(at('/logout/'))).toBe(true);
    expect(lastOptions().skip(at('/login'))).toBe(false);
    expect(lastOptions().skip(at('/refresh'))).toBe(false);
    expect(isAuthBudgetExempt('/API/v1/auth/ME')).toBe(true);
  });

  it('keeps every path under the general budget', async () => {
    const { createRateLimiter } = await import('./rate-limit.js');
    createRateLimiter(createRedis(), baseConfig, createLogger());

    const me = requestWith({ baseUrl: '', path: '/api/v1/auth/me' });
    expect(lastOptions().skip(me)).toBe(false);
  });

  it('rejects with the standard error envelope code', async () => {
    const logger = createLogger();
    const { createRateLimiter } = await import('./rate-limit.js');
    createRateLimiter(createRedis(), baseConfig, logger);

    const next = jest.fn();
    lastOptions().handler(
      requestWith({ method: 'GET', path: '/api/v1/contacts' }),
      {} as Response,
      next as unknown as NextFunction,
    );

    expect(logger.warn).toHaveBeenCalled();
    const error = next.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ statusCode: 429, code: 'RATE_LIMIT_EXCEEDED' });
  });

  it('namespaces store keys and forwards raw commands to Redis', async () => {
    const redis = createRedis();
    const { createRateLimiter } = await import('./rate-limit.js');
    createRateLimiter(redis, baseConfig, createLogger());

    const { prefix, sendCommand } = lastOptions().store.options;
    expect(prefix).toBe('crm:rate-limit:');

    await sendCommand('EVAL', 'script', '1', 'key');
    expect(redis.call).toHaveBeenCalledWith('EVAL', 'script', '1', 'key');
  });

  it('keeps the auth limiter in its own namespace', async () => {
    const { createAuthRateLimiter } = await import('./rate-limit.js');
    createAuthRateLimiter(createRedis(), baseConfig, createLogger());

    expect(lastOptions().store.options.prefix).toBe('crm:rate-limit:auth:');
  });
});
