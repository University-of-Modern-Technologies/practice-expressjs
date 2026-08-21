import type { Logger } from 'pino';

import type { CircuitBreaker } from './circuit-breaker.js';
import type { DeliveryTransport, DeliveryTransportResponse } from './transport.js';

const isTransientStatus = (status: number): boolean => status === 429 || status >= 500;

/**
 * Internal signal that the breaker refused the call before any network
 * activity happened. The retry layer catches this specifically: an open
 * circuit must fail fast, not consume another attempt or wait out a backoff.
 */
export class CircuitOpenError extends Error {
  public constructor() {
    super('Delivery circuit breaker is open');
    this.name = 'CircuitOpenError';
  }
}

export interface WithCircuitBreakerOptions {
  readonly breaker: CircuitBreaker;
  readonly logger?: Logger | undefined;
}

/**
 * Wraps a `DeliveryTransport` with a circuit breaker. Every attempt made by
 * the caller — including retries — passes through here, so the breaker sees
 * the true call volume rather than just the first attempt of each request.
 *
 * Only transient outcomes count against the breaker: network errors,
 * timeouts, 429 and 5xx. A 4xx response proves the upstream is alive and is
 * reported as a success, so a stream of bad requests from our side can never
 * trip it open.
 */
export const withCircuitBreaker = (
  transport: DeliveryTransport,
  { breaker, logger }: WithCircuitBreakerOptions,
): DeliveryTransport => ({
  kind: transport.kind,
  async send(request) {
    if (!breaker.tryAcquire()) {
      logger?.warn({ path: request.path }, 'Delivery call short-circuited: breaker is open');
      throw new CircuitOpenError();
    }

    let response: DeliveryTransportResponse;
    try {
      response = await transport.send(request);
    } catch (error) {
      // A timeout or a socket error says nothing about our request and
      // everything about the dependency, so the breaker hears about it.
      breaker.onFailure();
      throw error;
    }

    if (response.status >= 200 && response.status < 300) {
      breaker.onSuccess();
    } else if (isTransientStatus(response.status)) {
      breaker.onFailure();
    } else {
      // 4xx: the service is alive and is refusing *this* request. It must
      // not trip the breaker.
      breaker.onSuccess();
    }

    return response;
  },
});
