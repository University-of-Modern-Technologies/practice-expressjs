import { describe, expect, it, jest } from '@jest/globals';

import type { CacheService } from '../../cache/cache.service.js';
import { createConfiguredDeliveryClient } from './delivery/factory.js';
import { createIntegrationsService, quoteCacheKey } from './service.js';
import type { QuoteRequestData } from './types.js';

const quoteRequest: QuoteRequestData = {
  orderId: 'ord_1',
  origin: { country: 'PL', city: 'Warsaw', postalCode: '00-001', line1: 'Street 1' },
  destination: { country: 'DE', city: 'Berlin', postalCode: '10115', line1: 'Street 2' },
  parcel: { weightGrams: 1_000, lengthCm: 10, widthCm: 10, heightCm: 10 },
};

/** Minimal in-memory cache; enough to prove the memoisation actually happens. */
const memoryCache = (): CacheService => {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string) {
      return Promise.resolve((store.get(key) as T | undefined) ?? null);
    },
    set<T>(key: string, value: T) {
      store.set(key, value);
      return Promise.resolve();
    },
    async remember<T>(key: string, _ttlSeconds: number, loader: () => Promise<T>) {
      const cached = store.get(key) as T | undefined;
      if (cached !== undefined) return cached;
      const value = await loader();
      store.set(key, value);
      return value;
    },
    del() {
      return Promise.resolve();
    },
    invalidatePrefix() {
      return Promise.resolve();
    },
  };
};

describe('integrations service', () => {
  it('runs end to end on the built-in stub transport with no configuration', async () => {
    const service = createIntegrationsService(createConfiguredDeliveryClient());

    const quote = await service.requestQuote(quoteRequest);
    expect(quote).toMatchObject({ carrier: 'Stub Express', currency: 'EUR', estimatedDays: 3 });

    const shipment = await service.createShipment({
      quoteId: quote.quoteId,
      orderId: quoteRequest.orderId,
      destination: quoteRequest.destination,
      parcel: quoteRequest.parcel,
    });
    expect(shipment).toMatchObject({ status: 'CREATED', orderId: 'ord_1' });

    const fetched = await service.getShipment(shipment.shipmentId);
    expect(fetched.shipmentId).toBe(shipment.shipmentId);
    expect(service.health()).toMatchObject({ transport: 'stub', circuitState: 'closed' });
  });

  it('produces the same quote for the same input', async () => {
    const service = createIntegrationsService(createConfiguredDeliveryClient());

    const first = await service.requestQuote(quoteRequest);
    const second = await service.requestQuote(quoteRequest);
    expect(second.quoteId).toBe(first.quoteId);
  });

  it('serves a repeated quote lookup from the cache', async () => {
    const client = createConfiguredDeliveryClient();
    const spy = jest.spyOn(client, 'requestQuote');
    const service = createIntegrationsService(client, { cache: memoryCache() });

    await service.requestQuote(quoteRequest);
    await service.requestQuote(quoteRequest);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('ignores key order when building the cache key', () => {
    const reordered = {
      parcel: quoteRequest.parcel,
      destination: quoteRequest.destination,
      origin: quoteRequest.origin,
      orderId: quoteRequest.orderId,
    } as QuoteRequestData;

    expect(quoteCacheKey(reordered)).toBe(quoteCacheKey(quoteRequest));
    expect(quoteCacheKey({ ...quoteRequest, orderId: 'ord_2' })).not.toBe(
      quoteCacheKey(quoteRequest),
    );
  });

  it('never caches shipment creation', async () => {
    const client = createConfiguredDeliveryClient();
    const spy = jest.spyOn(client, 'createShipment');
    const service = createIntegrationsService(client, { cache: memoryCache() });

    const data = {
      quoteId: 'qte_1',
      orderId: 'ord_1',
      destination: quoteRequest.destination,
      parcel: quoteRequest.parcel,
    };
    await service.createShipment(data);
    await service.createShipment(data);

    expect(spy).toHaveBeenCalledTimes(2);
  });
});
