/**
 * Composes several readiness probes into one.
 *
 * The result satisfies the very `ReadinessCheck` interface it is built from,
 * so `readinessChecks` cannot tell it apart from a plain probe: a `database`
 * entry can become "connection reachable" plus "schema applied" without the
 * router — or the cross-contract test pinning the response shape — noticing
 * anything changed.
 */

import {
  DEFAULT_CHECK_TIMEOUT_MS,
  isReadyReport,
  runReadinessChecks,
  type ReadinessCheck,
  type ReadinessCheckResult,
} from './readiness.js';

/**
 * Raised when a composite's own probe fails. Carries the sub-results for the
 * log line only: the router already keeps every check's `error` out of the
 * HTTP response, so nesting the detail here never reaches an unauthenticated
 * caller.
 */
export class CompositeReadinessError extends Error {
  readonly results: readonly ReadinessCheckResult[];

  constructor(name: string, results: readonly ReadinessCheckResult[]) {
    const failed = results
      .filter((result) => result.status !== 'up' && result.critical)
      .map((result) => `${result.name}: ${result.status}`)
      .join(', ');
    super(`Composite readiness check "${name}" failed: ${failed}`);
    this.name = 'CompositeReadinessError';
    this.results = results;
  }
}

export interface CompositeReadinessCheckOptions {
  readonly name: string;
  readonly checks: readonly ReadinessCheck[];
  /** Default timeout handed to sub-checks that do not declare their own. */
  readonly subCheckTimeoutMs?: number;
  /** Timeout for the composite entry itself, as seen by the outer probe. */
  readonly timeoutMs?: number;
}

/**
 * Folds several dependency probes into one readiness entry.
 *
 * Sub-checks keep their own timeout and run concurrently, exactly like the
 * top-level probe list, so one hanging dependency inside the composite still
 * cannot delay a sibling sub-check or the rest of the outer probe.
 */
export const createCompositeReadinessCheck = ({
  name,
  checks,
  subCheckTimeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
  timeoutMs,
}: CompositeReadinessCheckOptions): ReadinessCheck => ({
  name,
  // A composite is only as safe as its riskiest part: if any sub-check is
  // declared critical, a failure there must still take the instance out of
  // rotation, exactly as it would if that sub-check were registered on its
  // own at the top level.
  critical: checks.some((entry) => entry.critical ?? true),
  // `exactOptionalPropertyTypes` treats an explicit `undefined` differently
  // from an absent key, so the key is only present at all when a caller
  // actually supplied a timeout.
  ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  async check() {
    const results = await runReadinessChecks(checks, subCheckTimeoutMs);
    if (!isReadyReport(results)) {
      throw new CompositeReadinessError(name, results);
    }
  },
});
