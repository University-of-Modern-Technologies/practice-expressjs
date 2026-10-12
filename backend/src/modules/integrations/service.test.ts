import { describe, expect, it, jest } from '@jest/globals';

import type { CacheService } from '../../cache/cache.service.js';
import { createConfiguredDeliveryClient } from './delivery/factory.js';
import {
  createIntegrationsService,
  quoteCacheKey,
  type IntegrationsServiceOptions,
} from './service.js';
import type {
  FindOrderForShipment,
  QuoteRequestData,
  ShipmentAccess,
  ShipmentOrder,
} from './types.js';

const ORDER_ID = '7f1d2c3b-4a59-4e6f-8a7b-1c2d3e4f5a6b';
const access: ShipmentAccess = { actorId: 'user-1', orderScope: 'ALL' };

const quoteRequest: QuoteRequestData = {
  orderId: ORDER_ID,
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

/** An order book holding one order, in whichever status the test needs. */
const orderBook = (order: ShipmentOrder | null = { status: 'CONFIRMED' }) =>
  jest.fn<FindOrderForShipment>(async () => order);

const serviceWith = (
  client = createConfiguredDeliveryClient(),
  options: IntegrationsServiceOptions = {},
) => createIntegrationsService(client, { findOrderForShipment: orderBook(), ...options });

describe('integrations service', () => {
  it('runs end to end on the built-in stub transport with no configuration', async () => {
    const service = serviceWith();

    const quote = await service.requestQuote(access, quoteRequest);
    expect(quote).toMatchObject({ carrier: 'Stub Express', currency: 'EUR', estimatedDays: 3 });

    const shipment = await service.createShipment(access, {
      quoteId: quote.quoteId,
      orderId: quoteRequest.orderId,
      destination: quoteRequest.destination,
      parcel: quoteRequest.parcel,
    });
    expect(shipment).toMatchObject({ status: 'CREATED', orderId: ORDER_ID });

    const fetched = await service.getShipment(shipment.shipmentId);
    expect(fetched.shipmentId).toBe(shipment.shipmentId);
    expect(service.health()).toMatchObject({ transport: 'stub', circuitState: 'closed' });
  });

  it('produces the same quote for the same input', async () => {
    const service = serviceWith();

    const first = await service.requestQuote(access, quoteRequest);
    const second = await service.requestQuote(access, quoteRequest);
    expect(second.quoteId).toBe(first.quoteId);
  });

  it('serves a repeated quote lookup from the cache', async () => {
    const client = createConfiguredDeliveryClient();
    const spy = jest.spyOn(client, 'requestQuote');
    const service = serviceWith(client, { cache: memoryCache() });

    await service.requestQuote(access, quoteRequest);
    await service.requestQuote(access, quoteRequest);

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
    const service = serviceWith(client, { cache: memoryCache() });

    const data = {
      quoteId: 'qte_1',
      orderId: ORDER_ID,
      destination: quoteRequest.destination,
      parcel: quoteRequest.parcel,
    };
    await service.createShipment(access, data);
    await service.createShipment(access, data);

    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('the order a delivery is for', () => {
  const shipment = {
    quoteId: 'qte_1',
    orderId: ORDER_ID,
    destination: quoteRequest.destination,
    parcel: quoteRequest.parcel,
  };

  it.each(['CONFIRMED', 'PAID'])('ships an order that is %s', async (status) => {
    const findOrderForShipment = orderBook({ status });
    const service = serviceWith(undefined, { findOrderForShipment });

    await expect(service.createShipment(access, shipment)).resolves.toMatchObject({
      orderId: ORDER_ID,
    });
    expect(findOrderForShipment).toHaveBeenCalledWith(ORDER_ID, {
      actorId: 'user-1',
      scope: 'ALL',
    });
  });

  it.each(['DRAFT', 'CANCELLED', 'FULFILLED'])(
    'refuses an order that is %s before the carrier is asked',
    async (status) => {
      const client = createConfiguredDeliveryClient();
      const quote = jest.spyOn(client, 'requestQuote');
      const book = jest.spyOn(client, 'createShipment');
      const service = serviceWith(client, { findOrderForShipment: orderBook({ status }) });

      await expect(service.requestQuote(access, quoteRequest)).rejects.toMatchObject({
        statusCode: 409,
        code: 'ORDER_NOT_SHIPPABLE',
        details: { status, allowed: ['CONFIRMED', 'PAID'] },
      });
      await expect(service.createShipment(access, shipment)).rejects.toMatchObject({
        statusCode: 409,
        code: 'ORDER_NOT_SHIPPABLE',
      });
      expect(quote).not.toHaveBeenCalled();
      expect(book).not.toHaveBeenCalled();
    },
  );

  it('reports a missing, deleted or invisible order as not found', async () => {
    const client = createConfiguredDeliveryClient();
    const book = jest.spyOn(client, 'createShipment');
    const service = serviceWith(client, { findOrderForShipment: orderBook(null) });

    await expect(service.createShipment(access, shipment)).rejects.toMatchObject({
      statusCode: 404,
      code: 'ORDER_NOT_FOUND',
    });
    expect(book).not.toHaveBeenCalled();
  });

  it('narrows the lookup to the caller when their order grant is OWN', async () => {
    const findOrderForShipment = orderBook();
    const service = serviceWith(undefined, { findOrderForShipment });

    await service.requestQuote({ actorId: 'user-7', orderScope: 'OWN' }, quoteRequest);

    expect(findOrderForShipment).toHaveBeenCalledWith(ORDER_ID, {
      actorId: 'user-7',
      scope: 'OWN',
    });
  });

  it('treats a caller who sees no orders, or an identifier that is no order id, as not found', async () => {
    const findOrderForShipment = orderBook();
    const service = serviceWith(undefined, { findOrderForShipment });

    await expect(
      service.requestQuote({ actorId: 'user-1', orderScope: null }, quoteRequest),
    ).rejects.toMatchObject({ statusCode: 404, code: 'ORDER_NOT_FOUND' });
    await expect(
      service.createShipment(access, { ...shipment, orderId: 'ord_1' }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'ORDER_NOT_FOUND' });
    expect(findOrderForShipment).not.toHaveBeenCalled();
  });

  it('checks the order even when the quote is already cached', async () => {
    const findOrderForShipment = jest
      .fn<FindOrderForShipment>()
      .mockResolvedValueOnce({ status: 'CONFIRMED' })
      .mockResolvedValueOnce({ status: 'CANCELLED' });
    const service = serviceWith(undefined, { cache: memoryCache(), findOrderForShipment });

    await service.requestQuote(access, quoteRequest);

    await expect(service.requestQuote(access, quoteRequest)).rejects.toMatchObject({
      code: 'ORDER_NOT_SHIPPABLE',
    });
  });

  it('refuses every delivery until an order lookup is wired in', async () => {
    const service = createIntegrationsService(createConfiguredDeliveryClient());

    await expect(service.requestQuote(access, quoteRequest)).rejects.toMatchObject({
      statusCode: 404,
      code: 'ORDER_NOT_FOUND',
    });
  });
});
