import { describe, expect, it } from '@jest/globals';
import express, { type Express } from 'express';
import request from 'supertest';

import { createCacheInvalidation } from './cache-invalidation.js';

const PREFIX = 'analytics:';

const createTestApp = (dropped: string[], order: string[] = []): Express => {
  const app = express();
  app.use(express.json());
  app.use(
    createCacheInvalidation({
      cache: {
        invalidatePrefix(prefix) {
          dropped.push(prefix);
          order.push('invalidated');
          return Promise.resolve();
        },
      },
      prefixes: [PREFIX],
      exemptPathPrefixes: ['/api/v1/auth'],
    }),
  );
  app.get('/items', (_request, response) => {
    response.json({ ok: true });
  });
  app.post('/items', (_request, response) => {
    response.status(201).json({ ok: true });
  });
  app.post('/rejected', (_request, response) => {
    response.status(409).json({ ok: false });
  });
  app.post('/api/v1/auth/login', (_request, response) => {
    response.json({ ok: true });
  });
  return app;
};

describe('cache invalidation', () => {
  it('drops the reports after a successful write, before the response is sent', async () => {
    const dropped: string[] = [];
    const order: string[] = [];
    const app = createTestApp(dropped, order);

    const response = await request(app).post('/items').send({});
    order.push('answered');

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ ok: true });
    expect(dropped).toEqual([PREFIX]);
    expect(order).toEqual(['invalidated', 'answered']);
  });

  it('keeps the reports on a read', async () => {
    const dropped: string[] = [];

    await request(createTestApp(dropped)).get('/items');

    expect(dropped).toEqual([]);
  });

  it('keeps the reports when the write is rejected', async () => {
    const dropped: string[] = [];

    const response = await request(createTestApp(dropped)).post('/rejected').send({});

    expect(response.status).toBe(409);
    expect(dropped).toEqual([]);
  });

  it('keeps the reports when signing in', async () => {
    const dropped: string[] = [];

    await request(createTestApp(dropped)).post('/api/v1/auth/login').send({});

    expect(dropped).toEqual([]);
  });
});
