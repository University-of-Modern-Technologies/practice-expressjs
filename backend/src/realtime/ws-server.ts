import { WebSocketServer } from 'ws';

import { BEARER_SUBPROTOCOL } from './auth.js';
import type { RealtimeWebSocketServer } from './types.js';

/**
 * Transport-level ceiling on one inbound message: 16 MiB, the default of the
 * ASGI server the sibling deployment runs on, so a frame is treated the same
 * way by both.
 *
 * It deliberately sits far above the gateway's own inbound limit. A frame
 * between the two reaches the gateway, which answers `MESSAGE_TOO_LARGE` and
 * keeps the socket open — the same treatment as any other malformed frame: a
 * buggy client is told what is wrong, not dropped. Were the two limits equal,
 * the transport would close the socket with 1009 before the gateway could say
 * anything. Only a frame above this ceiling closes the connection with 1009.
 */
export const TRANSPORT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

/**
 * The single module that touches the transport library. Everything else in
 * `src/realtime` works against the structural `RealtimeSocket` /
 * `RealtimeWebSocketServer` interfaces, which keeps the gateway logic unit
 * testable without opening real sockets.
 */
export const createWebSocketServer = (
  maxPayloadBytes: number = TRANSPORT_MAX_PAYLOAD_BYTES,
): RealtimeWebSocketServer => {
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
