/**
 * A named bundle of stand-in-or-real implementations, chosen together instead
 * of leaving each dependency to notice its own missing setting on its own.
 *
 * Before this module existed, the AI provider looked at `AI_ENDPOINT_URL`,
 * the delivery client looked at `DELIVERY_BASE_URL` and the cache always
 * dialled Redis — three independent decisions that could disagree, so a demo
 * could end up with a live AI provider, a stubbed delivery transport and a
 * cache nobody noticed was still real. `createInfraStack` makes that one
 * decision instead of three.
 */

import type { Logger } from 'pino';

import {
  createCacheService,
  createNoopCacheService,
  type CacheRedis,
  type CacheService,
} from '../cache/index.js';
import type { AppConfig } from '../config/env.js';
import { createAiProvider, type AiConfig, type AiProvider } from '../modules/ai/index.js';
import {
  createConfiguredDeliveryClient,
  type DeliveryClient,
  type DeliveryIntegrationConfig,
} from '../modules/integrations/index.js';

export type InfraProfile = 'offline' | 'live';

/**
 * `live` reproduces today's behaviour exactly: every dependency still decides
 * for itself from its own setting, falling back to its own stand-in when that
 * setting is absent. It is the default so a fresh checkout — or any
 * deployment that has never heard of `INFRA_PROFILE` — boots the same way it
 * always has.
 */
export const DEFAULT_INFRA_PROFILE: InfraProfile = 'live';

/** An unset or unrecognised value keeps the default rather than failing the boot. */
export const resolveInfraProfile = (raw: InfraProfile | undefined): InfraProfile =>
  raw ?? DEFAULT_INFRA_PROFILE;

export interface InfraStackDependencies {
  readonly config: AppConfig;
  readonly redis: CacheRedis;
  readonly logger: Logger;
}

export interface InfraStack {
  readonly profile: InfraProfile;
  readonly aiProvider: AiProvider;
  readonly deliveryClient: DeliveryClient;
  readonly cache: CacheService;
}

/**
 * Builds the three swappable dependencies as one decision instead of three.
 *
 * `offline` withholds every per-component setting so each factory falls back
 * to the stand-in it already had; `live` forwards the configured settings and
 * leaves each factory to fall back exactly as it always has when a setting is
 * absent. Neither branch changes what `createAiProvider`,
 * `createConfiguredDeliveryClient` or `createCacheService` do — this only
 * decides what gets handed to them.
 */
export const createInfraStack = ({ config, redis, logger }: InfraStackDependencies): InfraStack => {
  const profile = resolveInfraProfile(config.infraProfile);
  const offline = profile === 'offline';

  // Only the setting that *selects* an implementation is withheld: the tuning
  // knobs below it (timeouts, retry counts, cache TTLs) belong to the service
  // using the dependency, not to the choice of stand-in-or-real, so they stay
  // in effect no matter which profile is active.
  const aiConfig: AiConfig = {
    endpointUrl: offline ? undefined : config.aiEndpointUrl,
    apiKey: offline ? undefined : config.aiApiKey,
    model: offline ? undefined : config.aiModel,
    timeoutMs: config.aiTimeoutMs,
    maxAttempts: config.aiMaxAttempts,
    maxTokens: config.aiMaxTokens,
    maxInputChars: config.aiMaxInputChars,
    cacheTtlSeconds: config.aiCacheTtlSeconds,
  };

  const deliveryConfig: DeliveryIntegrationConfig = {
    baseUrl: offline ? undefined : config.deliveryBaseUrl,
    apiKey: offline ? undefined : config.deliveryApiKey,
    timeoutMs: config.deliveryTimeoutMs,
    maxAttempts: config.deliveryMaxAttempts,
    baseBackoffMs: config.deliveryBaseBackoffMs,
    maxBackoffMs: config.deliveryMaxBackoffMs,
    failureThreshold: config.deliveryFailureThreshold,
    cooldownMs: config.deliveryCooldownMs,
    quoteCacheTtlSeconds: config.deliveryQuoteCacheTtlSeconds,
  };

  return {
    profile,
    aiProvider: createAiProvider({ config: aiConfig, logger }),
    deliveryClient: createConfiguredDeliveryClient({ config: deliveryConfig, logger }),
    // Offline means no external store at all, not merely an unreachable one:
    // the noop cache never opens a socket, whereas a real Redis client that
    // failed to connect would still show up in logs and readiness.
    cache: offline ? createNoopCacheService() : createCacheService(redis, config, logger),
  };
};
