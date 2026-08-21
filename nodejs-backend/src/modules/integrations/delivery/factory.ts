import type { Logger } from 'pino';

import { createDeliveryClient, type DeliveryClient } from './client.js';
import { createStubDeliveryTransport } from './stub-transport.js';
import {
  createFetchDeliveryTransport,
  type DeliveryTransport,
  type FetchLike,
} from './transport.js';

/**
 * Everything the integration needs from the outside. Nothing here is read from
 * `process.env` inside the module: the composition root passes it in, which is
 * what makes the client testable and the defaults honest.
 */
export interface DeliveryIntegrationConfig {
  /** Absent means "no real provider configured" — the stub transport is used. */
  readonly baseUrl?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly baseBackoffMs?: number | undefined;
  readonly maxBackoffMs?: number | undefined;
  readonly failureThreshold?: number | undefined;
  readonly cooldownMs?: number | undefined;
  /** How long a quote lookup may be served from cache. */
  readonly quoteCacheTtlSeconds?: number | undefined;
}

export const DEFAULT_QUOTE_CACHE_TTL_SECONDS = 60;

export interface CreateDeliveryClientOptions {
  readonly config?: DeliveryIntegrationConfig | undefined;
  readonly logger?: Logger | undefined;
  /** Overrides transport selection entirely; used by tests. */
  readonly transport?: DeliveryTransport | undefined;
  readonly fetchImpl?: FetchLike | undefined;
}

/**
 * Picks the transport and builds the client. With no `baseUrl` the in-repo stub
 * is wired, so a fresh checkout runs end-to-end without any external account.
 */
export const createConfiguredDeliveryClient = ({
  config = {},
  logger,
  transport,
  fetchImpl,
}: CreateDeliveryClientOptions = {}): DeliveryClient => {
  const selected =
    transport ??
    (config.baseUrl === undefined || config.baseUrl.length === 0
      ? createStubDeliveryTransport()
      : createFetchDeliveryTransport({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          fetchImpl,
        }));

  if (selected.kind === 'stub') {
    logger?.warn(
      'Delivery integration has no base URL configured; using the built-in stub transport',
    );
  }

  return createDeliveryClient({
    transport: selected,
    timeoutMs: config.timeoutMs,
    maxAttempts: config.maxAttempts,
    baseBackoffMs: config.baseBackoffMs,
    maxBackoffMs: config.maxBackoffMs,
    failureThreshold: config.failureThreshold,
    cooldownMs: config.cooldownMs,
    logger,
  });
};
