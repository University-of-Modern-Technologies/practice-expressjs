import { describe, expect, it } from '@jest/globals';
import express, { type Express, Router } from 'express';
import request from 'supertest';

import { createMetricsMiddleware, UNMATCHED_ROUTE_LABEL } from './http-metrics.js';
import { createMetricsRegistry, type MetricsRegistry } from './metrics-registry.js';
import {
  allowAllMetricsGuard,
  createBearerTokenMetricsGuard,
  createMetricsRouter,
  PROMETHEUS_CONTENT_TYPE,
} from './metrics.routes.js';

const createTestApp = (registry: MetricsRegistry): Express => {
  const app = express();
  app.use(createMetricsMiddleware(registry));

  const deals = Router();
  deals.get('/:id', (_request, response) => {
    response.json({ ok: true });
  });
  deals.post('/', (_request, response) => {
    response.status(201).json({ ok: true });
  });

  app.use('/api/v1/deals', deals);
  app.get('/boom', (_request, response) => {
    response.status(500).json({ ok: false });
  });

  return app;
};

describe('http metrics middleware', () => {
  it('counts requests by method, route pattern and status', async () => {
    const registry = createMetricsRegistry();
    const app = createTestApp(registry);

    await request(app).get('/api/v1/deals/42');
    await request(app).get('/api/v1/deals/99');
    await request(app).post('/api/v1/deals').send({});

    const rendered = registry.render();

    expect(rendered).toContain(
      'http_requests_total{method="GET",route="/api/v1/deals/:id",status="200"} 2',
    );
    expect(rendered).toContain(
      'http_requests_total{method="POST",route="/api/v1/deals",status="201"} 1',
    );
  });

  it('never uses raw URLs as the route label', async () => {
    const registry = createMetricsRegistry();
    const app = createTestApp(registry);

    await request(app).get('/api/v1/deals/super-secret-identifier?token=leak');

    const rendered = registry.render();

    expect(rendered).not.toContain('super-secret-identifier');
    expect(rendered).not.toContain('token=leak');
    expect(rendered).toContain('route="/api/v1/deals/:id"');
  });

  it('labels unmatched requests with a single bounded value', async () => {
    const registry = createMetricsRegistry();
    const app = createTestApp(registry);

    await request(app).get('/nope/1');
    await request(app).get('/nope/2');

    expect(registry.render()).toContain(
      `http_requests_total{method="GET",route="${UNMATCHED_ROUTE_LABEL}",status="404"} 2`,
    );
  });

  it('records a duration histogram and an in-flight gauge', async () => {
    const registry = createMetricsRegistry();
    const app = createTestApp(registry);

    await request(app).get('/boom');

    const rendered = registry.render();

    expect(rendered).toContain('# TYPE http_request_duration_seconds histogram');
    expect(rendered).toContain('http_request_duration_seconds_count{method="GET",route="/boom"} 1');
    expect(rendered).toContain('http_requests_in_flight 0');
    expect(rendered).toContain('status="500"');
  });

  it('records each request exactly once', async () => {
    const registry = createMetricsRegistry();
    const app = createTestApp(registry);

    await request(app).get('/api/v1/deals/1');

    expect(registry.render()).toContain(
      'http_requests_total{method="GET",route="/api/v1/deals/:id",status="200"} 1',
    );
  });
});

describe('metrics router', () => {
  it('serves the exposition format behind an explicit guard', async () => {
    const registry = createMetricsRegistry();
    registry.counter({ name: 'jobs_total', help: 'Jobs.' }).inc();
    const app = express().use(
      '/metrics',
      createMetricsRouter({ registry, guard: allowAllMetricsGuard }),
    );

    const response = await request(app).get('/metrics');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe(PROMETHEUS_CONTENT_TYPE);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.text).toContain('jobs_total 1');
  });

  it('hides the endpoint from unauthenticated scrapers', async () => {
    const registry = createMetricsRegistry();
    const app = express().use(
      '/metrics',
      createMetricsRouter({
        registry,
        guard: createBearerTokenMetricsGuard('a-sufficiently-long-token'),
      }),
    );

    const anonymous = await request(app).get('/metrics');
    expect(anonymous.status).toBe(404);
    expect(anonymous.text).toBe('');

    const wrongToken = await request(app)
      .get('/metrics')
      .set('authorization', 'Bearer not-the-right-token');
    expect(wrongToken.status).toBe(404);

    const authorised = await request(app)
      .get('/metrics')
      .set('authorization', 'Bearer a-sufficiently-long-token');
    expect(authorised.status).toBe(200);
  });

  it('refuses a weak scrape token', () => {
    expect(() => createBearerTokenMetricsGuard('short')).toThrow(/at least 16 characters/);
  });
});
