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
 * Only failures of the dependency (network errors, timeouts, 429, 5xx, and a
 * refusal of our credentials) are reported as failures. Any other 4xx answer
 * proves the service is alive and is reported as a success — a stream of bad
 * requests from us must never trip the breaker.
 *
 * Every admitted call carries a permit naming the period it was admitted in.
 * Opening the circuit starts a new period, so a call that was already in flight
 * when the circuit opened reports into a period that is over: its result is
 * ignored instead of closing the circuit, or extending it, behind the probe's
 * back.
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

/** What an admitted call reports back with. */
export interface CircuitPermit {
  /** The period the call was admitted in; a new one starts each time it opens. */
  readonly generation: number;
  /** Whether this is the single call admitted to test a half-open circuit. */
  readonly probe: boolean;
}

export interface CircuitBreaker {
  /** A permit when a call may proceed, `null` when it is refused. */
  acquire(): CircuitPermit | null;
  /** True when a call may proceed; admits exactly one probe in half-open. */
  tryAcquire(): boolean;
  /** Without a permit the result is taken to belong to the current period. */
  onSuccess(permit?: CircuitPermit): void;
  onFailure(permit?: CircuitPermit): void;
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
  let generation = 0;

  const open = (): void => {
    state = 'open';
    openedAt = now();
    probeInFlight = false;
    generation += 1;
  };

  /** A result from a period that is over changes nothing. */
  const isLate = (permit: CircuitPermit | undefined): boolean =>
    permit !== undefined && permit.generation !== generation;

  const breaker: CircuitBreaker = {
    acquire() {
      if (state === 'open') {
        if (openedAt === null || now() - openedAt < cooldownMs) return null;
        state = 'half-open';
        probeInFlight = true;
        return { generation, probe: true };
      }

      if (state === 'half-open') {
        // A probe is already being evaluated; nobody else gets through.
        if (probeInFlight) return null;
        probeInFlight = true;
        return { generation, probe: true };
      }

      return { generation, probe: false };
    },

    tryAcquire() {
      return breaker.acquire() !== null;
    },

    onSuccess(permit) {
      if (isLate(permit)) return;
      state = 'closed';
      consecutiveFailures = 0;
      openedAt = null;
      probeInFlight = false;
    },

    onFailure(permit) {
      if (isLate(permit)) return;
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

  return breaker;
};
