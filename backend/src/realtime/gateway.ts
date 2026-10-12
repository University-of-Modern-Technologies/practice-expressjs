import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Logger } from 'pino';

import type { AppConfig } from '../config/env.js';
import type { AuthContext } from '../common/types/auth-context.js';
import { sanitizeEventPayload } from '../events/sanitize.js';
import { extractAccessToken } from './auth.js';
import { parseRealtimeTopic, type RealtimeTopic } from './topics.js';
import {
  CLOSE_CODE_GOING_AWAY,
  CLOSE_CODE_SESSION_ENDED,
  CLOSE_REASON_SESSION_ENDED,
  CLOSE_REASON_TOKEN_EXPIRED,
  REALTIME_ERROR_CODES,
  SOCKET_STATE,
  type CanSubscribe,
  type CreateWebSocketServer,
  type OutboundFrame,
  type RawSocketData,
  type RealtimeErrorCode,
  type RealtimeGateway,
  type RealtimeGatewayOptions,
  type RealtimeGatewayStats,
  type RealtimeIdentity,
  type RealtimeSocket,
  type RealtimeWebSocketServer,
  type VerifyAccessToken,
} from './types.js';
import { readInboundFrame, type InboundParseResult } from './validation.js';
import { createWebSocketServer as createDefaultWebSocketServer } from './ws-server.js';

export type RealtimeGatewayConfig = Pick<AppConfig, 'wsPath'>;

export interface RealtimeGatewayDependencies {
  readonly config: RealtimeGatewayConfig;
  readonly logger: Logger;
  /** Verifies the JWT access token presented during the upgrade. */
  readonly verifyAccessToken: VerifyAccessToken;
  /**
   * Per-topic authorisation. Injected rather than imported so the composition
   * root can wire the RBAC service without the gateway depending on it.
   * Omitting it denies every subscription (secure default).
   */
  readonly canSubscribe?: CanSubscribe;
  readonly options?: Partial<RealtimeGatewayOptions>;
  /** Transport seam; overridden in tests. */
  readonly createWebSocketServer?: CreateWebSocketServer;
}

const DEFAULT_OPTIONS: RealtimeGatewayOptions = {
  heartbeatIntervalMs: 30_000,
  maxInboundMessageBytes: 8 * 1024,
  maxSubscriptionsPerConnection: 20,
};

/** The longest delay a Node timer accepts; a later expiry is reached in steps. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface Connection {
  readonly id: string;
  readonly socket: RealtimeSocket;
  readonly auth: RealtimeIdentity;
  readonly topics: Set<RealtimeTopic>;
  isAlive: boolean;
  /**
   * Frames not answered yet. They are handled one at a time, in the order they
   * arrived: a subscribe awaits its authorisation check, and the frames behind
   * it wait for that check instead of overtaking it.
   */
  readonly inbound: InboundParseResult[];
  /** Whether a drain of `inbound` is under way. */
  draining: boolean;
  /** Closes the socket when the access token it was opened with expires. */
  expiry: NodeJS.Timeout | null;
}

const UNAUTHORIZED_RESPONSE = [
  'HTTP/1.1 401 Unauthorized',
  'Connection: close',
  'Content-Length: 0',
  '',
  '',
].join('\r\n');

const UNAVAILABLE_RESPONSE = [
  'HTTP/1.1 503 Service Unavailable',
  'Connection: close',
  'Content-Length: 0',
  '',
  '',
].join('\r\n');

const requestPathname = (request: IncomingMessage): string => {
  const target = request.url ?? '/';
  const separator = target.indexOf('?');
  return separator === -1 ? target : target.slice(0, separator);
};

export const createRealtimeGateway = (deps: RealtimeGatewayDependencies): RealtimeGateway => {
  const { config, verifyAccessToken } = deps;
  const logger = deps.logger.child({ component: 'realtime-gateway' });
  const options: RealtimeGatewayOptions = { ...DEFAULT_OPTIONS, ...deps.options };
  // The transport keeps its own, much higher ceiling: the inbound limit is
  // enforced here, per frame, so an oversized frame is answered with an error
  // frame instead of the transport closing the socket (see ws-server.ts).
  const createServer = deps.createWebSocketServer ?? (() => createDefaultWebSocketServer());

  if (!deps.canSubscribe) {
    logger.warn('No canSubscribe callback injected; every subscription will be denied');
  }
  const canSubscribe: CanSubscribe = deps.canSubscribe ?? ((): boolean => false);

  const connections = new Map<string, Connection>();
  const topicIndex = new Map<RealtimeTopic, Set<Connection>>();

  let wsServer: RealtimeWebSocketServer | null = null;
  let attachedServer: HttpServer | null = null;
  let upgradeListener: ((request: IncomingMessage, socket: Duplex, head: Buffer) => void) | null =
    null;
  let heartbeat: NodeJS.Timeout | null = null;
  let isClosing = false;

  const send = (connection: Connection, frame: OutboundFrame): void => {
    if (connection.socket.readyState !== SOCKET_STATE.open) return;
    try {
      connection.socket.send(JSON.stringify(frame));
    } catch (error) {
      logger.warn({ err: error, connectionId: connection.id }, 'Failed to write realtime frame');
    }
  };

  const sendError = (connection: Connection, code: RealtimeErrorCode, message: string): void => {
    send(connection, { type: 'error', code, message });
  };

  const unsubscribeAll = (connection: Connection): void => {
    for (const topic of connection.topics) {
      const subscribers = topicIndex.get(topic);
      if (!subscribers) continue;
      subscribers.delete(connection);
      if (subscribers.size === 0) topicIndex.delete(topic);
    }
    connection.topics.clear();
  };

  const clearExpiry = (connection: Connection): void => {
    if (connection.expiry === null) return;
    clearTimeout(connection.expiry);
    connection.expiry = null;
  };

  const forget = (connection: Connection): void => {
    if (!connections.delete(connection.id)) return;
    clearExpiry(connection);
    unsubscribeAll(connection);
    stopHeartbeatWhenIdle();
  };

  /**
   * Closes a socket whose credentials are no longer valid. The connection is
   * dropped from the registry first, so not one more event reaches it while
   * the close handshake is under way.
   */
  const endSession = (connection: Connection, reason: string): void => {
    if (!connections.has(connection.id)) return;
    forget(connection);
    logger.debug({ connectionId: connection.id, reason }, 'Closing realtime socket');
    try {
      connection.socket.close(CLOSE_CODE_SESSION_ENDED, reason);
    } catch (error) {
      logger.warn({ err: error, connectionId: connection.id }, 'Socket close failed');
    }
  };

  const armExpiry = (connection: Connection): void => {
    const { expiresAt } = connection.auth;
    if (expiresAt === undefined) return;

    // An unreadable expiry yields NaN, which fires at once and then fails the
    // check below: a token whose lifetime cannot be read is treated as spent.
    const remaining = expiresAt.getTime() - Date.now();
    connection.expiry = setTimeout(
      () => {
        connection.expiry = null;
        if (Date.now() < expiresAt.getTime()) {
          armExpiry(connection);
          return;
        }
        endSession(connection, CLOSE_REASON_TOKEN_EXPIRED);
      },
      Math.min(Math.max(remaining, 0), MAX_TIMER_DELAY_MS),
    );
    connection.expiry.unref?.();
  };

  const endSessionsWhere = (matches: (auth: AuthContext) => boolean): void => {
    for (const connection of [...connections.values()]) {
      if (matches(connection.auth)) endSession(connection, CLOSE_REASON_SESSION_ENDED);
    }
  };

  const runHeartbeat = (): void => {
    for (const connection of [...connections.values()]) {
      if (!connection.isAlive) {
        logger.debug({ connectionId: connection.id }, 'Terminating unresponsive realtime socket');
        forget(connection);
        try {
          connection.socket.terminate();
        } catch (error) {
          logger.warn({ err: error, connectionId: connection.id }, 'Socket termination failed');
        }
        continue;
      }

      connection.isAlive = false;
      try {
        connection.socket.ping();
      } catch (error) {
        logger.warn({ err: error, connectionId: connection.id }, 'Heartbeat ping failed');
      }
    }
  };

  // The interval is created on the first connection and cleared once the last
  // one is gone, and it is unref'd, so an idle gateway never keeps the Node
  // event loop (and therefore the process) alive.
  function startHeartbeat(): void {
    if (heartbeat !== null || isClosing) return;
    heartbeat = setInterval(runHeartbeat, options.heartbeatIntervalMs);
    heartbeat.unref?.();
  }

  function stopHeartbeat(): void {
    if (heartbeat === null) return;
    clearInterval(heartbeat);
    heartbeat = null;
  }

  function stopHeartbeatWhenIdle(): void {
    if (connections.size === 0) stopHeartbeat();
  }

  /**
   * Answers a subscribe that needs no authorisation check: one already held,
   * or one over the limit. Returns whether it answered.
   */
  const settledWithoutCheck = (connection: Connection, topic: RealtimeTopic): boolean => {
    if (connection.topics.has(topic)) {
      send(connection, { type: 'subscribed', topic });
      return true;
    }

    if (connection.topics.size >= options.maxSubscriptionsPerConnection) {
      sendError(
        connection,
        REALTIME_ERROR_CODES.subscriptionLimit,
        `A connection may hold at most ${String(options.maxSubscriptionsPerConnection)} subscriptions`,
      );
      return true;
    }

    return false;
  };

  const handleSubscribe = async (connection: Connection, topic: RealtimeTopic): Promise<void> => {
    if (settledWithoutCheck(connection, topic)) return;

    let allowed = false;
    try {
      allowed = await canSubscribe(connection.auth, topic);
    } catch (error) {
      logger.error(
        { err: error, connectionId: connection.id, topic },
        'Authorisation check failed',
      );
      sendError(connection, REALTIME_ERROR_CODES.internal, 'Subscription could not be processed');
      return;
    }

    if (!allowed) {
      logger.debug({ connectionId: connection.id, topic }, 'Subscription denied');
      sendError(connection, REALTIME_ERROR_CODES.topicForbidden, 'Topic is not accessible');
      return;
    }

    // The connection may have been dropped while the async check was running,
    // and the registry is read again rather than trusted from before the await.
    if (!connections.has(connection.id)) return;
    if (settledWithoutCheck(connection, topic)) return;

    connection.topics.add(topic);
    const subscribers = topicIndex.get(topic) ?? new Set<Connection>();
    subscribers.add(connection);
    topicIndex.set(topic, subscribers);

    send(connection, { type: 'subscribed', topic });
  };

  const handleUnsubscribe = (connection: Connection, topic: RealtimeTopic): void => {
    if (!connection.topics.delete(topic)) {
      sendError(connection, REALTIME_ERROR_CODES.notSubscribed, 'Not subscribed to this topic');
      return;
    }

    const subscribers = topicIndex.get(topic);
    if (subscribers) {
      subscribers.delete(connection);
      if (subscribers.size === 0) topicIndex.delete(topic);
    }

    send(connection, { type: 'unsubscribed', topic });
  };

  /**
   * Answers one frame. Only a subscribe has to wait (for its authorisation
   * check); everything else is answered before this returns.
   */
  const handleFrame = (
    connection: Connection,
    parsed: InboundParseResult,
  ): Promise<void> | undefined => {
    if (!parsed.ok) {
      sendError(connection, parsed.code, parsed.reason);
      return undefined;
    }

    const message = parsed.message;

    if (message.type === 'ping') {
      send(connection, { type: 'pong' });
      return undefined;
    }

    if (message.type === 'unsubscribe') {
      handleUnsubscribe(connection, message.topic);
      return undefined;
    }

    return handleSubscribe(connection, message.topic);
  };

  /**
   * Works through the queue one frame at a time. A frame that needs no await
   * is answered on the spot, so an idle connection answers synchronously; a
   * subscribe holds back the frames behind it until its check has settled.
   */
  const drainInbound = async (connection: Connection): Promise<void> => {
    connection.draining = true;
    try {
      let next = connection.inbound.shift();
      while (next !== undefined) {
        // A frame queued behind one that ended the connection has nobody to answer.
        if (!connections.has(connection.id)) {
          connection.inbound.length = 0;
          return;
        }
        try {
          const pending = handleFrame(connection, next);
          if (pending) await pending;
        } catch (error) {
          // Handling must never reject: an unhandled rejection here would take
          // down the process on a malformed client message, and a failed frame
          // must not stall the ones behind it.
          logger.error(
            { err: error, connectionId: connection.id },
            'Inbound frame handling failed',
          );
          sendError(
            connection,
            REALTIME_ERROR_CODES.internal,
            'Subscription could not be processed',
          );
        }
        next = connection.inbound.shift();
      }
    } finally {
      connection.draining = false;
    }
  };

  const enqueueFrame = (connection: Connection, data: RawSocketData): void => {
    // Parsed on arrival, so the queue holds small validated messages rather
    // than raw frames of any size.
    connection.inbound.push(readInboundFrame(data, options.maxInboundMessageBytes));
    if (!connection.draining) void drainInbound(connection);
  };

  const handleConnection = (socket: RealtimeSocket, auth: RealtimeIdentity): void => {
    const connection: Connection = {
      id: randomUUID(),
      socket,
      auth,
      topics: new Set<RealtimeTopic>(),
      isAlive: true,
      inbound: [],
      draining: false,
      expiry: null,
    };

    connections.set(connection.id, connection);
    startHeartbeat();
    armExpiry(connection);

    socket.on('message', (data) => {
      enqueueFrame(connection, data);
    });
    socket.on('pong', () => {
      connection.isAlive = true;
    });
    socket.on('close', () => {
      forget(connection);
    });
    socket.on('error', (error) => {
      logger.warn({ err: error, connectionId: connection.id }, 'Realtime socket error');
      forget(connection);
    });

    logger.debug({ connectionId: connection.id, userId: auth.userId }, 'Realtime client connected');
    send(connection, { type: 'connected', connectionId: connection.id, userId: auth.userId });
  };

  const rejectUpgrade = (socket: Duplex, response: string): void => {
    socket.write(response);
    socket.destroy();
  };

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // Other subsystems may own their own upgrade paths; ignore anything that is
    // not addressed to this gateway instead of destroying the socket.
    if (requestPathname(request) !== config.wsPath) return;

    if (isClosing || wsServer === null) {
      rejectUpgrade(socket, UNAVAILABLE_RESPONSE);
      return;
    }

    const token = extractAccessToken(request.headers);
    if (token === null) {
      logger.debug('Rejected unauthenticated realtime upgrade');
      rejectUpgrade(socket, UNAUTHORIZED_RESPONSE);
      return;
    }

    const server = wsServer;

    void (async (): Promise<void> => {
      let auth: RealtimeIdentity;
      try {
        auth = await verifyAccessToken(token);
      } catch (error) {
        logger.debug({ err: error }, 'Rejected realtime upgrade with an invalid access token');
        rejectUpgrade(socket, UNAUTHORIZED_RESPONSE);
        return;
      }

      if (isClosing) {
        rejectUpgrade(socket, UNAVAILABLE_RESPONSE);
        return;
      }

      server.handleUpgrade(request, socket, head, (client) => {
        handleConnection(client, auth);
      });
    })();
  };

  const closeWebSocketServer = async (): Promise<void> => {
    const server = wsServer;
    wsServer = null;
    if (server === null) return;

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  };

  return {
    attach(server: HttpServer): void {
      if (attachedServer !== null) {
        throw new Error('Realtime gateway is already attached to an HTTP server');
      }

      // A `noServer` WebSocketServer with an explicit `upgrade` handler is used
      // rather than an Express-level WebSocket adapter: such adapters patch the
      // router and only run handlers after the handshake has been accepted,
      // which makes a clean pre-handshake HTTP 401 impossible. Owning the
      // upgrade event keeps authentication ahead of the socket and leaves the
      // HTTP application untouched.
      wsServer = createServer();
      attachedServer = server;
      upgradeListener = onUpgrade;
      server.on('upgrade', upgradeListener);
      isClosing = false;

      logger.info({ path: config.wsPath }, 'Realtime gateway attached');
    },

    publish(topic: string, event: unknown): void {
      const parsed = parseRealtimeTopic(topic);
      if (!parsed) {
        logger.warn({ topic }, 'Refused to publish to an unknown realtime topic');
        return;
      }

      const subscribers = topicIndex.get(parsed.topic);
      if (!subscribers || subscribers.size === 0) return;

      // The same redaction the event log applies on the way in: a secret that
      // slipped into a domain payload must not reach a browser either. It also
      // reduces the payload to plain JSON, so every subscriber gets one shape.
      const frame: OutboundFrame = {
        type: 'event',
        topic: parsed.topic,
        payload: sanitizeEventPayload(event),
      };
      for (const connection of subscribers) {
        send(connection, frame);
      }
    },

    sessionsRevoked(sessionIds: readonly string[]): void {
      // Identifiers are compared without regard to case, as the database does.
      const ended = new Set(sessionIds.map((sessionId) => sessionId.toLowerCase()));
      if (ended.size === 0) return;
      endSessionsWhere((auth) => ended.has(auth.sessionId.toLowerCase()));
    },

    userSessionsRevoked(userId: string): void {
      const ended = userId.toLowerCase();
      endSessionsWhere((auth) => auth.userId.toLowerCase() === ended);
    },

    handleConnection,

    getStats(): RealtimeGatewayStats {
      let subscriptions = 0;
      for (const connection of connections.values()) subscriptions += connection.topics.size;
      return { connections: connections.size, topics: topicIndex.size, subscriptions };
    },

    async close(): Promise<void> {
      isClosing = true;
      stopHeartbeat();

      if (attachedServer !== null && upgradeListener !== null) {
        attachedServer.removeListener('upgrade', upgradeListener);
      }
      attachedServer = null;
      upgradeListener = null;

      for (const connection of [...connections.values()]) {
        clearExpiry(connection);
        unsubscribeAll(connection);
        try {
          connection.socket.close(CLOSE_CODE_GOING_AWAY, 'Server shutting down');
        } catch (error) {
          logger.warn({ err: error, connectionId: connection.id }, 'Socket close failed');
        }
      }

      connections.clear();
      topicIndex.clear();

      await closeWebSocketServer();
      logger.info('Realtime gateway closed');
    },
  };
};
