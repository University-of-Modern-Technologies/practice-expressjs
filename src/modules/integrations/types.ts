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

export interface DeliveryQuoteDto {
  readonly quoteId: string;
  readonly carrier: string;
  readonly service: string;
  readonly amount: string;
  readonly currency: string;
  readonly estimatedDays: number;
  readonly expiresAt: string;
}

export interface CreateShipmentData {
  readonly quoteId: string;
  readonly orderId: string;
  readonly destination: DeliveryAddress;
  readonly parcel: DeliveryParcel;
  readonly reference?: string | undefined;
}

export interface ShipmentDto {
  readonly shipmentId: string;
  readonly orderId: string;
  readonly status: ShipmentStatus;
  readonly carrier: string;
  readonly trackingNumber: string | null;
  readonly createdAt: string;
  readonly estimatedDeliveryAt: string | null;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Health payload for the integration. It intentionally carries no base URL, no
 * credentials and no upstream error text — only the facts an operator needs to
 * decide whether the dependency is healthy.
 */
export interface DeliveryHealthDto {
  readonly transport: 'stub' | 'http';
  readonly circuitState: CircuitState;
  readonly consecutiveFailures: number;
  readonly lastErrorAt: string | null;
  readonly openedAt: string | null;
}
