import { z } from 'zod';

import { currencyCodeSchema, decimalStringSchema } from '../../common/openapi/index.js';
import type { PermissionScope } from '../rbac/types.js';

// Domain-facing shapes for the delivery integration. They are deliberately
// separate from the wire schemas in `delivery/schemas.ts`: the upstream service
// is free to change its payload, and only the mapping layer has to follow.

export const shipmentStatuses = [
  'CREATED',
  'IN_TRANSIT',
  'DELIVERED',
  'CANCELLED',
  'FAILED',
] as const;
export type ShipmentStatus = (typeof shipmentStatuses)[number];

export const shipmentStatusSchema = z.enum(shipmentStatuses).meta({ id: 'ShipmentStatus' });

/**
 * Order statuses a parcel may leave the warehouse in: confirmed (stock is
 * reserved) or already paid. A draft has nothing reserved yet, a cancelled
 * order has released its stock, and a fulfilled one has already been shipped.
 */
export const shippableOrderStatuses = ['CONFIRMED', 'PAID'] as const;

/**
 * Who is asking for a delivery, and how much of the order book they may see.
 * The breadth is the caller's `orders:read` grant, not their integrations one:
 * whether an order is visible is a question about orders. `null` means the
 * caller sees no orders at all.
 */
export interface ShipmentAccess {
  readonly actorId: string;
  readonly orderScope: PermissionScope | null;
}

/** The little the delivery integration needs to know about an order. */
export interface ShipmentOrder {
  readonly status: string;
}

/**
 * Reads the order a delivery is requested for.
 *
 * Contract for the implementation: return the order only if it exists, is not
 * soft-deleted and is visible at `scope` (`OWN` — owned by `actorId`; `ALL` —
 * any owner); otherwise `null`. `orderId` is always a UUID by the time this is
 * called. Status checks are the caller's business, so any status is returned.
 */
export type FindOrderForShipment = (
  orderId: string,
  access: { readonly actorId: string; readonly scope: PermissionScope },
) => Promise<ShipmentOrder | null>;

export interface DeliveryAddress {
  readonly country: string;
  readonly city: string;
  readonly postalCode: string;
  readonly line1: string;
}

export interface DeliveryParcel {
  readonly weightGrams: number;
  readonly lengthCm: number;
  readonly widthCm: number;
  readonly heightCm: number;
}

export interface QuoteRequestData {
  readonly orderId: string;
  readonly origin: DeliveryAddress;
  readonly destination: DeliveryAddress;
  readonly parcel: DeliveryParcel;
  readonly declaredValue?: string | undefined;
}

export const deliveryQuoteSchema = z
  .object({
    quoteId: z.string(),
    carrier: z.string(),
    service: z.string(),
    amount: decimalStringSchema,
    currency: currencyCodeSchema,
    estimatedDays: z.int().min(0),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'DeliveryQuote' });

export type DeliveryQuoteDto = Readonly<z.infer<typeof deliveryQuoteSchema>>;

export interface CreateShipmentData {
  readonly quoteId: string;
  readonly orderId: string;
  readonly destination: DeliveryAddress;
  readonly parcel: DeliveryParcel;
  readonly reference?: string | undefined;
}

export const shipmentSchema = z
  .object({
    shipmentId: z.string(),
    orderId: z.string(),
    status: shipmentStatusSchema,
    carrier: z.string(),
    trackingNumber: z.string().nullable(),
    createdAt: z.iso.datetime(),
    estimatedDeliveryAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Shipment' });

export type ShipmentDto = Readonly<z.infer<typeof shipmentSchema>>;

const circuitStates = ['closed', 'open', 'half-open'] as const;
export type CircuitState = (typeof circuitStates)[number];

/**
 * Health payload for the integration. It intentionally carries no base URL, no
 * credentials and no upstream error text — only the facts an operator needs to
 * decide whether the dependency is healthy.
 */
export const deliveryHealthSchema = z
  .object({
    transport: z.enum(['stub', 'http']),
    circuitState: z.enum(circuitStates),
    consecutiveFailures: z.int().min(0),
    lastErrorAt: z.iso.datetime().nullable(),
    openedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'DeliveryHealth' });

export type DeliveryHealthDto = Readonly<z.infer<typeof deliveryHealthSchema>>;
