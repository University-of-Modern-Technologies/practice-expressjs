import type { Request, RequestHandler } from 'express';

import { DEFAULT_DURATION_BUCKETS, type MetricsRegistry } from './metrics-registry.js';

/** Route label used when no Express route matched (404s, malformed URLs). */
export const UNMATCHED_ROUTE_LABEL = '__unmatched__';

export interface MetricsMiddlewareOptions {
  /** Histogram bucket bounds in seconds. */
  readonly durationBuckets?: readonly number[];
  /** Overrides route extraction, e.g. to fold versioned prefixes together. */
  readonly routeResolver?: (request: Request) => string;
}

/**
 * Derives a bounded route label.
 *
 * Only the matched Express route pattern is used (`/api/v1/deals/:id`), never
 * the raw URL: raw URLs carry identifiers and query strings and would make the
 * metric cardinality grow with traffic instead of with the route table.
 */
export const resolveRouteLabel = (request: Request): string => {
  const route = (request as { route?: { path?: unknown } }).route;
  const routePath = typeof route?.path === 'string' ? route.path : undefined;

  if (routePath === undefined) return UNMATCHED_ROUTE_LABEL;

  const base = request.baseUrl;
  const combined = `${base}${routePath}`.replace(/\/{2,}/g, '/');

  if (combined === '') return '/';

  return combined.length > 1 && combined.endsWith('/') ? combined.slice(0, -1) : combined;
};

/**
 * Records request counts and latency.
 *
 * Mount it early — right after the correlation id and the request logger and
 * before the routers — so that every request, including ones rejected by rate
 * limiting or authentication, is observed exactly once.
 */
export const createMetricsMiddleware = (
  registry: MetricsRegistry,
  options: MetricsMiddlewareOptions = {},
): RequestHandler => {
  const requestsTotal = registry.counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests handled by the service.',
    labelNames: ['method', 'route', 'status'],
  });
  const inFlight = { value: 0 };
  const requestDuration = registry.histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency in seconds.',
    labelNames: ['method', 'route'],
    buckets: options.durationBuckets ?? DEFAULT_DURATION_BUCKETS,
  });
  const resolveRoute = options.routeResolver ?? resolveRouteLabel;

  registry.registerGauge(
    {
      name: 'http_requests_in_flight',
      help: 'Number of HTTP requests currently being processed.',
    },
    () => inFlight.value,
  );

  return (request, response, next) => {
    const startedAt = process.hrtime.bigint();
    inFlight.value += 1;
    let recorded = false;

    const record = (): void => {
      if (recorded) return;
      recorded = true;
      inFlight.value -= 1;

      // Resolved on completion: `request.route` is only populated once Express
      // has matched a handler.
      const route = resolveRoute(request);
      const method = request.method.toUpperCase();
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;

      requestsTotal.inc({ method, route, status: response.statusCode });
      requestDuration.observe(durationSeconds, { method, route });
    };

    response.on('finish', record);
    // `close` covers aborted connections, where `finish` never fires.
    response.on('close', record);

    next();
  };
};
