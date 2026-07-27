import pino, { type Logger } from 'pino';

import type { AppConfig } from './env.js';

// The pretty transport is a dev-only dependency and is absent from production
// container images even when NODE_ENV=development is injected via env files.
const supportsPrettyTransport = (): boolean => {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
};

export const createLogger = (config: AppConfig): Logger => {
  const baseOptions = {
    level: config.logLevel,
    base: {
      service: 'nodejs-backend',
      environment: config.nodeEnv,
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'password',
        '*.password',
        'token',
        '*.token',
      ],
      censor: '[REDACTED]',
    },
  };

  return config.nodeEnv === 'development' && supportsPrettyTransport()
    ? pino({
        ...baseOptions,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, singleLine: true, translateTime: 'SYS:standard' },
        },
      })
    : pino(baseOptions);
};
