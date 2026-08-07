import { createHash } from 'node:crypto';

import { createNoopCacheService, type CacheService } from '../../cache/cache.service.js';
import { cacheKey } from '../../cache/keys.js';
import type { DeliveryClient } from './delivery/client.js';
import { DEFAULT_QUOTE_CACHE_TTL_SECONDS } from './delivery/factory.js';
import type {
  CreateShipmentData,
  DeliveryHealthDto,
  DeliveryQuoteDto,
  QuoteRequestData,
  ShipmentDto,
} from './types.js';

export const INTEGRATIONS_NAMESPACE = 'integrations';
export const DELIVERY_NAMESPACE = 'delivery';

// Object key order must not change the cache key, so the payload is serialised
// through a stable stringifier before it is hashed.
const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entryKey, entryValue]) => `${JSON.stringify(entryKey)}:${stableStringify(entryValue)}`);

  return `{${entries.join(',')}}`;
};

export const quoteCacheKey = (data: QuoteRequestData): string =>
  cacheKey(
    INTEGRATIONS_NAMESPACE,
    DELIVERY_NAMESPACE,
    'quote',
    createHash('sha256').update(stableStringify(data)).digest('hex').slice(0, 32),
  );

export interface IntegrationsService {
  requestQuote(data: QuoteRequestData): Promise<DeliveryQuoteDto>;
  createShipment(data: CreateShipmentData): Promise<ShipmentDto>;
  getShipment(shipmentId: string): Promise<ShipmentDto>;
  health(): DeliveryHealthDto;
}

export interface IntegrationsServiceOptions {
  readonly cache?: CacheService | undefined;
  readonly quoteCacheTtlSeconds?: number | undefined;
}

export const createIntegrationsService = (
  client: DeliveryClient,
  {
    cache = createNoopCacheService(),
    quoteCacheTtlSeconds = DEFAULT_QUOTE_CACHE_TTL_SECONDS,
  }: IntegrationsServiceOptions = {},
): IntegrationsService => ({
  async requestQuote(data) {
    // Quotes are stable for a short window and are by far the most repeated
    // call, so they are memoised. `remember` fails open: an unreachable cache
    // degrades to a live lookup rather than to an error.
    return cache.remember(quoteCacheKey(data), quoteCacheTtlSeconds, () =>
      client.requestQuote(data),
    );
  },

  // Deliberately not cached: creating a shipment is a side effect.
  createShipment: (data) => client.createShipment(data),

  // Deliberately not cached: a tracking status that lags is worse than useless.
  getShipment: (shipmentId) => client.getShipment(shipmentId),

  health: () => client.health(),
});
