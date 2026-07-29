import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';

import { serviceLifecycle } from './app/index.js';
import { createCompositionRoot } from './composition-root.js';
import { loadConfig } from './config/index.js';

/** Exit codes, kept explicit so orchestrators can distinguish failure modes. */
const EXIT_CODE = {
  ok: 0,
  cleanupFailed: 1,
  fatalError: 2,
  shutdownTimedOut: 3,
  startupFailed: 4,
} as const;

const delay = (ms: number): Promise<void> =>
  ms <= 0
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        setTimeout(resolve, ms).unref();
      });

/**
 * Tracks every open socket so shutdown can close idle keep-alive connections
 * immediately and destroy the stubborn ones once the grace period expires.
 */
const createConnectionTracker = (
  server: Server,
): { readonly size: number; closeIdle: () => void; destroyAll: () => void } => {
  const sockets = new Set<Socket>();
  const activeSockets = new WeakSet<Socket>();

  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  server.on('request', (request, response) => {
    const socket = request.socket;
    activeSockets.add(socket);
    response.once('finish', () => activeSockets.delete(socket));
  });

  return {
    get size(): number {
      return sockets.size;
    },
    closeIdle(): void {
      for (const socket of sockets) {
        if (!activeSockets.has(socket)) socket.destroy();
      }
    },
    destroyAll(): void {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
};

const closeServer = async (server: Server): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

const config = loadConfig();
const compositionRoot = createCompositionRoot(config);
const logger = compositionRoot.logger;
const server = createServer(compositionRoot.app);
const connections = createConnectionTracker(server);

// The realtime gateway owns the HTTP upgrade event, so it must be attached
// before the listener starts accepting connections.
compositionRoot.realtime.attach(server);

const graceMs = config.shutdownGracePeriodMs;
const timeoutMs = config.shutdownTimeoutMs;
const drainDelayMs = config.shutdownDrainDelayMs;

// Bound the time a client may hold a connection open without sending a request,
// so keep-alive sockets cannot silently accumulate.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

let isShuttingDown = false;

const forceExit = (code: number): never => {
  logger.flush();
  process.exit(code);
};

const shutdown = async (reason: string, exitCode: number): Promise<void> => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ reason, openConnections: connections.size }, 'Graceful shutdown started');

  // Readiness fails from this point on, which is what removes the instance from
  // the load balancer pool while in-flight requests still complete.
  serviceLifecycle.beginDraining();

  const hardTimer = setTimeout(() => {
    logger.fatal({ reason, timeoutMs }, 'Shutdown timed out; forcing exit');
    forceExit(EXIT_CODE.shutdownTimedOut);
  }, timeoutMs);
  hardTimer.unref();

  let finalExitCode = exitCode;

  try {
    await delay(drainDelayMs);

    // Stop accepting new connections, then hang up sockets that are idle.
    const serverClosed = closeServer(server);
    connections.closeIdle();

    const graceTimer = setTimeout(() => {
      logger.warn(
        { openConnections: connections.size, graceMs },
        'Grace period elapsed; destroying remaining connections',
      );
      connections.destroyAll();
    }, graceMs);
    graceTimer.unref();

    try {
      await serverClosed;
      logger.info('HTTP listener closed');
    } finally {
      clearTimeout(graceTimer);
    }
  } catch (error) {
    logger.error({ error }, 'HTTP listener shutdown failed');
    finalExitCode = finalExitCode === EXIT_CODE.ok ? EXIT_CODE.cleanupFailed : finalExitCode;
    connections.destroyAll();
  }

  try {
    await compositionRoot.close();
    logger.info('Application resources released');
  } catch (error) {
    logger.error({ error }, 'Application cleanup failed');
    finalExitCode = finalExitCode === EXIT_CODE.ok ? EXIT_CODE.cleanupFailed : finalExitCode;
  }

  clearTimeout(hardTimer);
  serviceLifecycle.markStopped();
  logger.info({ reason, exitCode: finalExitCode }, 'Shutdown complete');
  forceExit(finalExitCode);
};

const handleSignal = (signal: NodeJS.Signals): void => {
  void shutdown(signal, EXIT_CODE.ok);
};

const handleFatal = (error: unknown, origin: string): void => {
  logger.fatal({ error, origin }, 'Fatal error; shutting down');
  void shutdown(origin, EXIT_CODE.fatalError);
};

process.once('SIGINT', handleSignal);
process.once('SIGTERM', handleSignal);
process.on('uncaughtException', (error) => {
  handleFatal(error, 'uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  handleFatal(reason, 'unhandledRejection');
});

server.on('error', (error) => {
  logger.fatal({ error }, 'HTTP server error');
  void shutdown('server-error', EXIT_CODE.startupFailed);
});

compositionRoot
  .start()
  .then(() => {
    server.listen(config.port, config.host, () => {
      serviceLifecycle.markStarted();
      logger.info(
        { host: config.host, port: config.port, nodeEnv: config.nodeEnv, wsPath: config.wsPath },
        'HTTP server listening',
      );
    });
  })
  .catch((error: unknown) => {
    logger.fatal({ error }, 'Startup failed');
    void shutdown('startup', EXIT_CODE.startupFailed);
  });
