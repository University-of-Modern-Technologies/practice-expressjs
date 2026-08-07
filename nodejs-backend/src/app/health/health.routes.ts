import { Router, type Request } from 'express';
import type { Logger } from 'pino';

import { serviceLifecycle, type ServiceLifecycle } from './lifecycle.js';
import {
  DEFAULT_CHECK_TIMEOUT_MS,
  isDegradedReport,
  isReadyReport,
  runReadinessChecks,
  type ReadinessCheck,
  type ReadinessCheckResult,
} from './readiness.js';
import { readServiceInfo, type ServiceInfo } from './service-info.js';

export type { ReadinessCheck, ReadinessCheckResult, ReadinessStatus } from './readiness.js';

export interface HealthRouterOptions {
  /** Default per-check timeout in milliseconds. */
  readonly checkTimeoutMs?: number;
  /** Lifecycle source; defaults to the process-wide singleton. */
  readonly lifecycle?: ServiceLifecycle;
  /** Fallback logger used when the request has no attached logger. */
  readonly logger?: Logger;
  /** Overrides the manifest lookup, mainly for tests. */
  readonly serviceInfo?: ServiceInfo;
}

/** Public per-check payload: never carries error details. */
interface PublicCheckResult {
  readonly name: string;
  readonly status: 'up' | 'down' | 'timed_out';
  readonly durationMs: number;
  readonly critical: boolean;
}

const toPublicResult = ({
  name,
  status,
  durationMs,
  critical,
}: ReadinessCheckResult): PublicCheckResult => ({ name, status, durationMs, critical });

/**
 * pino-http attaches a child logger to every request, but the router may also
 * be mounted standalone (tests, embedded usage), so the lookup stays defensive.
 */
const resolveLogger = (request: Request, fallback: Logger | undefined): Logger | undefined => {
  const attached = (request as { log?: unknown }).log;

  return typeof attached === 'object' && attached !== null ? (attached as Logger) : fallback;
};

const logFailures = (
  request: Request,
  fallbackLogger: Logger | undefined,
  results: readonly ReadinessCheckResult[],
): void => {
  const failures = results.filter((result) => result.status !== 'up');
  if (failures.length === 0) return;

  const logger = resolveLogger(request, fallbackLogger);
  if (!logger) return;

  for (const failure of failures) {
    logger.error(
      {
        check: failure.name,
        status: failure.status,
        durationMs: failure.durationMs,
        critical: failure.critical,
        error: failure.error,
      },
      'Readiness check failed',
    );
  }
};

/**
 * Health endpoints:
 *
 * - `GET /live`    — process liveness, no I/O, always cheap.
 * - `GET /startup` — has the bootstrap finished? Use as a startup probe.
 * - `GET /ready`   — dependency readiness, 200 only when every critical check
 *                    passes and the process is not draining.
 * - `GET /info`    — non-sensitive build and runtime metadata.
 */
export const createHealthRouter = (
  readinessChecks: readonly ReadinessCheck[] = [],
  options: HealthRouterOptions = {},
): Router => {
  const router = Router();
  const lifecycle = options.lifecycle ?? serviceLifecycle;
  const checkTimeoutMs = options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const fallbackLogger = options.logger;

  router.get('/live', (_request, response) => {
    // Liveness must stay successful while draining: the process is healthy, it
    // is simply no longer accepting new traffic (that is what readiness says).
    response.status(200).json({ status: 'ok' });
  });

  router.get('/startup', (_request, response) => {
    const hasStarted = lifecycle.hasStarted;

    response.status(hasStarted ? 200 : 503).json({
      status: hasStarted ? 'started' : 'starting',
      phase: lifecycle.phase,
    });
  });

  router.get('/ready', async (request, response) => {
    if (!lifecycle.isAcceptingTraffic) {
      response.status(503).json({
        status: lifecycle.phase === 'starting' ? 'not_ready' : 'draining',
        phase: lifecycle.phase,
        checks: [],
      });
      return;
    }

    const results = await runReadinessChecks(readinessChecks, checkTimeoutMs);
    logFailures(request, fallbackLogger, results);

    const isReady = isReadyReport(results);
    const status = isReady ? (isDegradedReport(results) ? 'degraded' : 'ready') : 'not_ready';

    response.status(isReady ? 200 : 503).json({
      status,
      phase: lifecycle.phase,
      checks: results.map(toPublicResult),
    });
  });

  router.get('/info', (_request, response) => {
    const info = options.serviceInfo ?? readServiceInfo();

    response.status(200).json({
      name: info.name,
      version: info.version,
      nodeEnv: process.env.NODE_ENV ?? 'development',
      phase: lifecycle.phase,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  return router;
};
