/**
 * The seam between the delivery client and the outside world.
 *
 * Everything the client does — retries, backoff, the circuit breaker, response
 * validation — is expressed in terms of this port. Production wires the `fetch`
 * transport, the default configuration wires the in-repo stub, and tests wire a
 * hand-written fake. No layer above ever learns which one is in use.
 */
export interface DeliveryTransportRequest {
  readonly method: 'GET' | 'POST';
  /** Path relative to the upstream base URL, always starting with a slash. */
  readonly path: string;
  readonly body?: unknown;
  /**
   * Per-attempt deadline; the transport must abort when it fires. Set by the
   * retry layer on every attempt, so leaf transports never need to think
   * about it themselves.
   */
  readonly signal?: AbortSignal | undefined;
  /**
   * Only idempotent calls are retried. Replaying a shipment creation after a
   * timeout could hand the customer two parcels, so a non-idempotent call is
   * sent once and its failure is reported honestly. Leaf transports ignore
   * this field; it exists for the retry layer.
   */
  readonly idempotent?: boolean | undefined;
}

export interface DeliveryTransportResponse {
  readonly status: number;
  /** Lower-cased header names. Only the headers the client reads are needed. */
  readonly headers: Readonly<Record<string, string>>;
  /** Parsed JSON payload, or `undefined` when the body was empty or not JSON. */
  readonly body: unknown;
}

export interface DeliveryTransport {
  /** Labels the transport in the health endpoint. */
  readonly kind: 'stub' | 'http';
  send(request: DeliveryTransportRequest): Promise<DeliveryTransportResponse>;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface FetchDeliveryTransportOptions {
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  /** Injectable for tests; defaults to the global `fetch` from Node. */
  readonly fetchImpl?: FetchLike | undefined;
}

// Only the headers the retry logic actually inspects are carried across the
// seam, so nothing sensitive from the upstream response can leak by accident.
const FORWARDED_HEADERS = ['retry-after', 'content-type'] as const;

const readHeaders = (response: Response): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return headers;
};

const readBody = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A non-JSON body is not an error here: the client's Zod validation turns
    // it into a controlled DELIVERY_INVALID_RESPONSE further up.
    return undefined;
  }
};

/** Last-resort deadline for a caller that supplied none; see `send` below. */
const FALLBACK_TIMEOUT_MS = 30_000;

export const createFetchDeliveryTransport = ({
  baseUrl,
  apiKey,
  fetchImpl,
}: FetchDeliveryTransportOptions): DeliveryTransport => {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const doFetch: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init));

  return {
    kind: 'http',
    async send(request) {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`;
      if (request.body !== undefined) headers['content-type'] = 'application/json';

      // The retry layer sets a deadline on every attempt, so in practice the
      // fallback never fires. It exists because the alternative to a missing
      // deadline is a socket that hangs for as long as the upstream keeps it
      // open, and a request that never returns is far worse than one that
      // gives up late.
      const response = await doFetch(`${normalizedBaseUrl}${request.path}`, {
        method: request.method,
        headers,
        signal: request.signal ?? AbortSignal.timeout(FALLBACK_TIMEOUT_MS),
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });

      return {
        status: response.status,
        headers: readHeaders(response),
        body: await readBody(response),
      };
    },
  };
};
