import type { Logger } from 'pino';

import { createHttpAiProvider, type AiTransport } from './http-provider.js';
import { createMockAiProvider } from './mock-provider.js';
import type { AiProvider } from './provider.js';

/**
 * Configuration the composition root supplies. Every value has a safe default,
 * and the safest default of all is "no endpoint": with nothing configured the
 * offline mock is used and the system still works end to end.
 */
export interface AiConfig {
  /** Absent means "no provider configured" — the mock is used. */
  readonly endpointUrl?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly model?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxAttempts?: number | undefined;
  /** Hard cap on the answer length requested from the provider. */
  readonly maxTokens?: number | undefined;
  /** Hard cap on user-supplied input, enforced before any prompt is built. */
  readonly maxInputChars?: number | undefined;
  readonly cacheTtlSeconds?: number | undefined;
}

export const DEFAULT_AI_MAX_TOKENS = 400;
export const DEFAULT_AI_MAX_INPUT_CHARS = 4_000;
export const DEFAULT_AI_CACHE_TTL_SECONDS = 300;

// The warning is emitted once per logger rather than once per process, so a
// long-running server does not repeat it and tests stay independent.
const warnedLoggers = new WeakSet<Logger>();

export interface CreateAiProviderOptions {
  readonly config?: AiConfig | undefined;
  readonly logger?: Logger | undefined;
  /** Injectable network seam for the HTTP provider; used by tests. */
  readonly transport?: AiTransport | undefined;
}

export const createAiProvider = ({
  config = {},
  logger,
  transport,
}: CreateAiProviderOptions = {}): AiProvider => {
  if (config.endpointUrl === undefined || config.endpointUrl.length === 0) {
    if (logger && !warnedLoggers.has(logger)) {
      warnedLoggers.add(logger);
      logger.warn(
        'No AI endpoint configured; using the built-in offline mock provider. ' +
          'Responses are templated, not generated.',
      );
    }
    return createMockAiProvider();
  }

  return createHttpAiProvider({
    endpointUrl: config.endpointUrl,
    apiKey: config.apiKey,
    model: config.model,
    timeoutMs: config.timeoutMs,
    maxAttempts: config.maxAttempts,
    transport,
    logger,
  });
};
