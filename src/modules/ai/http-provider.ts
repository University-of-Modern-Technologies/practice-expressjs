import type { Logger } from 'pino';
import { z } from 'zod';

import {
  aiInvalidResponseError,
  aiTimeoutError,
  aiUnavailableError,
  type AiProvider,
} from './provider.js';
import { RetryableAiFailure, withRetry } from './retry-provider.js';

/**
 * Seam between the HTTP provider and the network, mirroring the delivery
 * integration: production wires `fetch`, tests wire a fake. No test in this
 * module ever opens a socket.
 */
export interface AiTransportRequest {
  readonly body: unknown;
  readonly signal: AbortSignal;
}

export interface AiTransportResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface AiTransport {
  send(request: AiTransportRequest): Promise<AiTransportResponse>;
}

/** Minimal contract we require of the endpoint; anything else is rejected. */
export const aiCompletionResponseSchema = z.object({
  text: z.string().min(1).max(20_000),
});

export const DEFAULT_AI_TIMEOUT_MS = 10_000;
export const DEFAULT_AI_MAX_ATTEMPTS = 2;
export const DEFAULT_AI_BACKOFF_MS = 250;

export interface HttpAiProviderOptions {
  readonly endpointUrl: string;
  readonly apiKey?: string | undefined;
  readonly model?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly backoffMs?: number | undefined;
  readonly transport?: AiTransport | undefined;
  readonly logger?: Logger | undefined;
  readonly delay?: ((ms: number) => Promise<void>) | undefined;
}

export const HTTP_AI_PROVIDER_NAME = 'http';

const isTimeoutError = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

const createFetchAiTransport = (endpointUrl: string, apiKey: string | undefined): AiTransport => ({
  async send({ body, signal }) {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
    };
    if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`;

    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length === 0 ? undefined : (JSON.parse(text) as unknown);
    } catch {
      parsed = undefined;
    }
    return { status: response.status, body: parsed };
  },
});

/**
 * A single request/response round trip: sends the completion request, then
 * classifies and validates the outcome. Transient failures are reported to
 * the caller as `RetryableAiFailure` rather than retried here — retrying is
 * the concern of `withRetry`, not of talking to the wire.
 */
const createSingleAttemptAiProvider = ({
  endpointUrl,
  apiKey,
  model,
  timeoutMs = DEFAULT_AI_TIMEOUT_MS,
  transport,
  logger,
}: HttpAiProviderOptions): AiProvider => {
  const wire = transport ?? createFetchAiTransport(endpointUrl, apiKey);

  return {
    name: HTTP_AI_PROVIDER_NAME,
    async complete({ system, prompt, maxTokens }) {
      let response: AiTransportResponse;
      try {
        response = await wire.send({
          signal: AbortSignal.timeout(timeoutMs),
          body: {
            ...(model === undefined ? {} : { model }),
            system,
            prompt,
            max_tokens: maxTokens,
          },
        });
      } catch (error) {
        const failure = isTimeoutError(error) ? aiTimeoutError() : aiUnavailableError();
        logger?.warn({ err: error }, 'AI completion request failed');
        throw new RetryableAiFailure(failure);
      }

      if (response.status === 429 || response.status >= 500) {
        logger?.warn({ status: response.status }, 'AI endpoint returned a transient error');
        throw new RetryableAiFailure(aiUnavailableError());
      }

      // A 4xx means our request was wrong; repeating it changes nothing.
      if (response.status < 200 || response.status >= 300) {
        logger?.warn({ status: response.status }, 'AI endpoint rejected the request');
        throw aiUnavailableError();
      }

      const parsed = aiCompletionResponseSchema.safeParse(response.body);
      if (!parsed.success) {
        // The raw payload stays in our logs and never reaches the caller.
        logger?.error({ issues: parsed.error.issues }, 'AI endpoint returned an invalid payload');
        throw aiInvalidResponseError();
      }
      return parsed.data.text;
    },
  };
};

/**
 * Talks to a configured completion endpoint. Used only when the composition
 * root supplies an endpoint URL; otherwise the mock provider is the default.
 */
export const createHttpAiProvider = (options: HttpAiProviderOptions): AiProvider =>
  withRetry(createSingleAttemptAiProvider(options), {
    maxAttempts: options.maxAttempts ?? DEFAULT_AI_MAX_ATTEMPTS,
    backoffMs: options.backoffMs ?? DEFAULT_AI_BACKOFF_MS,
    logger: options.logger,
    delay: options.delay,
  });
