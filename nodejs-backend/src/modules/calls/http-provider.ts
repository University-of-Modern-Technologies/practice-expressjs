import type { Logger } from 'pino';

import {
  callProviderBatchSchema,
  callProviderUnavailableError,
  type CallProvider,
  type CallProviderFetchRequest,
} from './provider.js';
import { RetryableCallProviderFailure, withRetry } from './retry-provider.js';

/**
 * Seam between the HTTP provider and the network, mirroring the delivery
 * integration: production wires `fetch`, tests wire a fake. No test in this
 * module ever opens a socket.
 */
export interface CallProviderTransportRequest {
  readonly query: CallProviderFetchRequest;
  readonly signal: AbortSignal;
}

export interface CallProviderTransportResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface CallProviderTransport {
  send(request: CallProviderTransportRequest): Promise<CallProviderTransportResponse>;
}

export const DEFAULT_CALL_PROVIDER_TIMEOUT_MS = 5_000;
export const DEFAULT_CALL_PROVIDER_MAX_ATTEMPTS = 3;
export const DEFAULT_CALL_PROVIDER_BACKOFF_MS = 200;

export interface HttpCallProviderOptions {
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  /** Per-attempt deadline enforced with `AbortSignal.timeout`. */
  readonly timeoutMs?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly backoffMs?: number | undefined;
  readonly transport?: CallProviderTransport | undefined;
  readonly logger?: Logger | undefined;
  readonly delay?: ((ms: number) => Promise<void>) | undefined;
}

export const HTTP_CALL_PROVIDER_NAME = 'http';

const CALLS_PATH = '/v1/calls';

const isTimeoutError = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

const createFetchCallProviderTransport = (
  baseUrl: string,
  apiKey: string | undefined,
): CallProviderTransport => {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');

  return {
    async send({ query, signal }) {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`;

      const search = new URLSearchParams({ limit: String(query.limit) });

      const response = await fetch(`${normalizedBaseUrl}${CALLS_PATH}?${search.toString()}`, {
        method: 'GET',
        headers,
        signal,
      });

      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length === 0 ? undefined : (JSON.parse(text) as unknown);
      } catch {
        // A non-JSON body is not decided here: the schema below turns it into
        // the one failure code this module publishes.
        parsed = undefined;
      }
      return { status: response.status, body: parsed };
    },
  };
};

/**
 * A single request/response round trip: reads a batch, then classifies and
 * validates the outcome. Transient failures are reported to the caller as
 * `RetryableCallProviderFailure` rather than retried here — retrying is the
 * concern of `withRetry`, not of talking to the wire.
 */
const createSingleAttemptCallProvider = ({
  baseUrl,
  apiKey,
  timeoutMs = DEFAULT_CALL_PROVIDER_TIMEOUT_MS,
  transport,
  logger,
}: HttpCallProviderOptions): CallProvider => {
  const wire = transport ?? createFetchCallProviderTransport(baseUrl, apiKey);

  return {
    name: HTTP_CALL_PROVIDER_NAME,
    async fetchCalls(request) {
      let response: CallProviderTransportResponse;
      try {
        response = await wire.send({ query: request, signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        logger?.warn(
          { err: error, timedOut: isTimeoutError(error) },
          'Telephony journal request failed',
        );
        throw new RetryableCallProviderFailure(callProviderUnavailableError());
      }

      if (response.status === 429 || response.status >= 500) {
        logger?.warn({ status: response.status }, 'Telephony provider returned a transient error');
        throw new RetryableCallProviderFailure(callProviderUnavailableError());
      }

      // A 4xx means our request was wrong; repeating it changes nothing.
      if (response.status < 200 || response.status >= 300) {
        logger?.warn({ status: response.status }, 'Telephony provider rejected the request');
        throw callProviderUnavailableError();
      }

      const parsed = callProviderBatchSchema.safeParse(response.body);
      if (!parsed.success) {
        // The raw payload stays in our logs and never reaches the caller.
        logger?.error(
          { issues: parsed.error.issues },
          'Telephony provider returned an invalid batch',
        );
        throw callProviderUnavailableError();
      }
      return parsed.data;
    },
  };
};

/**
 * Talks to a configured switchboard. Used only when the composition root
 * supplies a base URL; otherwise the offline stub is the default.
 */
export const createHttpCallProvider = (options: HttpCallProviderOptions): CallProvider =>
  withRetry(createSingleAttemptCallProvider(options), {
    maxAttempts: options.maxAttempts ?? DEFAULT_CALL_PROVIDER_MAX_ATTEMPTS,
    backoffMs: options.backoffMs ?? DEFAULT_CALL_PROVIDER_BACKOFF_MS,
    logger: options.logger,
    delay: options.delay,
  });
