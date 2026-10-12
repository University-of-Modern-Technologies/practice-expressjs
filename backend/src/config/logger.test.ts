import { Writable } from 'node:stream';

import { describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { createRequestLogger } from '../common/middleware/request-logger.js';
import { createTestConfig } from '../test/config.js';
import { createLogger } from './logger.js';

const REFRESH_TOKEN = 'refresh-token-value-that-must-not-leak';
const ACCESS_TOKEN = 'access-token-value-that-must-not-leak';

const captureLines = (): { stream: Writable; lines: () => string[] } => {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  return { stream, lines: () => chunks.join('').split('\n').filter(Boolean) };
};

describe('logger redaction', () => {
  it('keeps the credentials of a request and its response out of the access log', async () => {
    const { stream, lines } = captureLines();
    const logger = createLogger(createTestConfig({ logLevel: 'info' }), stream);

    const app = express();
    app.use(createRequestLogger(logger));
    // The refresh flow answers with a fresh token in `Set-Cookie`: the access
    // log serialises response headers, so that header is where it would leak.
    app.post('/login', (_request, response) => {
      response.cookie('refreshToken', REFRESH_TOKEN, { httpOnly: true });
      response.status(204).end();
    });

    await request(app)
      .post('/login')
      .set('authorization', `Bearer ${ACCESS_TOKEN}`)
      .set('cookie', `refreshToken=${REFRESH_TOKEN}`);

    const output = lines().join('\n');
    expect(output).not.toContain(REFRESH_TOKEN);
    expect(output).not.toContain(ACCESS_TOKEN);

    const entry = JSON.parse(lines().at(-1) ?? '{}') as {
      req?: { headers?: Record<string, unknown> };
      res?: { headers?: Record<string, unknown> };
    };
    expect(entry.res?.headers?.['set-cookie']).toBe('[REDACTED]');
    expect(entry.req?.headers?.cookie).toBe('[REDACTED]');
    expect(entry.req?.headers?.authorization).toBe('[REDACTED]');
  });
});
