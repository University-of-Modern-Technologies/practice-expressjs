import type { Logger } from 'pino';
import type { z } from 'zod';

import type {
  CreateShipmentData,
  DeliveryHealthDto,
  DeliveryQuoteDto,
  QuoteRequestData,
  ShipmentDto,
} from '../types.js';
import { createCircuitBreaker, type CircuitBreaker } from './circuit-breaker.js';
import { deliveryInvalidResponseError } from './errors.js';
import {
  DEFAULT_BASE_BACKOFF_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_MAX_RETRY_AFTER_MS,
  DEFAULT_TIMEOUT_MS,
  parseRetryAfterMs,
  withRetry,
} from './retry.js';
import {
  toDeliveryQuoteDto,
  toShipmentDto,
  upstreamQuoteSchema,
  upstreamShipmentSchema,
} from './schemas.js';
import type { DeliveryTransport } from './transport.js';
import { withCircuitBreaker } from './with-circuit-breaker.js';

export {
  DEFAULT_BASE_BACKOFF_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_MAX_RETRY_AFTER_MS,
  DEFAULT_TIMEOUT_MS,
  parseRetryAfterMs,
};

export interface DeliveryClientOptions {
  readonly transport: DeliveryTransport;
  /** Per-attempt deadline enforced with `AbortSignal.timeout`. */
  readonly timeoutMs?: number | undefined;
  /** Total attempts for an idempotent call, including the first one. */
  readonly maxAttempts?: number | undefined;
  readonly baseBackoffMs?: number | undefined;
  readonly maxBackoffMs?: number | undefined;
  readonly maxRetryAfterMs?: number | undefined;
  readonly failureThreshold?: number | undefined;
  readonly cooldownMs?: number | undefined;
  readonly logger?: Logger | undefined;
  /** Injectable clock, randomness and sleep keep the tests deterministic. */
  readonly now?: (() => number) | undefined;
  readonly random?: (() => number) | undefined;
  readonly delay?: ((ms: number) => Promise<void>) | undefined;
}

export interface DeliveryClient {
  requestQuote(data: QuoteRequestData): Promise<DeliveryQuoteDto>;
  createShipment(data: CreateShipmentData): Promise<ShipmentDto>;
  getShipment(shipmentId: string): Promise<ShipmentDto>;
  health(): DeliveryHealthDto;
}

interface CallSpec<TSchema extends z.ZodType> {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  /**
   * Only idempotent calls are retried. Replaying a shipment creation after a
   * timeout could hand the customer two parcels, so that one is sent once and
   * its failure is reported honestly.
   */
  readonly idempotent: boolean;
  readonly schema: TSchema;
}

export const createDeliveryClient = ({
  transport,
  timeoutMs,
  maxAttempts,
  baseBackoffMs,
  maxBackoffMs,
  maxRetryAfterMs,
  failureThreshold,
  cooldownMs,
  logger,
  now = Date.now,
  random,
  delay,
}: DeliveryClientOptions): DeliveryClient => {
  const breaker: CircuitBreaker = createCircuitBreaker({ failureThreshold, cooldownMs, now });

  // Order matters: the breaker must see every attempt, not just the first, so
  // it sits inside the retry loop rather than around it.
  const wire = withRetry(withCircuitBreaker(transport, { breaker, logger }), {
    timeoutMs,
    maxAttempts,
    baseBackoffMs,
    maxBackoffMs,
    maxRetryAfterMs,
    logger,
    now,
    random,
    delay,
  });

  const parse = <TSchema extends z.ZodType>(schema: TSchema, body: unknown): z.infer<TSchema> => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      // The details stay in our logs: the client only learns that the upstream
      // contract was violated, never what the upstream actually sent.
      logger?.error(
        { issues: parsed.error.issues },
        'Delivery service returned a payload that failed validation',
      );
      throw deliveryInvalidResponseError();
    }
    return parsed.data as z.infer<TSchema>;
  };

  const call = async <TSchema extends z.ZodType>(
    spec: CallSpec<TSchema>,
  ): Promise<z.infer<TSchema>> => {
    const response = await wire.send({
      method: spec.method,
      path: spec.path,
      idempotent: spec.idempotent,
      ...(spec.body === undefined ? {} : { body: spec.body }),
    });
    return parse(spec.schema, response.body);
  };

  return {
    async requestQuote(data) {
      // A quote is a pure read: computing it twice costs nothing, so it retries.
      const quote = await call({
        method: 'POST',
        path: '/v1/quotes',
        idempotent: true,
        schema: upstreamQuoteSchema,
        body: {
          order_id: data.orderId,
          origin: data.origin,
          destination: data.destination,
          parcel: data.parcel,
          ...(data.declaredValue === undefined ? {} : { declared_value: data.declaredValue }),
        },
      });
      return toDeliveryQuoteDto(quote);
    },

    async createShipment(data) {
      const shipment = await call({
        method: 'POST',
        path: '/v1/shipments',
        idempotent: false,
        schema: upstreamShipmentSchema,
        body: {
          quote_id: data.quoteId,
          order_id: data.orderId,
          destination: data.destination,
          parcel: data.parcel,
          ...(data.reference === undefined ? {} : { reference: data.reference }),
        },
      });
      return toShipmentDto(shipment);
    },

    async getShipment(shipmentId) {
      const shipment = await call({
        method: 'GET',
        path: `/v1/shipments/${encodeURIComponent(shipmentId)}`,
        idempotent: true,
        schema: upstreamShipmentSchema,
      });
      return toShipmentDto(shipment);
    },

    health() {
      const snapshot = breaker.snapshot();
      return {
        transport: transport.kind,
        circuitState: snapshot.state,
        consecutiveFailures: snapshot.consecutiveFailures,
        lastErrorAt:
          snapshot.lastErrorAt === null ? null : new Date(snapshot.lastErrorAt).toISOString(),
        openedAt: snapshot.openedAt === null ? null : new Date(snapshot.openedAt).toISOString(),
      };
    },
  };
};
