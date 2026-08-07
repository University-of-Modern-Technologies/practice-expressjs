import { beforeEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { createHealthRouter } from './health.routes.js';
import { createServiceLifecycle, type ServiceLifecycle } from './lifecycle.js';
import type { ReadinessCheck } from './readiness.js';

const never = (): Promise<void> => new Promise<void>(() => undefined);

const createTestApp = (
  checks: readonly ReadinessCheck[] = [],
  lifecycle: ServiceLifecycle = createServiceLifecycle(),
  checkTimeoutMs = 50,
): express.Express => {
  lifecycle.markStarted();
  return express().use('/health', createHealthRouter(checks, { lifecycle, checkTimeoutMs }));
};

describe('health routes', () => {
  let lifecycle: ServiceLifecycle;

  beforeEach(() => {
    lifecycle = createServiceLifecycle();
  });

  it('reports the process as live without touching dependencies', async () => {
    const app = createTestApp([{ name: 'database', check: never }], lifecycle);

    const response = await request(app).get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('stays live while draining', async () => {
    const app = createTestApp([], lifecycle);
    lifecycle.beginDraining();

    const response = await request(app).get('/health/live');

    expect(response.status).toBe(200);
  });

  it('reports readiness when every check passes', async () => {
    const app = createTestApp(
      [
        { name: 'database', check: () => Promise.resolve() },
        { name: 'cache', check: () => Promise.resolve() },
      ],
      lifecycle,
    );

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ready');
    expect(response.body.checks).toHaveLength(2);
    expect(response.body.checks).toEqual([
      { name: 'database', status: 'up', durationMs: expect.any(Number), critical: true },
      { name: 'cache', status: 'up', durationMs: expect.any(Number), critical: true },
    ]);
  });

  it('reports failed readiness dependencies without leaking error details', async () => {
    const app = createTestApp(
      [
        {
          name: 'database',
          check: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:5432')),
        },
      ],
      lifecycle,
    );

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('not_ready');
    expect(response.body.checks).toEqual([
      { name: 'database', status: 'down', durationMs: expect.any(Number), critical: true },
    ]);
    expect(JSON.stringify(response.body)).not.toContain('ECONNREFUSED');
  });

  it('times a hanging check out instead of hanging the endpoint', async () => {
    const app = createTestApp(
      [
        { name: 'fast', check: () => Promise.resolve() },
        { name: 'stuck', check: never },
      ],
      lifecycle,
      30,
    );

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body.checks).toEqual([
      { name: 'fast', status: 'up', durationMs: expect.any(Number), critical: true },
      { name: 'stuck', status: 'timed_out', durationMs: expect.any(Number), critical: true },
    ]);
  });

  it('runs checks concurrently rather than sequentially', async () => {
    const slow = (): Promise<void> =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 60);
      });
    const app = createTestApp(
      [
        { name: 'a', check: slow },
        { name: 'b', check: slow },
        { name: 'c', check: slow },
      ],
      lifecycle,
      500,
    );

    const startedAt = Date.now();
    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(200);
    expect(Date.now() - startedAt).toBeLessThan(180);
  });

  it('stays ready when only a non-critical check fails', async () => {
    const app = createTestApp(
      [
        { name: 'database', check: () => Promise.resolve() },
        { name: 'search', critical: false, check: () => Promise.reject(new Error('down')) },
      ],
      lifecycle,
    );

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('degraded');
  });

  it('honours a per-check timeout override', async () => {
    const app = createTestApp([{ name: 'stuck', check: never, timeoutMs: 20 }], lifecycle, 10_000);

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body.checks[0].status).toBe('timed_out');
  });

  it('reports not ready before startup completes', async () => {
    const app = express().use('/health', createHealthRouter([], { lifecycle }));

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'not_ready', phase: 'starting', checks: [] });
  });

  it('reports draining and skips checks during shutdown', async () => {
    let invoked = false;
    const app = createTestApp(
      [
        {
          name: 'database',
          check: () => {
            invoked = true;
            return Promise.resolve();
          },
        },
      ],
      lifecycle,
    );
    lifecycle.beginDraining();

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('draining');
    expect(invoked).toBe(false);
  });

  it('exposes the startup probe', async () => {
    const app = express().use('/health', createHealthRouter([], { lifecycle }));

    const starting = await request(app).get('/health/startup');
    expect(starting.status).toBe(503);
    expect(starting.body.status).toBe('starting');

    lifecycle.markStarted();

    const started = await request(app).get('/health/startup');
    expect(started.status).toBe(200);
    expect(started.body.status).toBe('started');
  });

  it('exposes non-sensitive service information', async () => {
    const app = createTestApp([], lifecycle);

    const response = await request(app).get('/health/info');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      name: expect.any(String),
      version: expect.any(String),
      nodeEnv: expect.any(String),
      phase: 'started',
      uptimeSeconds: expect.any(Number),
    });
  });
});
