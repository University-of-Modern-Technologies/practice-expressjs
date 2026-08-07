/**
 * Process lifecycle state shared between the HTTP bootstrap and the health
 * endpoints.
 *
 * The health router is created deep inside the application factory while the
 * signal handling lives in the process bootstrap, so the two need a small piece
 * of shared state to agree on whether the service may still accept traffic.
 * A module level singleton keeps that contract explicit without forcing every
 * caller in between to thread an extra argument through.
 */

export type LifecyclePhase = 'starting' | 'started' | 'draining' | 'stopped';

export interface ServiceLifecycle {
  /** Current phase of the process. */
  readonly phase: LifecyclePhase;
  /** True once the listener is bound and startup work has completed. */
  readonly hasStarted: boolean;
  /** True while the process is able to serve new requests. */
  readonly isAcceptingTraffic: boolean;
  /** Milliseconds since the process was marked as started, `undefined` before. */
  readonly startedForMs: number | undefined;
  /** Marks the service as fully started (listener bound, warm-up finished). */
  markStarted(): void;
  /** Marks the service as draining so readiness starts failing immediately. */
  beginDraining(): void;
  /** Marks the service as fully stopped. */
  markStopped(): void;
  /** Resets back to the initial phase. Intended for tests only. */
  reset(): void;
}

export const createServiceLifecycle = (): ServiceLifecycle => {
  let phase: LifecyclePhase = 'starting';
  let startedAt: number | undefined;

  return {
    get phase(): LifecyclePhase {
      return phase;
    },
    get hasStarted(): boolean {
      return phase === 'started' || phase === 'draining';
    },
    get isAcceptingTraffic(): boolean {
      return phase === 'started';
    },
    get startedForMs(): number | undefined {
      return startedAt === undefined ? undefined : Date.now() - startedAt;
    },
    markStarted(): void {
      // Draining is terminal: a late start callback must never revive the service.
      if (phase !== 'starting') return;

      phase = 'started';
      startedAt = Date.now();
    },
    beginDraining(): void {
      if (phase === 'stopped') return;

      phase = 'draining';
    },
    markStopped(): void {
      phase = 'stopped';
    },
    reset(): void {
      phase = 'starting';
      startedAt = undefined;
    },
  };
};

/**
 * Default lifecycle instance used by the health router and the process
 * bootstrap. Tests may pass their own instance to `createHealthRouter`.
 */
export const serviceLifecycle: ServiceLifecycle = createServiceLifecycle();
