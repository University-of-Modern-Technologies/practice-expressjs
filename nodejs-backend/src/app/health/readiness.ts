/**
 * Readiness probe execution.
 *
 * Every registered dependency check runs concurrently behind its own timeout so
 * that a single hanging dependency can never hold the `/health/ready` request
 * open. Failure details are returned to the caller for logging only; the HTTP
 * response deliberately exposes nothing but the status and the duration.
 */

export interface ReadinessCheck {
  /** Stable identifier reported in the probe payload, e.g. `database`. */
  readonly name: string;
  /** Resolves when the dependency is healthy, rejects otherwise. */
  readonly check: () => Promise<void>;
  /**
   * When `false`, a failure degrades the report but still yields HTTP 200.
   * Defaults to `true`.
   */
  readonly critical?: boolean;
  /** Per-check timeout overriding the router default. */
  readonly timeoutMs?: number;
}

export type ReadinessStatus = 'up' | 'down' | 'timed_out';

export interface ReadinessCheckResult {
  readonly name: string;
  readonly status: ReadinessStatus;
  readonly durationMs: number;
  readonly critical: boolean;
  /** Failure cause kept out of the HTTP response and used for logging only. */
  readonly error?: unknown;
}

export const DEFAULT_CHECK_TIMEOUT_MS = 2_000;

class ReadinessTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`Readiness check "${name}" timed out after ${String(timeoutMs)}ms`);
    this.name = 'ReadinessTimeoutError';
  }
}

const withTimeout = async (
  name: string,
  check: () => Promise<void>,
  timeoutMs: number,
): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ReadinessTimeoutError(name, timeoutMs));
    }, timeoutMs);
    // Never keep the event loop alive just for a probe timer.
    timer.unref();
  });

  try {
    const pending = check();
    // A check that loses the race still settles later; attach a no-op handler
    // so a late rejection cannot surface as an unhandled rejection.
    void pending.catch(() => undefined);

    await Promise.race([pending, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const runSingleCheck = async (
  readinessCheck: ReadinessCheck,
  defaultTimeoutMs: number,
): Promise<ReadinessCheckResult> => {
  const { name, check } = readinessCheck;
  const critical = readinessCheck.critical ?? true;
  const timeoutMs = readinessCheck.timeoutMs ?? defaultTimeoutMs;
  const startedAt = Date.now();

  try {
    await withTimeout(name, check, timeoutMs);
    return { name, status: 'up', durationMs: Date.now() - startedAt, critical };
  } catch (error: unknown) {
    return {
      name,
      status: error instanceof ReadinessTimeoutError ? 'timed_out' : 'down',
      durationMs: Date.now() - startedAt,
      critical,
      error,
    };
  }
};

/** Runs all readiness checks concurrently, isolating failures and timeouts. */
export const runReadinessChecks = async (
  readinessChecks: readonly ReadinessCheck[],
  defaultTimeoutMs: number = DEFAULT_CHECK_TIMEOUT_MS,
): Promise<readonly ReadinessCheckResult[]> =>
  Promise.all(readinessChecks.map((entry) => runSingleCheck(entry, defaultTimeoutMs)));

/** A report is ready when no critical dependency failed. */
export const isReadyReport = (results: readonly ReadinessCheckResult[]): boolean =>
  results.every((result) => result.status === 'up' || !result.critical);

/** True when a non-critical dependency failed while the service stays ready. */
export const isDegradedReport = (results: readonly ReadinessCheckResult[]): boolean =>
  results.some((result) => result.status !== 'up' && !result.critical);
