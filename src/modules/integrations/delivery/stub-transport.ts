import { createHash } from 'node:crypto';

import type { DeliveryTransport, DeliveryTransportResponse } from './transport.js';

/**
 * In-repo stand-in for the delivery provider.
 *
 * The default configuration has no base URL, and without this the whole feature
 * would be dead on a fresh checkout. The stub keeps the system runnable
 * end-to-end with no account, no key and no network: it speaks exactly the wire
 * format the real service is documented to speak, so the client code under test
 * is the same code that runs in production.
 *
 * It is deterministic — the same order always produces the same quote — which
 * makes it usable as a fixture as well as a placeholder.
 */
export interface StubDeliveryTransportOptions {
  /** Injectable clock so generated timestamps are stable in tests. */
  readonly now?: (() => number) | undefined;
}

interface StoredShipment {
  readonly shipment_id: string;
  readonly order_id: string;
  readonly status: string;
  readonly carrier: string;
  readonly tracking_number: string;
  readonly created_at: string;
  readonly estimated_delivery_at: string;
}

const CARRIER = 'Stub Express';
const DAY_MS = 24 * 60 * 60 * 1_000;

// A short, stable id derived from the payload keeps runs reproducible without
// pulling in a random source.
const digest = (prefix: string, value: unknown): string =>
  `${prefix}_${createHash('sha256')
    .update(JSON.stringify(value) ?? '')
    .digest('hex')
    .slice(0, 16)}`;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const readNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const json = (status: number, body: unknown): DeliveryTransportResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body,
});

export const createStubDeliveryTransport = ({
  now = Date.now,
}: StubDeliveryTransportOptions = {}): DeliveryTransport => {
  const shipments = new Map<string, StoredShipment>();

  const quoteFor = (body: unknown): DeliveryTransportResponse => {
    const payload = asRecord(body);
    const parcel = asRecord(payload.parcel);
    const weightGrams = readNumber(parcel.weightGrams, 1_000);
    // Flat fee plus a linear weight component, in whole cents.
    const cents = 499 + Math.ceil(weightGrams / 100) * 25;

    return json(200, {
      quote_id: digest('qte', payload),
      carrier: CARRIER,
      service: weightGrams > 20_000 ? 'freight' : 'standard',
      amount: (cents / 100).toFixed(2),
      currency: 'EUR',
      estimated_days: weightGrams > 20_000 ? 5 : 3,
      expires_at: new Date(now() + DAY_MS).toISOString(),
    });
  };

  const createShipment = (body: unknown): DeliveryTransportResponse => {
    const payload = asRecord(body);
    const orderId = typeof payload.order_id === 'string' ? payload.order_id : 'unknown-order';
    const shipmentId = digest('shp', payload);
    const shipment: StoredShipment = {
      shipment_id: shipmentId,
      order_id: orderId,
      status: 'CREATED',
      carrier: CARRIER,
      tracking_number: digest('trk', shipmentId).toUpperCase(),
      created_at: new Date(now()).toISOString(),
      estimated_delivery_at: new Date(now() + 3 * DAY_MS).toISOString(),
    };
    shipments.set(shipmentId, shipment);
    return json(201, shipment);
  };

  return {
    kind: 'stub',
    send(request) {
      if (request.method === 'POST' && request.path === '/v1/quotes') {
        return Promise.resolve(quoteFor(request.body));
      }

      if (request.method === 'POST' && request.path === '/v1/shipments') {
        return Promise.resolve(createShipment(request.body));
      }

      if (request.method === 'GET' && request.path.startsWith('/v1/shipments/')) {
        const id = decodeURIComponent(request.path.slice('/v1/shipments/'.length));
        const shipment = shipments.get(id);
        return Promise.resolve(
          shipment === undefined
            ? json(404, { error: 'not_found' })
            : json(200, { ...shipment, status: 'IN_TRANSIT' }),
        );
      }

      return Promise.resolve(json(404, { error: 'not_found' }));
    },
  };
};
