import { describe, expect, it } from '@jest/globals';
import pino from 'pino';
import request from 'supertest';

import { createMetricsRegistry } from '../common/observability/index.js';
import { createTestConfig } from '../test/config.js';
import { createApp } from './create-app.js';

const config = createTestConfig({ corsOrigins: ['http://localhost:5173'] });

const app = createApp({ config, logger: pino({ level: 'silent' }) });

describe('application shell', () => {
  it('returns a request ID and security headers', async () => {
    const response = await request(app).get('/api/health/live');

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('preserves a caller-provided request ID', async () => {
    const response = await request(app)
      .get('/api/health/live')
      .set('x-request-id', 'test-request-id');

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

describe('service routes', () => {
  it('serves every service route under /api only', async () => {
    for (const path of ['/health/live', '/openapi.json', '/docs/']) {
      expect((await request(app).get(path)).status).toBe(404);
    }

    expect((await request(app).get('/api/health/live')).status).toBe(200);
    expect((await request(app).get('/api/openapi.json')).body).toMatchObject({
      openapi: expect.any(String),
    });
  });

  it('redirects the documentation root so relative asset links resolve under /api/docs/', async () => {
    const response = await request(app).get('/api/docs');

    expect(response.status).toBe(301);
    expect(response.headers.location).toBe('/api/docs/');
  });

  it('serves the documentation page together with every asset it links', async () => {
    const page = await request(app).get('/api/docs/');

    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);

    const assets = [...page.text.matchAll(/(?:href|src)=["']\.\/([^"']+)["']/g)].map(
      ([, asset]) => asset,
    );
    expect(assets).toEqual(
      expect.arrayContaining(['swagger-ui.css', 'swagger-ui-bundle.js', 'swagger-ui-init.js']),
    );

    for (const asset of assets) {
      const response = await request(app).get(`/api/docs/${asset ?? ''}`);
      expect({ asset, status: response.status }).toEqual({ asset, status: 200 });
    }
  });

  it('mounts metrics under /api once a scrape token is configured', async () => {
    const token = 'a-sufficiently-long-token';
    const withMetrics = createApp({
      config: createTestConfig({ metricsToken: token }),
      logger: pino({ level: 'silent' }),
      metrics: createMetricsRegistry(),
    });

    const response = await request(withMetrics)
      .get('/api/metrics')
      .set('authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect((await request(withMetrics).get('/metrics')).status).toBe(404);
  });
});
