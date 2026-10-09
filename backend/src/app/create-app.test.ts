import { describe, expect, it } from '@jest/globals';
import { Router, type Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { z } from 'zod';

import { createMetricsRegistry } from '../common/observability/index.js';
import { describeRoutes, ok } from '../common/openapi/index.js';
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

  it('serves the API description of the routers it mounts', async () => {
    const router = Router();
    describeRoutes(router, [{ name: 'Widgets', description: 'Widgets' }]).get(
      '/',
      { summary: 'List widgets', response: ok('Widgets', z.array(z.string())), refusals: {} },
      (_request, response) => {
        response.json({ data: [] });
      },
    );
    const withWidgets = createApp({
      config,
      logger: pino({ level: 'silent' }),
      routers: [{ path: '/api/v1/widgets', router }],
    });

    const response = await request(withWidgets).get('/api/openapi.json');

    expect(response.body).toMatchObject({
      openapi: '3.1.0',
      paths: {
        '/api/health/live': { get: expect.any(Object) },
        '/api/v1/widgets': { get: { operationId: 'get_api_v1_widgets' } },
      },
    });
  });

  it('serves neither the description nor the docs page when they are switched off', async () => {
    const withoutDocs = createApp({
      config: createTestConfig({ apiDocsEnabled: false }),
      logger: pino({ level: 'silent' }),
    });

    expect((await request(withoutDocs).get('/api/openapi.json')).status).toBe(404);
    expect((await request(withoutDocs).get('/api/docs/')).status).toBe(404);
    expect((await request(withoutDocs).get('/api/health/live')).status).toBe(200);
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

describe('request bodies the parser refuses', () => {
  const echo = Router();
  echo.post('/', (request, response) => {
    response.json({ received: request.body as unknown });
  });
  const withEcho = createApp({
    config: createTestConfig({ jsonBodyLimit: 1_024 }),
    logger: pino({ level: 'silent' }),
    routers: [{ path: '/api/v1/echo', router: echo }],
  });

  it('answers 413 in the error envelope for a body above the limit', async () => {
    const response = await request(withEcho)
      .post('/api/v1/echo')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ note: 'x'.repeat(2_048) }));

    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({
      error: { code: 'PAYLOAD_TOO_LARGE' },
      requestId: expect.any(String),
    });
  });

  it('answers 415 for a body in an encoding the parser cannot read', async () => {
    const response = await request(withEcho)
      .post('/api/v1/echo')
      .set('content-type', 'application/json; charset=koi8-r')
      .send('{}');

    expect(response.status).toBe(415);
    expect(response.body).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } });
  });

  it('keeps answering 400 for malformed JSON', async () => {
    const response = await request(withEcho)
      .post('/api/v1/echo')
      .set('content-type', 'application/json')
      .send('{"broken":');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'INVALID_JSON' } });
  });
});

describe('client address behind a proxy', () => {
  const whoami = Router();
  whoami.get('/', (request, response) => {
    response.json({ ip: request.ip });
  });
  const build = (trustedProxies: readonly string[]): Express =>
    createApp({
      config: createTestConfig({ trustedProxies }),
      logger: pino({ level: 'silent' }),
      routers: [{ path: '/api/v1/whoami', router: whoami }],
    });

  it('ignores X-Forwarded-For when no proxy is trusted', async () => {
    const response = await request(build([]))
      .get('/api/v1/whoami')
      .set('x-forwarded-for', '203.0.113.7');

    expect(response.body.ip).not.toBe('203.0.113.7');
  });

  it('takes the client address from a trusted proxy', async () => {
    const response = await request(build(['127.0.0.1', '::1']))
      .get('/api/v1/whoami')
      .set('x-forwarded-for', '203.0.113.7');

    expect(response.body.ip).toBe('203.0.113.7');
  });
});
