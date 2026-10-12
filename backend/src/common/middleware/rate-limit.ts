import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import jwt from 'jsonwebtoken';
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

/**
 * Authentication endpoints that only read or end an existing session. They
 * are no use for guessing credentials, and a client calls them on every page
 * load, so they spend the general budget only, not the strict one.
 */
const AUTH_BUDGET_EXEMPT_PATHS = new Set(['/api/v1/auth/me', '/api/v1/auth/logout']);

const BEARER_PREFIX = 'bearer ';
const ACCESS_TOKEN_ALGORITHMS: jwt.Algorithm[] = ['HS256'];

/**
 * Whether a path is left out of the strict authentication budget. Routing is
 * case-insensitive and ignores a trailing slash, so the comparison is too.
 */
export const isAuthBudgetExempt = (path: string): boolean =>
  AUTH_BUDGET_EXEMPT_PATHS.has(path.toLowerCase().replace(/\/+$/, ''));

/**
 * The signed-in user's id, when the request carries a valid access token.
 *
 * A signature-verified read of one claim and nothing more: no session lookup,
 * no account state, no error. Anything unusable comes back `undefined`, so the
 * caller falls back to the address. Rejecting here would turn the limiter into
 * a second, weaker authenticator that answers before the real one runs.
 */
export const bearerSubject = (request: Request, secret: string): string | undefined => {
  const header = request.headers.authorization;
  if (!header?.toLowerCase().startsWith(BEARER_PREFIX)) return undefined;

  try {
    const claims = jwt.verify(header.slice(BEARER_PREFIX.length).trim(), secret, {
      algorithms: ACCESS_TOKEN_ALGORITHMS,
    });
    if (typeof claims === 'string' || claims.type !== 'access') return undefined;
    return typeof claims.sub === 'string' && claims.sub ? claims.sub : undefined;
  } catch {
    return undefined;
  }
};

interface RateLimiterOptions {
  readonly limit: number;
  readonly namespace: string;
  /** Requests that do not spend this budget at all. */
  readonly exempt?: (request: Request) => boolean;
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
    skip: (request: Request) => config.appEnv === 'test' || (options.exempt?.(request) ?? false),
    // The limiter runs before any route authenticates the caller, so the user
    // is read from the token itself. Keying by user is what keeps the limit
    // fair behind NAT, where a whole office shares one address.
    keyGenerator: (request: Request) => {
      const subject = bearerSubject(request, config.jwtAccessSecret);
      return subject ? `user:${subject}` : ipKeyGenerator(request.ip ?? 'unknown', IPV6_SUBNET);
    },
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
    // Mounted under the auth prefix, so the full path is the two halves joined.
    exempt: (request) => isAuthBudgetExempt(`${request.baseUrl}${request.path}`),
  });
