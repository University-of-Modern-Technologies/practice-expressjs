// The transport module is the only file that imports `ws`. It is mocked here so
// the gateway logic can be exercised without touching the network stack.
jest.mock('./ws-server.js', () => ({
  createWebSocketServer: jest.fn(),
}));

import { EventEmitter } from 'node:events';
import type { Server as HttpServer } from 'node:http';
import type { Logger } from 'pino';

import type { AuthContext } from '../common/types/auth-context.js';
import { createRealtimeGateway, type RealtimeGatewayDependencies } from './gateway.js';
import {
  REALTIME_ERROR_CODES,
  SOCKET_STATE,
  type RawSocketData,
  type RealtimeSocket,
  type RealtimeSocketEvents,
  type RealtimeWebSocketServer,
} from './types.js';

class FakeSocket implements RealtimeSocket {
  public readyState: number = SOCKET_STATE.open;
  public readonly sent: string[] = [];
  public readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  public terminateCalls = 0;
  public pingCalls = 0;

  private readonly listeners = new Map<string, unknown[]>();

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(code?: number, reason?: string): void {
    this.readyState = SOCKET_STATE.closing;
    this.closeCalls.push({
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    });
  }

  public terminate(): void {
    this.readyState = SOCKET_STATE.closed;
    this.terminateCalls += 1;
  }

  public ping(): void {
    this.pingCalls += 1;
  }

  public on<E extends keyof RealtimeSocketEvents>(
    event: E,
    listener: RealtimeSocketEvents[E],
  ): void {
    const bucket = this.listeners.get(event) ?? [];
    bucket.push(listener);
    this.listeners.set(event, bucket);
  }

  public emitMessage(data: RawSocketData): void {
    for (const listener of this.listeners.get('message') ?? []) {
      (listener as RealtimeSocketEvents['message'])(data);
    }
  }

  public emitPong(): void {
    for (const listener of this.listeners.get('pong') ?? []) {
      (listener as RealtimeSocketEvents['pong'])();
    }
  }

  public emitClose(): void {
    for (const listener of this.listeners.get('close') ?? []) {
      (listener as RealtimeSocketEvents['close'])();
    }
  }

  public emitError(error: Error): void {
    for (const listener of this.listeners.get('error') ?? []) {
      (listener as RealtimeSocketEvents['error'])(error);
    }
  }

  /** All frames written to this socket, parsed back into objects. */
  public frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  public lastFrame(): Record<string, unknown> | undefined {
    return this.frames().at(-1);
  }
}

const createFakeLogger = (): Logger => {
  const logger: Record<string, unknown> = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  logger.child = jest.fn((): Record<string, unknown> => logger);
  return logger as unknown as Logger;
};

const auth: AuthContext = { userId: 'user-1', sessionId: 'session-1' };

const send = (socket: FakeSocket, message: unknown): void => {
  socket.emitMessage(JSON.stringify(message));
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

interface Harness {
  readonly gateway: ReturnType<typeof createRealtimeGateway>;
  readonly logger: Logger;
  readonly wsServer: RealtimeWebSocketServer & {
    readonly closeMock: jest.Mock;
    readonly handleUpgradeMock: jest.Mock;
    nextSocket: FakeSocket | null;
  };
}

const createHarness = (overrides: Partial<RealtimeGatewayDependencies> = {}): Harness => {
  const logger = createFakeLogger();

  const closeMock = jest.fn((callback?: (error?: Error) => void) => {
    callback?.();
  });
  const wsServer = {
    closeMock,
    handleUpgradeMock: jest.fn(),
    nextSocket: null as FakeSocket | null,
    handleUpgrade(
      _request: unknown,
      _socket: unknown,
      _head: unknown,
      callback: (client: RealtimeSocket) => void,
    ): void {
      this.handleUpgradeMock();
      const client = this.nextSocket ?? new FakeSocket();
      this.nextSocket = client;
      callback(client);
    },
    close(callback?: (error?: Error) => void): void {
      closeMock(callback);
    },
  };

  // Cast because spreading a Partial<> under exactOptionalPropertyTypes widens
  // every optional dependency to `| undefined`.
  const deps = {
    config: { wsPath: '/api/v1/realtime' },
    logger,
    verifyAccessToken: () => auth,
    canSubscribe: () => true,
    createWebSocketServer: () => wsServer as unknown as RealtimeWebSocketServer,
    ...overrides,
  } as RealtimeGatewayDependencies;

  const gateway = createRealtimeGateway(deps);

  return { gateway, logger, wsServer: wsServer as unknown as Harness['wsServer'] };
};

describe('realtime gateway — inbound message handling', () => {
  it('greets an accepted connection', () => {
    const { gateway } = createHarness();
    const socket = new FakeSocket();

    gateway.handleConnection(socket, auth);

    expect(socket.lastFrame()).toEqual({
      type: 'connected',
      connectionId: expect.any(String) as unknown,
      userId: 'user-1',
    });
    expect(gateway.getStats().connections).toBe(1);
  });

  it('answers malformed frames with an error frame and does not throw', () => {
    const { gateway } = createHarness();
    const socket = new FakeSocket();
    gateway.handleConnection(socket, auth);

    expect(() => {
      socket.emitMessage('not json');
    }).not.toThrow();

    expect(socket.lastFrame()).toMatchObject({
      type: 'error',
      code: REALTIME_ERROR_CODES.invalidMessage,
    });
    expect(gateway.getStats().subscriptions).toBe(0);
  });

  it('rejects unknown topics', async () => {
    const { gateway } = createHarness();
    const socket = new FakeSocket();
    gateway.handleConnection(socket, auth);

    send(socket, { type: 'subscribe', topic: 'admin-secrets' });
    await flush();

    expect(socket.lastFrame()).toMatchObject({
      type: 'error',
      code: REALTIME_ERROR_CODES.unknownTopic,
    });
  });

  it('enforces the inbound message size limit', () => {
    const { gateway } = createHarness({ options: { maxInboundMessageBytes: 32 } });
    const socket = new FakeSocket();
    gateway.handleConnection(socket, auth);

    socket.emitMessage(
      JSON.stringify({ type: 'subscribe', topic: `entity:deal:${'a'.repeat(60)}` }),
    );

    expect(socket.lastFrame()).toMatchObject({
      type: 'error',
      code: REALTIME_ERROR_CODES.messageTooLarge,
    });
  });

  it('replies to application-level pings', () => {
    const { gateway } = createHarness();
    const socket = new FakeSocket();
    gateway.handleConnection(socket, auth);

    send(socket, { type: 'ping' });

    expect(socket.lastFrame()).toEqual({ type: 'pong' });
  });
});

describe('realtime gateway — subscription bookkeeping', () => {
  it('tracks subscribe and unsubscribe', async () => {
    const { gateway } = createHarness();
    const socket = new FakeSocket();
    gateway.handleConnection(socket, auth);

    send(socket, { type: 'subscribe', topic: 'deals' });
    await flush();

    expect(socket.lastFrame()).toEqual({ type: 'subscribed', topic: 'deals' });
    expect(gateway.getStats()).toEqual({ connections: 1, topics: 1, subscriptions: 1 });

    send(socket, { type: 'unsubscribe', topic: 'deals' });
    await flush();

    expect(socket.lastFrame()).toEqual({ type: 'unsubscribed', topic: 'deals' });
    expect(gateway.getStats()).toEqual({ connections: 1, topics: 0, subscriptions: 0 });
  });

  it('is idempotent for repeated subscribes', async () => {
    const { gateway } = createHarness();
    const socket = new FakeSocket();
    gateway.handleConnection(socket, auth);

    send(socket, { type: 'subscribe', topic: 'deals' });
    await flush();
    send(socket, { type: 'subscribe', topic: 'deals' });
    await flush();

    expect(gateway.getStats().subscriptions).toBe(1);
  });

  it('reports unsubscribing from a topic that was never joined', async () => {
    const { gateway } = createHarness();
    const socket = new FakeSocket();
    gateway.handleConnection(socket, auth);

    send(socket, { type: 'unsubscribe', topic: 'orders' });
    await flush();

    expect(socket.lastFrame()).toMatchObject({
      type: 'error',
      code: REALTIME_ERROR_CODES.notSubscribed,
    });
  });

  it('caps the number of subscriptions per connection', async () => {
    const { gateway } = createHarness({ options: { maxSubscriptionsPerConnection: 2 } });
    const socket = new FakeSocket();
    gateway.handleConnection(socket, auth);

    send(socket, { type: 'subscribe', topic: 'deals' });
    await flush();
    send(socket, { type: 'subscribe', topic: 'orders' });
    await flush();
    send(socket, { type: 'subscribe', topic: 'entity:deal:d1' });
    await flush();

    expect(socket.lastFrame()).toMatchObject({
      type: 'error',
      code: REALTIME_ERROR_CODES.subscriptionLimit,
    });
    expect(gateway.getStats().subscriptions).toBe(2);
  });

  it('drops all bookkeeping when a socket closes', async () => {
    const { gateway } = createHarness();
    const socket = new FakeSocket();
    gateway.handleConnection(socket, auth);

    send(socket, { type: 'subscribe', topic: 'deals' });
    await flush();
    socket.emitClose();

    expect(gateway.getStats()).toEqual({ connections: 0, topics: 0, subscriptions: 0 });
  });

  it('drops bookkeeping when a socket errors', async () => {
    const { gateway } = createHarness();
    const socket = new FakeSocket();
    gateway.handleConnection(socket, auth);

    send(socket, { type: 'subscribe', topic: 'deals' });
    await flush();
    socket.emitError(new Error('boom'));

    expect(gateway.getStats().connections).toBe(0);
  });
});

describe('realtime gateway — authorisation', () => {
  it('denies subscriptions the authorisation callback refuses', async () => {
    const canSubscribe = jest.fn(() => false);
    const { gateway } = createHarness({ canSubscribe });
    const socket = new FakeSocket();
    gateway.handleConnection(socket, auth);

    send(socket, { type: 'subscribe', topic: 'deals' });
    await flush();

    expect(canSubscribe).toHaveBeenCalledWith(auth, 'deals');
    expect(socket.lastFrame()).toMatchObject({
      type: 'error',
      code: REALTIME_ERROR_CODES.topicForbidden,
    });
    expect(gateway.getStats().subscriptions).toBe(0);
  });

  it('denies everything when no authorisation callback is injected', async () => {
    const logger = createFakeLogger();
    const gateway = createRealtimeGateway({
      config: { wsPath: '/api/v1/realtime' },
      logger,
      verifyAccessToken: () => auth,
    });
    const socket = new FakeSocket();
    gateway.handleConnection(socket, auth);

    send(socket, { type: 'subscribe', topic: 'deals' });
    await flush();

    expect(socket.lastFrame()).toMatchObject({
      type: 'error',
      code: REALTIME_ERROR_CODES.topicForbidden,
    });
    await gateway.close();
  });

  it('reports an internal error when the authorisation callback throws', async () => {
    const { gateway } = createHarness({
      canSubscribe: () => {
        throw new Error('rbac unavailable');
      },
    });
    const socket = new FakeSocket();
    gateway.handleConnection(socket, auth);

    send(socket, { type: 'subscribe', topic: 'deals' });
    await flush();

    expect(socket.lastFrame()).toMatchObject({
      type: 'error',
      code: REALTIME_ERROR_CODES.internal,
    });
  });
});

describe('realtime gateway — publish fan-out', () => {
  it('delivers only to subscribers of the topic', async () => {
    const { gateway } = createHarness();
    const dealsSocket = new FakeSocket();
    const ordersSocket = new FakeSocket();
    const idleSocket = new FakeSocket();

    gateway.handleConnection(dealsSocket, auth);
    gateway.handleConnection(ordersSocket, auth);
    gateway.handleConnection(idleSocket, auth);

    send(dealsSocket, { type: 'subscribe', topic: 'deals' });
    send(ordersSocket, { type: 'subscribe', topic: 'orders' });
    await flush();

    gateway.publish('deals', { dealId: 'd1', stage: 'WON' });

    expect(dealsSocket.lastFrame()).toEqual({
      type: 'event',
      topic: 'deals',
      payload: { dealId: 'd1', stage: 'WON' },
    });
    expect(ordersSocket.frames().some((frame) => frame.type === 'event')).toBe(false);
    expect(idleSocket.frames().some((frame) => frame.type === 'event')).toBe(false);
  });

  it('fans out to every subscriber of the same topic', async () => {
    const { gateway } = createHarness();
    const first = new FakeSocket();
    const second = new FakeSocket();
    gateway.handleConnection(first, auth);
    gateway.handleConnection(second, auth);

    send(first, { type: 'subscribe', topic: 'entity:deal:d1' });
    send(second, { type: 'subscribe', topic: 'entity:deal:d1' });
    await flush();

    gateway.publish('entity:deal:d1', { stage: 'LOST' });

    expect(first.lastFrame()).toMatchObject({ type: 'event', topic: 'entity:deal:d1' });
    expect(second.lastFrame()).toMatchObject({ type: 'event', topic: 'entity:deal:d1' });
  });

  it('skips sockets that are no longer open', async () => {
    const { gateway } = createHarness();
    const socket = new FakeSocket();
    gateway.handleConnection(socket, auth);
    send(socket, { type: 'subscribe', topic: 'deals' });
    await flush();

    socket.readyState = SOCKET_STATE.closed;
    const before = socket.sent.length;
    gateway.publish('deals', { any: 'thing' });

    expect(socket.sent).toHaveLength(before);
  });

  it('ignores publishes to unknown or unsubscribed topics', () => {
    const { gateway, logger } = createHarness();
    expect(() => {
      gateway.publish('not-a-topic', {});
    }).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();

    expect(() => {
      gateway.publish('orders', {});
    }).not.toThrow();
  });
});

describe('realtime gateway — heartbeat', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('pings live sockets and terminates unresponsive ones', () => {
    const { gateway } = createHarness({ options: { heartbeatIntervalMs: 1_000 } });
    const healthy = new FakeSocket();
    const dead = new FakeSocket();
    gateway.handleConnection(healthy, auth);
    gateway.handleConnection(dead, auth);

    jest.advanceTimersByTime(1_000);
    expect(healthy.pingCalls).toBe(1);
    expect(dead.pingCalls).toBe(1);

    healthy.emitPong();

    jest.advanceTimersByTime(1_000);
    expect(dead.terminateCalls).toBe(1);
    expect(healthy.terminateCalls).toBe(0);
    expect(gateway.getStats().connections).toBe(1);
  });

  it('does not start a timer before the first connection and stops it after the last', () => {
    const { gateway } = createHarness({ options: { heartbeatIntervalMs: 1_000 } });
    expect(jest.getTimerCount()).toBe(0);

    const socket = new FakeSocket();
    gateway.handleConnection(socket, auth);
    expect(jest.getTimerCount()).toBe(1);

    socket.emitClose();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('realtime gateway — attach and shutdown', () => {
  it('rejects upgrades without a token before the handshake', async () => {
    const { gateway, wsServer } = createHarness();
    const server = new EventEmitter();
    gateway.attach(server as unknown as HttpServer);

    const socket = { write: jest.fn(), destroy: jest.fn() };
    server.emit('upgrade', { url: '/api/v1/realtime', headers: {} }, socket, Buffer.alloc(0));
    await flush();

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('401 Unauthorized'));
    expect(socket.destroy).toHaveBeenCalled();
    expect(wsServer.handleUpgradeMock).not.toHaveBeenCalled();

    await gateway.close();
  });

  it('rejects upgrades whose token fails verification', async () => {
    const { gateway, wsServer } = createHarness({
      verifyAccessToken: () => {
        throw new Error('invalid token');
      },
    });
    const server = new EventEmitter();
    gateway.attach(server as unknown as HttpServer);

    const socket = { write: jest.fn(), destroy: jest.fn() };
    server.emit(
      'upgrade',
      { url: '/api/v1/realtime', headers: { authorization: 'Bearer nope' } },
      socket,
      Buffer.alloc(0),
    );
    await flush();

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('401 Unauthorized'));
    expect(wsServer.handleUpgradeMock).not.toHaveBeenCalled();

    await gateway.close();
  });

  it('never accepts a token from the query string', async () => {
    const { gateway } = createHarness();
    const server = new EventEmitter();
    gateway.attach(server as unknown as HttpServer);

    const socket = { write: jest.fn(), destroy: jest.fn() };
    server.emit(
      'upgrade',
      { url: '/api/v1/realtime?token=valid-token&access_token=valid-token', headers: {} },
      socket,
      Buffer.alloc(0),
    );
    await flush();

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('401 Unauthorized'));

    await gateway.close();
  });

  it('ignores upgrades addressed to another path', async () => {
    const { gateway } = createHarness();
    const server = new EventEmitter();
    gateway.attach(server as unknown as HttpServer);

    const socket = { write: jest.fn(), destroy: jest.fn() };
    server.emit('upgrade', { url: '/other', headers: {} }, socket, Buffer.alloc(0));
    await flush();

    expect(socket.write).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();

    await gateway.close();
  });

  it('accepts an authenticated upgrade and registers the connection', async () => {
    const { gateway, wsServer } = createHarness();
    const server = new EventEmitter();
    gateway.attach(server as unknown as HttpServer);

    const socket = { write: jest.fn(), destroy: jest.fn() };
    server.emit(
      'upgrade',
      { url: '/api/v1/realtime', headers: { 'sec-websocket-protocol': 'bearer, good-token' } },
      socket,
      Buffer.alloc(0),
    );
    await flush();

    expect(wsServer.handleUpgradeMock).toHaveBeenCalledTimes(1);
    expect(gateway.getStats().connections).toBe(1);

    await gateway.close();
  });

  it('refuses to attach twice', () => {
    const { gateway } = createHarness();
    const server = new EventEmitter();
    gateway.attach(server as unknown as HttpServer);

    expect(() => {
      gateway.attach(server as unknown as HttpServer);
    }).toThrow(/already attached/);
  });

  it('shuts down cleanly: sockets closed with 1001, registry empty, no timers left', async () => {
    jest.useFakeTimers();
    try {
      const { gateway, wsServer } = createHarness();
      const server = new EventEmitter();
      gateway.attach(server as unknown as HttpServer);

      const first = new FakeSocket();
      const second = new FakeSocket();
      gateway.handleConnection(first, auth);
      gateway.handleConnection(second, auth);
      send(first, { type: 'subscribe', topic: 'deals' });
      await flush();

      await gateway.close();

      expect(first.closeCalls).toEqual([{ code: 1001, reason: 'Server shutting down' }]);
      expect(second.closeCalls).toEqual([{ code: 1001, reason: 'Server shutting down' }]);
      expect(gateway.getStats()).toEqual({ connections: 0, topics: 0, subscriptions: 0 });
      expect(jest.getTimerCount()).toBe(0);
      expect(wsServer.closeMock).toHaveBeenCalled();
      expect(server.listenerCount('upgrade')).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects upgrades that arrive after shutdown started', async () => {
    const { gateway } = createHarness();
    const server = new EventEmitter();
    gateway.attach(server as unknown as HttpServer);

    // Capture the listener before close() removes it, mimicking an in-flight upgrade.
    const listeners = server.listeners('upgrade');
    await gateway.close();

    const socket = { write: jest.fn(), destroy: jest.fn() };
    for (const listener of listeners) {
      (listener as (...args: unknown[]) => void)(
        { url: '/api/v1/realtime', headers: { authorization: 'Bearer good' } },
        socket,
        Buffer.alloc(0),
      );
    }
    await flush();

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('503 Service Unavailable'));
  });
});
