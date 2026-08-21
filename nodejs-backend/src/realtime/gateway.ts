import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Logger } from 'pino';

import type { AppConfig } from '../config/env.js';
import type { AuthContext } from '../common/types/auth-context.js';
import { extractAccessToken } from './auth.js';
import { parseRealtimeTopic, type RealtimeTopic } from './topics.js';
import {
  CLOSE_CODE_GOING_AWAY,
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
  type RealtimeSocket,
  type RealtimeWebSocketServer,
  type VerifyAccessToken,
} from './types.js';
import { readInboundFrame } from './validation.js';
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

interface Connection {
  readonly id: string;
  readonly socket: RealtimeSocket;
  readonly auth: AuthContext;
  readonly topics: Set<RealtimeTopic>;
  isAlive: boolean;
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
  const createServer =
    deps.createWebSocketServer ??
    (() => createDefaultWebSocketServer(options.maxInboundMessageBytes));

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

  const forget = (connection: Connection): void => {
    if (!connections.delete(connection.id)) return;
    unsubscribeAll(connection);
    stopHeartbeatWhenIdle();
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

  const handleSubscribe = async (connection: Connection, topic: RealtimeTopic): Promise<void> => {
    if (connection.topics.has(topic)) {
      send(connection, { type: 'subscribed', topic });
      return;
    }

    if (connection.topics.size >= options.maxSubscriptionsPerConnection) {
      sendError(
        connection,
        REALTIME_ERROR_CODES.subscriptionLimit,
        `A connection may hold at most ${String(options.maxSubscriptionsPerConnection)} subscriptions`,
      );
      return;
    }

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

    // The connection may have been dropped while the async check was running.
    if (!connections.has(connection.id)) return;

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

  const handleMessage = (connection: Connection, data: RawSocketData): void => {
    const parsed = readInboundFrame(data, options.maxInboundMessageBytes);

    if (!parsed.ok) {
      sendError(connection, parsed.code, parsed.reason);
      return;
    }

    const message = parsed.message;

    if (message.type === 'ping') {
      send(connection, { type: 'pong' });
      return;
    }

    if (message.type === 'unsubscribe') {
      handleUnsubscribe(connection, message.topic);
      return;
    }

    // Inbound handling must never reject: an unhandled rejection here would
    // take down the process on a malformed client message.
    void handleSubscribe(connection, message.topic).catch((error: unknown) => {
      logger.error({ err: error, connectionId: connection.id }, 'Subscribe handling failed');
      sendError(connection, REALTIME_ERROR_CODES.internal, 'Subscription could not be processed');
    });
  };

  const handleConnection = (socket: RealtimeSocket, auth: AuthContext): void => {
    const connection: Connection = {
      id: randomUUID(),
      socket,
      auth,
      topics: new Set<RealtimeTopic>(),
      isAlive: true,
    };

    connections.set(connection.id, connection);
    startHeartbeat();

    socket.on('message', (data) => {
      handleMessage(connection, data);
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
      let auth: AuthContext;
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

      const frame: OutboundFrame = { type: 'event', topic: parsed.topic, payload: event };
      for (const connection of subscribers) {
        send(connection, frame);
      }
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
