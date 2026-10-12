import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

import type { AuthContext } from '../common/types/auth-context.js';
import type { RealtimeTopic } from './topics.js';

/**
 * Numeric `readyState` values from the WebSocket protocol. Declared locally so
 * the gateway core stays independent of the transport library.
 */
export const SOCKET_STATE = {
  connecting: 0,
  open: 1,
  closing: 2,
  closed: 3,
} as const;

/** Close code sent to every client during a graceful shutdown. */
export const CLOSE_CODE_GOING_AWAY = 1001;

/**
 * Close code for a socket whose credentials stopped being valid: the access
 * token it was opened with expired, or the session behind it ended — a logout,
 * a revocation, a disabled account. It sits in the application range so a
 * client can tell it from a transport failure. Reconnecting with a renewed
 * token is the right answer to either case: a session that is really over is
 * then refused at the handshake.
 */
export const CLOSE_CODE_SESSION_ENDED = 4001;

/** Close reason sent with `CLOSE_CODE_SESSION_ENDED` when the token ran out. */
export const CLOSE_REASON_TOKEN_EXPIRED = 'Access token expired';

/** Close reason sent with `CLOSE_CODE_SESSION_ENDED` when the session ended. */
export const CLOSE_REASON_SESSION_ENDED = 'Session ended';

/** Payload shapes a transport may hand to a `message` listener. */
export type RawSocketData = string | Buffer | ArrayBuffer | readonly Buffer[];

export interface RealtimeSocketEvents {
  message: (data: RawSocketData, isBinary?: boolean) => void;
  pong: () => void;
  close: () => void;
  error: (error: Error) => void;
}

/**
 * Minimal structural view of a client socket. Everything the gateway needs is
 * listed here, which keeps the core logic testable with plain fakes and free of
 * any transport import.
 */
export interface RealtimeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on<E extends keyof RealtimeSocketEvents>(event: E, listener: RealtimeSocketEvents[E]): void;
}

/** Minimal structural view of the underlying `noServer` WebSocket server. */
export interface RealtimeWebSocketServer {
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (socket: RealtimeSocket) => void,
  ): void;
  close(callback?: (error?: Error) => void): void;
}

export type CreateWebSocketServer = () => RealtimeWebSocketServer;

/**
 * The identity a connection was opened with. `expiresAt` is when the access
 * token presented at the handshake stops being valid; the socket is closed at
 * that moment. An identity without it is held until the socket closes.
 */
export interface RealtimeIdentity extends AuthContext {
  readonly expiresAt?: Date;
}

/** What a verified access token yields: the identity, and when it runs out. */
export interface VerifiedAccessToken extends AuthContext {
  readonly expiresAt: Date;
}

/** Verifies a JWT access token and resolves the identity it represents. */
export type VerifyAccessToken = (
  accessToken: string,
) => Promise<VerifiedAccessToken> | VerifiedAccessToken;

/** Authorisation hook: may this identity subscribe to this topic? */
export type CanSubscribe = (auth: AuthContext, topic: RealtimeTopic) => Promise<boolean> | boolean;

export const REALTIME_ERROR_CODES = {
  invalidMessage: 'INVALID_MESSAGE',
  messageTooLarge: 'MESSAGE_TOO_LARGE',
  unknownTopic: 'UNKNOWN_TOPIC',
  topicForbidden: 'TOPIC_FORBIDDEN',
  subscriptionLimit: 'SUBSCRIPTION_LIMIT_REACHED',
  notSubscribed: 'NOT_SUBSCRIBED',
  internal: 'INTERNAL_ERROR',
} as const;

export type RealtimeErrorCode = (typeof REALTIME_ERROR_CODES)[keyof typeof REALTIME_ERROR_CODES];

export type OutboundFrame =
  | { readonly type: 'connected'; readonly connectionId: string; readonly userId: string }
  | { readonly type: 'subscribed'; readonly topic: string }
  | { readonly type: 'unsubscribed'; readonly topic: string }
  | { readonly type: 'event'; readonly topic: string; readonly payload: unknown }
  | { readonly type: 'pong' }
  | {
      readonly type: 'error';
      readonly code: RealtimeErrorCode;
      readonly message: string;
    };

export interface RealtimeGatewayOptions {
  /** Ping period; dead sockets are terminated on the following tick. */
  readonly heartbeatIntervalMs: number;
  /** Hard cap on a single inbound frame. Larger frames are rejected. */
  readonly maxInboundMessageBytes: number;
  /** Hard cap on concurrent subscriptions held by one connection. */
  readonly maxSubscriptionsPerConnection: number;
}

export interface RealtimeGatewayStats {
  readonly connections: number;
  readonly topics: number;
  readonly subscriptions: number;
}

export interface RealtimeGateway {
  /** Registers the HTTP upgrade handler for `config.wsPath`. */
  attach(server: HttpServer): void;
  /** Fans an event out to every authorised subscriber of `topic`. */
  publish(topic: string, event: unknown): void;
  /** Stops accepting upgrades and closes every socket with code 1001. */
  close(): Promise<void>;
  /**
   * Closes, with `CLOSE_CODE_SESSION_ENDED`, every socket opened through one
   * of these sessions. Called once the change that ended them has committed.
   */
  sessionsRevoked(sessionIds: readonly string[]): void;
  /** The same, for every socket the user holds: all their sessions ended. */
  userSessionsRevoked(userId: string): void;
  /**
   * Registers an already authenticated socket. Used by `attach` and exposed so
   * the connection lifecycle can be driven directly in tests.
   */
  handleConnection(socket: RealtimeSocket, auth: RealtimeIdentity): void;
  /** Current registry sizes; useful for health output and assertions. */
  getStats(): RealtimeGatewayStats;
}
