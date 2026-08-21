import { AppError } from '../../../common/errors/app-error.js';

/**
 * Every failure mode of the integration is translated into one of four codes.
 *
 * The messages are written for the *caller of our API*, not for whoever is
 * debugging the upstream: they never contain the base URL, the API key, the raw
 * response body or the upstream error text. Those belong in the log line, which
 * stays on our side of the boundary.
 */
export const DELIVERY_TIMEOUT = 'DELIVERY_TIMEOUT';
export const DELIVERY_UNAVAILABLE = 'DELIVERY_UNAVAILABLE';
export const DELIVERY_REJECTED = 'DELIVERY_REJECTED';
export const DELIVERY_INVALID_RESPONSE = 'DELIVERY_INVALID_RESPONSE';

/** The upstream did not answer within the per-request deadline. */
export const deliveryTimeoutError = (): AppError =>
  new AppError('The delivery service did not respond in time', 504, DELIVERY_TIMEOUT);

/** Network failure, 5xx, throttling, or a circuit that is currently open. */
export const deliveryUnavailableError = (): AppError =>
  new AppError('The delivery service is temporarily unavailable', 503, DELIVERY_UNAVAILABLE);

/**
 * The upstream understood the request and refused it. The service is healthy,
 * so this never counts against the circuit breaker. A 404 is passed through as
 * 404 so that "no such shipment" stays distinguishable from "bad request".
 */
export const deliveryRejectedError = (upstreamStatus: number): AppError =>
  new AppError(
    upstreamStatus === 404
      ? 'The delivery service has no record of this resource'
      : 'The delivery service rejected the request',
    upstreamStatus === 404 ? 404 : 422,
    DELIVERY_REJECTED,
  );

/** The upstream answered, but not with the payload its contract promises. */
export const deliveryInvalidResponseError = (): AppError =>
  new AppError(
    'The delivery service returned an unexpected payload',
    502,
    DELIVERY_INVALID_RESPONSE,
  );
