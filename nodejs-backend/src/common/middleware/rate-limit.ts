import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { Logger } from 'pino';
import { RedisStore } from 'rate-limit-redis';

import type { AppConfig } from '../../config/env.js';
import { AppError } from '../errors/app-error.js';

/**
 * Only the raw command channel is needed. Declaring it structurally instead of
 * reusing the client's overloaded signature keeps test doubles trivial while
 * still accepting a real client.
 */
export interface RateLimitRedis {
  call(command: string, ...args: string[]): Promise<unknown>;
}

// Structural copy of the reply type accepted by rate-limit-redis.
type RedisReply = number | string | (number | string)[];

// IPv6 clients get a whole /64 by default, so the limit is applied per subnet
// rather than per address, which a single client can rotate at will.
const IPV6_SUBNET = 64;

const RATE_LIMIT_NAMESPACE = 'rate-limit:';
const AUTH_RATE_LIMIT_NAMESPACE = 'rate-limit:auth:';

export const RATE_LIMIT_ERROR_CODE = 'RATE_LIMIT_EXCEEDED';
export const RATE_LIMIT_MESSAGE = 'Too many requests, please try again later';

interface RateLimiterOptions {
  readonly limit: number;
  readonly namespace: string;
}

const createRateLimitMiddleware = (
  redis: RateLimitRedis,
  config: AppConfig,
  logger: Logger,
  options: RateLimiterOptions,
): RequestHandler =>
  rateLimit({
    windowMs: config.rateLimitWindowSeconds * 1_000,
    limit: options.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Fail open: a Redis outage must degrade the limiter, not the API.
    passOnStoreError: true,
    // Automated tests must not share counters between cases.
    skip: () => config.nodeEnv === 'test',
    keyGenerator: (request: Request) =>
      request.auth?.userId ?? ipKeyGenerator(request.ip ?? 'unknown', IPV6_SUBNET),
    handler: (request: Request, _response: Response, next: NextFunction) => {
      logger.warn({ method: request.method, path: request.path }, 'Rate limit exceeded');
      // Delegating to the shared error handler keeps the response envelope
      // identical to every other error the API returns.
      next(new AppError(RATE_LIMIT_MESSAGE, 429, RATE_LIMIT_ERROR_CODE));
    },
    store: new RedisStore({
      // `call` bypasses ioredis key prefixing, so the namespace carries it.
      prefix: `${config.redisKeyPrefix}${options.namespace}`,
      sendCommand: (command: string, ...args: string[]) =>
        redis.call(command, ...args) as Promise<RedisReply>,
    }),
  });

export const createRateLimiter = (
  redis: RateLimitRedis,
  config: AppConfig,
  logger: Logger,
): RequestHandler =>
  createRateLimitMiddleware(redis, config, logger, {
    limit: config.rateLimitMaxRequests,
    namespace: RATE_LIMIT_NAMESPACE,
  });

export const createAuthRateLimiter = (
  redis: RateLimitRedis,
  config: AppConfig,
  logger: Logger,
): RequestHandler =>
  createRateLimitMiddleware(redis, config, logger, {
    limit: config.authRateLimitMaxRequests,
    namespace: AUTH_RATE_LIMIT_NAMESPACE,
  });
