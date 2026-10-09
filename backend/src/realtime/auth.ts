import type { IncomingHttpHeaders } from 'node:http';

/**
 * Marker subprotocol. A browser client opens the socket as
 * `new WebSocket(url, ['bearer', accessToken])`; native clients may instead
 * send a normal `Authorization: Bearer <token>` header.
 *
 * There is deliberately no single-value form such as `access_token.<jwt>`. A
 * browser fails any handshake whose response does not echo one of the offered
 * subprotocols, and echoing that entry would put the token itself into the
 * response headers — so such a form could only ever serve clients that can
 * send `Authorization` anyway.
 */
export const BEARER_SUBPROTOCOL = 'bearer';

const AUTHORIZATION_SCHEME = 'bearer ';

const headerToList = (value: string | string[] | undefined): readonly string[] => {
  if (value === undefined) return [];
  const raw = Array.isArray(value) ? value.join(',') : value;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const fromAuthorizationHeader = (headers: IncomingHttpHeaders): string | null => {
  const header = headers.authorization;
  if (typeof header !== 'string') return null;
  if (!header.toLowerCase().startsWith(AUTHORIZATION_SCHEME)) return null;

  const token = header.slice(AUTHORIZATION_SCHEME.length).trim();
  return token.length > 0 ? token : null;
};

const fromSubprotocolHeader = (headers: IncomingHttpHeaders): string | null => {
  const protocols = headerToList(headers['sec-websocket-protocol']);

  for (let index = 0; index < protocols.length; index += 1) {
    const entry = protocols[index];
    if (entry === undefined) continue;

    if (entry.toLowerCase() === BEARER_SUBPROTOCOL) {
      const token = protocols[index + 1];
      if (token !== undefined && token.length > 0) return token;
    }
  }

  return null;
};

/**
 * Extracts the access token from an upgrade request.
 *
 * SECURITY: the query string is deliberately NOT consulted. Query parameters
 * are written to access logs, proxy logs and `Referer` headers, so a token
 * placed there leaks far beyond the connection it was minted for. Callers that
 * cannot set headers must use the `Sec-WebSocket-Protocol` form instead.
 */
export const extractAccessToken = (headers: IncomingHttpHeaders): string | null =>
  fromAuthorizationHeader(headers) ?? fromSubprotocolHeader(headers);
