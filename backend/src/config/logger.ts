import pino, { type DestinationStream, type Logger } from 'pino';

import type { AppConfig } from './env.js';

// The pretty transport is a dev-only dependency and is absent from production
// container images even when APP_ENV=development is injected via env files.
const supportsPrettyTransport = (): boolean => {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
};

/**
 * Fields that never reach a log line in clear text. The request carries the
 * session in `Authorization` and `Cookie`; the response hands out a fresh
 * refresh token in `Set-Cookie`, which is just as much a credential.
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'token',
  '*.token',
];

/**
 * `destination` exists for tests that need to read what was written; the
 * running service always logs to standard output.
 */
export const createLogger = (config: AppConfig, destination?: DestinationStream): Logger => {
  const baseOptions = {
    level: config.logLevel,
    base: {
      service: 'nodejs-backend',
      environment: config.appEnv,
    },
    redact: {
      paths: [...LOG_REDACT_PATHS],
      censor: '[REDACTED]',
    },
  };

  if (destination) return pino(baseOptions, destination);

  return config.appEnv === 'development' && supportsPrettyTransport()
    ? pino({
        ...baseOptions,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, singleLine: true, translateTime: 'SYS:standard' },
        },
      })
    : pino(baseOptions);
};
