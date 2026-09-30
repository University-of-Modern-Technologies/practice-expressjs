import cookieParser from 'cookie-parser';
import cors, { type CorsOptions } from 'cors';
import express, { type Express, type RequestHandler, type Router } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import swaggerUi from 'swagger-ui-express';

import {
  createErrorHandler,
  createRequestId,
  createRequestLogger,
  notFoundHandler,
} from '../common/middleware/index.js';
import {
  createMetricsMiddleware,
  createMetricsRouter,
  createBearerTokenMetricsGuard,
  type MetricsRegistry,
} from '../common/observability/index.js';
import type { AppConfig } from '../config/env.js';
import { openApiDocument } from '../config/swagger.js';
import { createHealthRouter, type ReadinessCheck } from './health/health.routes.js';

export interface MountedRouter {
  readonly path: string;
  readonly router: Router;
}

export interface CreateAppOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly routers?: readonly MountedRouter[];
  readonly readinessChecks?: readonly ReadinessCheck[];
  readonly metrics?: MetricsRegistry;
  /** Applied to every route; omitted in tests that do not exercise limiting. */
  readonly rateLimiter?: RequestHandler;
  /** Stricter budget for credential endpoints. */
  readonly authRateLimiter?: RequestHandler;
  /** Drops cached reads after a successful write; omitted where nothing is cached. */
  readonly cacheInvalidation?: RequestHandler;
}

const AUTH_PATH = '/api/v1/auth';

const createCorsOptions = (allowedOrigins: readonly string[]): CorsOptions => ({
  credentials: true,
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(null, false);
  },
});

export const createApp = ({
  config,
  logger,
  routers = [],
  readinessChecks = [],
  metrics,
  rateLimiter,
  authRateLimiter,
  cacheInvalidation,
}: CreateAppOptions): Express => {
  const app = express();

  app.disable('x-powered-by');
  // The correlation id is established before anything else so that every log
  // line and every metric sample produced downstream can be tied to it.
  app.use(createRequestId());
  app.use(createRequestLogger(logger));
  if (metrics) {
    // Placed ahead of the guards so throttled and rejected requests are counted.
    app.use(createMetricsMiddleware(metrics));
  }
  app.use(helmet());
  app.use(cors(createCorsOptions(config.corsOrigins)));
  if (rateLimiter) app.use(rateLimiter);
  app.use(express.json({ limit: config.jsonBodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: config.jsonBodyLimit }));
  app.use(cookieParser());

  app.use('/health', createHealthRouter(readinessChecks));
  app.get('/openapi.json', (_request, response) => response.json(openApiDocument));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument, { explorer: true }));

  if (authRateLimiter) app.use(AUTH_PATH, authRateLimiter);
  if (cacheInvalidation) app.use(cacheInvalidation);

  for (const mountedRouter of routers) {
    app.use(mountedRouter.path, mountedRouter.router);
  }

  if (metrics && config.metricsToken) {
    // Metrics expose internal topology, so the endpoint is never public: it is
    // mounted only when a scrape token is configured, and stays guarded by it.
    app.use(
      '/metrics',
      createMetricsRouter({
        registry: metrics,
        guard: createBearerTokenMetricsGuard(config.metricsToken),
      }),
    );
  }

  app.use(notFoundHandler);
  app.use(createErrorHandler(config));

  return app;
};
