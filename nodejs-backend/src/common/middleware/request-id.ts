import { randomUUID } from 'node:crypto';

import type { RequestHandler } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Upper bound for an inbound correlation id we are willing to echo back. */
export const MAX_REQUEST_ID_LENGTH = 128;

/**
 * Correlation ids are echoed into response headers and log lines, so only a
 * conservative, header-safe alphabet is accepted: alphanumerics plus the
 * separators used by UUIDs, ULIDs and W3C trace ids. Anything else (control
 * characters, CR/LF, spaces, unicode) is discarded and replaced with a fresh
 * generated id rather than reflected back to the caller.
 */
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export const isSafeRequestId = (
  value: unknown,
  maxLength: number = MAX_REQUEST_ID_LENGTH,
): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maxLength &&
  SAFE_REQUEST_ID_PATTERN.test(value);

/**
 * Normalises an inbound header value into a usable correlation id, falling back
 * to a generated UUID v4 when the value is missing, duplicated or unsafe.
 */
export const resolveRequestId = (
  headerValue: string | readonly string[] | undefined,
  maxLength: number = MAX_REQUEST_ID_LENGTH,
): string => {
  // Duplicated headers arrive as an array; trust only an unambiguous single value.
  const candidate = typeof headerValue === 'string' ? headerValue.trim() : undefined;

  return isSafeRequestId(candidate, maxLength) ? candidate : randomUUID();
};

export interface RequestIdOptions {
  /** Header carrying the correlation id in both directions. */
  readonly header?: string;
  /** Maximum accepted length of an inbound id. */
  readonly maxLength?: number;
  /** When `false`, inbound ids are ignored and a fresh id is always generated. */
  readonly trustInboundHeader?: boolean;
}

/**
 * Assigns a correlation id to every request.
 *
 * Mount this before the request logger: the logger reuses an already assigned
 * `request.id` instead of deriving its own, which keeps a single id across the
 * response header, the access log and the error envelope.
 */
export const createRequestId = (options: RequestIdOptions = {}): RequestHandler => {
  const header = (options.header ?? REQUEST_ID_HEADER).toLowerCase();
  const maxLength = options.maxLength ?? MAX_REQUEST_ID_LENGTH;
  const trustInboundHeader = options.trustInboundHeader ?? true;

  return (request, response, next) => {
    const inbound = trustInboundHeader ? request.headers[header] : undefined;
    const requestId = resolveRequestId(inbound, maxLength);

    request.id = requestId;
    response.setHeader(header, requestId);
    next();
  };
};
