import { describe, expect, it } from '@jest/globals';
import type { WebSocketServer } from 'ws';

import { BEARER_SUBPROTOCOL } from './auth.js';
import { TRANSPORT_MAX_PAYLOAD_BYTES, createWebSocketServer } from './ws-server.js';

type ServerOptions = WebSocketServer['options'] & {
  handleProtocols: (protocols: Set<string>) => string | false;
};

const optionsOf = (server: unknown): ServerOptions =>
  (server as { options: ServerOptions }).options;

describe('websocket transport', () => {
  it('lets a frame above the gateway limit through, so the gateway can answer it', () => {
    // With the transport ceiling equal to the gateway's 8 KiB limit, the
    // transport closed the socket with 1009 before the gateway could send
    // MESSAGE_TOO_LARGE — a different answer from the sibling deployment.
    const server = createWebSocketServer();

    expect(optionsOf(server).maxPayload).toBe(TRANSPORT_MAX_PAYLOAD_BYTES);
    expect(TRANSPORT_MAX_PAYLOAD_BYTES).toBe(16 * 1024 * 1024);
  });

  it('echoes only the marker subprotocol, never a token', () => {
    const { handleProtocols } = optionsOf(createWebSocketServer());

    expect(handleProtocols(new Set([BEARER_SUBPROTOCOL, 'jwt-value']))).toBe(BEARER_SUBPROTOCOL);
    expect(handleProtocols(new Set(['access_token.jwt-value']))).toBe(false);
  });
});
