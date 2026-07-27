import { timingSafeEqual } from 'node:crypto';

import { Router, type RequestHandler } from 'express';

import type { MetricsRegistry } from './metrics-registry.js';

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export interface MetricsRouterOptions {
  readonly registry: MetricsRegistry;
  /**
   * REQUIRED. The scrape endpoint leaks route names, traffic volumes and error
   * rates, so it must never be reachable anonymously from the public internet.
   * The composition root injects the guard it wants (bearer token, network
   * allow-list, an existing authentication middleware, ...). Pass
   * `allowAllMetricsGuard` only when the port is already restricted at the
   * infrastructure level, and do so explicitly so the decision is visible in
   * review.
   */
  readonly guard: RequestHandler;
}

/**
 * Guard that lets every scrape through. Only safe when the endpoint is already
 * unreachable from untrusted networks (private listener, service mesh, ingress
 * rule). Never use it on a publicly exposed port.
 */
export const allowAllMetricsGuard: RequestHandler = (_request, _response, next) => {
  next();
};

const safeCompare = (candidate: string, expected: string): boolean => {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);

  // `timingSafeEqual` throws on length mismatch; compare lengths separately.
  return (
    candidateBuffer.length === expectedBuffer.length &&
    timingSafeEqual(candidateBuffer, expectedBuffer)
  );
};

/**
 * Guard requiring `Authorization: Bearer <token>`. The token must come from the
 * environment; never hardcode it.
 */
export const createBearerTokenMetricsGuard = (token: string): RequestHandler => {
  if (token.length < 16) {
    throw new Error('Metrics scrape token must be at least 16 characters long');
  }

  return (request, response, next) => {
    const header = request.headers.authorization;
    const provided = typeof header === 'string' ? header.replace(/^Bearer /i, '') : '';

    if (provided !== '' && safeCompare(provided, token)) {
      next();
      return;
    }

    // No WWW-Authenticate challenge and no detail: an unauthenticated scraper
    // should not learn whether the endpoint exists at all.
    response.status(404).end();
  };
};

/**
 * Serves the Prometheus text exposition format behind the injected guard.
 * Mount it with `app.use('/metrics', createMetricsRouter({ registry, guard }))`.
 */
export const createMetricsRouter = ({ registry, guard }: MetricsRouterOptions): Router => {
  const router = Router();

  router.use(guard);
  router.get('/', (_request, response) => {
    response.setHeader('content-type', PROMETHEUS_CONTENT_TYPE);
    response.setHeader('cache-control', 'no-store');
    // `end` rather than `send`: Express would re-normalise the content type and
    // reorder the `version` parameter Prometheus scrapers look for.
    response.status(200).end(registry.render());
  });

  return router;
};
