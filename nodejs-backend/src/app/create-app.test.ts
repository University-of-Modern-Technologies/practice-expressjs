import { describe, expect, it } from '@jest/globals';
import pino from 'pino';
import request from 'supertest';

import { createTestConfig } from '../test/config.js';
import { createApp } from './create-app.js';

const config = createTestConfig({ corsOrigins: ['http://localhost:5173'] });

const app = createApp({ config, logger: pino({ level: 'silent' }) });

describe('application shell', () => {
  it('returns a request ID and security headers', async () => {
    const response = await request(app).get('/health/live');

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('preserves a caller-provided request ID', async () => {
    const response = await request(app).get('/health/live').set('x-request-id', 'test-request-id');

    expect(response.headers['x-request-id']).toBe('test-request-id');
  });

  it('returns the standard error envelope for unknown routes', async () => {
    const response = await request(app).get('/missing');

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      error: { code: 'NOT_FOUND' },
      requestId: expect.any(String),
    });
  });
});
