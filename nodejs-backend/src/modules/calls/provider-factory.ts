import type { Logger } from 'pino';

import { createHttpCallProvider, type CallProviderTransport } from './http-provider.js';
import type { CallProvider } from './provider.js';
import { createStubCallProvider } from './stub-provider.js';

/**
 * Configuration the composition root supplies. Nothing here is read from
 * `process.env` inside the module: the root passes it in, which is what makes
 * the provider testable and the defaults honest. The safest default of all is
 * "no base URL": with nothing configured the offline stub is used and the
 * system still works end to end.
 */
export interface CallProviderConfig {
  /** Absent or empty means "no provider configured" — the stub is used. */
  readonly baseUrl?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly backoffMs?: number | undefined;
  /** Upper bound on how many records one sync run may take. */
  readonly syncBatchSize?: number | undefined;
}

export const DEFAULT_CALL_SYNC_BATCH_SIZE = 100;

// The warning is emitted once per logger rather than once per process, so a
// long-running server does not repeat it and tests stay independent.
const warnedLoggers = new WeakSet<Logger>();

export interface CreateCallProviderOptions {
  readonly config?: CallProviderConfig | undefined;
  readonly logger?: Logger | undefined;
  /** Injectable network seam for the HTTP provider; used by tests. */
  readonly transport?: CallProviderTransport | undefined;
}

export const createCallProvider = ({
  config = {},
  logger,
  transport,
}: CreateCallProviderOptions = {}): CallProvider => {
  if (config.baseUrl === undefined || config.baseUrl.length === 0) {
    if (logger && !warnedLoggers.has(logger)) {
      warnedLoggers.add(logger);
      logger.warn(
        'No telephony provider configured; using the built-in offline stub. ' +
          'The journal it returns is generated, not recorded.',
      );
    }
    return createStubCallProvider();
  }

  return createHttpCallProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    maxAttempts: config.maxAttempts,
    backoffMs: config.backoffMs,
    transport,
    logger,
  });
};
