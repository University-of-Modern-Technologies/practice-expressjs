import { createHash } from 'node:crypto';

import { createNoopCacheService, type CacheService } from '../../cache/cache.service.js';
import { cacheKey } from '../../cache/keys.js';
import { AppError } from '../../common/errors/index.js';
import type { DeliveryClient } from './delivery/client.js';
import { DEFAULT_QUOTE_CACHE_TTL_SECONDS } from './delivery/factory.js';
import type {
  CreateShipmentData,
  DeliveryHealthDto,
  DeliveryQuoteDto,
  FindOrderForShipment,
  QuoteRequestData,
  ShipmentAccess,
  ShipmentDto,
} from './types.js';
import { shippableOrderStatuses } from './types.js';

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
  requestQuote(access: ShipmentAccess, data: QuoteRequestData): Promise<DeliveryQuoteDto>;
  createShipment(access: ShipmentAccess, data: CreateShipmentData): Promise<ShipmentDto>;
  getShipment(shipmentId: string): Promise<ShipmentDto>;
  health(): DeliveryHealthDto;
}

export interface IntegrationsServiceOptions {
  readonly cache?: CacheService | undefined;
  readonly quoteCacheTtlSeconds?: number | undefined;
  /**
   * Reads the order a delivery is for. Until the composition root supplies
   * one, no order is found and every delivery is refused: shipping an order
   * nobody checked is the failure this guard exists to prevent.
   */
  readonly findOrderForShipment?: FindOrderForShipment | undefined;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const orderNotFound = (): AppError => new AppError('Order not found', 404, 'ORDER_NOT_FOUND');

const findNoOrder: FindOrderForShipment = () => Promise.resolve(null);

export const createIntegrationsService = (
  client: DeliveryClient,
  {
    cache = createNoopCacheService(),
    quoteCacheTtlSeconds = DEFAULT_QUOTE_CACHE_TTL_SECONDS,
    findOrderForShipment = findNoOrder,
  }: IntegrationsServiceOptions = {},
): IntegrationsService => {
  /**
   * A parcel is only quoted or booked for an order that exists, that the caller
   * may see, and that is ready to leave the warehouse. A missing order and one
   * the caller may not see are the same answer, so the scope cannot be used to
   * probe for identifiers. The check runs before the carrier is asked anything,
   * and before the quote cache: a cached price is no licence to ship.
   */
  const assertShippableOrder = async (access: ShipmentAccess, orderId: string): Promise<void> => {
    if (access.orderScope === null || !UUID_PATTERN.test(orderId)) throw orderNotFound();
    const order = await findOrderForShipment(orderId, {
      actorId: access.actorId,
      scope: access.orderScope,
    });
    if (!order) throw orderNotFound();
    if ((shippableOrderStatuses as readonly string[]).includes(order.status)) return;
    throw new AppError(
      'Order cannot be shipped in its current status',
      409,
      'ORDER_NOT_SHIPPABLE',
      {
        status: order.status,
        allowed: shippableOrderStatuses,
      },
    );
  };

  return {
    async requestQuote(access, data) {
      await assertShippableOrder(access, data.orderId);
      // Quotes are stable for a short window and are by far the most repeated
      // call, so they are memoised. `remember` fails open: an unreachable cache
      // degrades to a live lookup rather than to an error.
      return cache.remember(quoteCacheKey(data), quoteCacheTtlSeconds, () =>
        client.requestQuote(data),
      );
    },

    // Deliberately not cached: creating a shipment is a side effect.
    async createShipment(access, data) {
      await assertShippableOrder(access, data.orderId);
      return client.createShipment(data);
    },

    // Deliberately not cached: a tracking status that lags is worse than useless.
    getShipment: (shipmentId) => client.getShipment(shipmentId),

    health: () => client.health(),
  };
};
