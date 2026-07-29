import { WebSocketServer } from 'ws';

import { BEARER_SUBPROTOCOL } from './auth.js';
import type { RealtimeWebSocketServer } from './types.js';

/**
 * The single module that touches the transport library. Everything else in
 * `src/realtime` works against the structural `RealtimeSocket` /
 * `RealtimeWebSocketServer` interfaces, which keeps the gateway logic unit
 * testable without opening real sockets.
 */
export const createWebSocketServer = (maxPayloadBytes: number): RealtimeWebSocketServer => {
  const server = new WebSocketServer({
    noServer: true,
    maxPayload: maxPayloadBytes,
    // Browsers cannot set request headers on a WebSocket handshake, so the
    // access token is smuggled through `Sec-WebSocket-Protocol`. Only the
    // marker subprotocol is ever echoed back — never the token itself.
    handleProtocols: (protocols: Set<string>) =>
      protocols.has(BEARER_SUBPROTOCOL) ? BEARER_SUBPROTOCOL : false,
  });

  return server as unknown as RealtimeWebSocketServer;
};
