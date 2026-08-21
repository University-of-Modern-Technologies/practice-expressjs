import type { CircuitState } from '../types.js';

/**
 * Circuit breaker for a single upstream dependency.
 *
 * State machine
 * -------------
 *
 *            failures >= threshold
 *   closed ────────────────────────▶ open
 *     ▲                               │
 *     │ success                       │ cool-down elapsed
 *     │                               ▼
 *     └──────────────────────────  half-open
 *              failure ──────────────▶ open
 *
 * - `closed`    — every call is allowed. Consecutive transient failures are
 *                 counted; any success resets the counter to zero.
 * - `open`      — the dependency is considered down. Calls are refused straight
 *                 away, without a network round-trip, so a struggling service is
 *                 not hammered and callers fail fast instead of piling up on a
 *                 timeout.
 * - `half-open` — after the cool-down a *single* probe request is admitted. If
 *                 it succeeds the breaker closes and normal traffic resumes; if
 *                 it fails the breaker opens again and a fresh cool-down starts.
 *                 While the probe is in flight all other calls are refused, so
 *                 recovery is tested with one request, not with a thundering
 *                 herd.
 *
 * Only *transient* failures (network errors, timeouts, 429, 5xx) are reported as
 * failures. A 4xx answer proves the service is alive and is reported as a
 * success — a stream of bad requests from us must never trip the breaker.
 */
export interface CircuitBreakerOptions {
  /** Consecutive transient failures that open the circuit. */
  readonly failureThreshold?: number | undefined;
  /** How long the circuit stays open before a probe is admitted. */
  readonly cooldownMs?: number | undefined;
  /** Injectable clock; defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
}

export interface CircuitBreakerSnapshot {
  readonly state: CircuitState;
  readonly consecutiveFailures: number;
  readonly lastErrorAt: number | null;
  readonly openedAt: number | null;
}

export interface CircuitBreaker {
  /** True when a call may proceed; admits exactly one probe in half-open. */
  tryAcquire(): boolean;
  onSuccess(): void;
  onFailure(): void;
  snapshot(): CircuitBreakerSnapshot;
}

export const DEFAULT_FAILURE_THRESHOLD = 5;
export const DEFAULT_COOLDOWN_MS = 30_000;

export const createCircuitBreaker = ({
  failureThreshold = DEFAULT_FAILURE_THRESHOLD,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  now = Date.now,
}: CircuitBreakerOptions = {}): CircuitBreaker => {
  let state: CircuitState = 'closed';
  let consecutiveFailures = 0;
  let lastErrorAt: number | null = null;
  let openedAt: number | null = null;
  let probeInFlight = false;

  const open = (): void => {
    state = 'open';
    openedAt = now();
    probeInFlight = false;
  };

  return {
    tryAcquire() {
      if (state === 'open') {
        if (openedAt === null || now() - openedAt < cooldownMs) return false;
        state = 'half-open';
        probeInFlight = true;
        return true;
      }

      if (state === 'half-open') {
        // A probe is already being evaluated; nobody else gets through.
        if (probeInFlight) return false;
        probeInFlight = true;
        return true;
      }

      return true;
    },

    onSuccess() {
      state = 'closed';
      consecutiveFailures = 0;
      openedAt = null;
      probeInFlight = false;
    },

    onFailure() {
      consecutiveFailures += 1;
      lastErrorAt = now();

      if (state === 'half-open') {
        // The probe failed: back to open with a fresh cool-down.
        open();
        return;
      }

      if (consecutiveFailures >= failureThreshold) open();
    },

    snapshot() {
      return { state, consecutiveFailures, lastErrorAt, openedAt };
    },
  };
};
