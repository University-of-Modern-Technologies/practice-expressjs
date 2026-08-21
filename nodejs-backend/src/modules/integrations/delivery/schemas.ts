import { z } from 'zod';

import { shipmentStatuses, type DeliveryQuoteDto, type ShipmentDto } from '../types.js';

// Contracts for the *upstream* payloads. Nothing that comes back from a service
// we do not control is trusted: every response is parsed through one of these
// schemas before a single field of it is read. If the provider renames a field
// or starts returning `null` where a number used to be, the failure surfaces
// here as a controlled DELIVERY_INVALID_RESPONSE instead of as a `TypeError`
// thrown three layers deeper.

const moneyString = z
  .string()
  .trim()
  .regex(/^\d{1,12}(?:\.\d{1,2})?$/, 'Invalid monetary amount');

const currencyCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/)
  .transform((value) => value.toUpperCase());

export const upstreamQuoteSchema = z.object({
  quote_id: z.string().min(1),
  carrier: z.string().min(1),
  service: z.string().min(1),
  amount: moneyString,
  currency: currencyCode,
  estimated_days: z.number().int().min(0).max(365),
  expires_at: z.iso.datetime(),
});

export const upstreamShipmentSchema = z.object({
  shipment_id: z.string().min(1),
  order_id: z.string().min(1),
  status: z.enum(shipmentStatuses),
  carrier: z.string().min(1),
  tracking_number: z.string().min(1).nullable().default(null),
  created_at: z.iso.datetime(),
  estimated_delivery_at: z.iso.datetime().nullable().default(null),
});

export type UpstreamQuote = z.infer<typeof upstreamQuoteSchema>;
export type UpstreamShipment = z.infer<typeof upstreamShipmentSchema>;

// Snake-case wire shape is translated into the camel-case domain DTO in exactly
// one place, so renaming a field upstream is a one-line change here.
export const toDeliveryQuoteDto = (quote: UpstreamQuote): DeliveryQuoteDto => ({
  quoteId: quote.quote_id,
  carrier: quote.carrier,
  service: quote.service,
  amount: quote.amount,
  currency: quote.currency,
  estimatedDays: quote.estimated_days,
  expiresAt: quote.expires_at,
});

export const toShipmentDto = (shipment: UpstreamShipment): ShipmentDto => ({
  shipmentId: shipment.shipment_id,
  orderId: shipment.order_id,
  status: shipment.status,
  carrier: shipment.carrier,
  trackingNumber: shipment.tracking_number,
  createdAt: shipment.created_at,
  estimatedDeliveryAt: shipment.estimated_delivery_at,
});
