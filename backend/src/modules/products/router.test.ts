import { describe, expect, it, jest } from '@jest/globals';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import request from 'supertest';

import { AppError } from '../../common/errors/index.js';
import type { RbacService } from '../rbac/service.js';
import { createProductsController } from './controller.js';
import { createProductsRouter } from './router.js';
import type { ProductsService } from './service.js';

const renderError: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  const appError = error instanceof AppError ? error : new AppError('boom', 500, 'INTERNAL');
  response.status(appError.statusCode).json({ error: { code: appError.code } });
};

const buildApp = (scope: 'ALL' | null) => {
  const rbac = { getPermissionScope: jest.fn(async () => scope) } as unknown as RbacService;
  const service = {
    create: jest.fn(async () => ({ id: 'product-1' })),
  } as unknown as ProductsService;
  const signedIn: RequestHandler = (req, _response, next) => {
    req.auth = { userId: 'user-1', sessionId: 'session-1' };
    next();
  };
  const app = express()
    .use(express.json())
    .use('/products', createProductsRouter(createProductsController(service, rbac), signedIn))
    .use(renderError);
  return { app, rbac, service };
};

describe('products router permission order', () => {
  it('refuses a caller without the grant before it looks at the body', async () => {
    const { app, service } = buildApp(null);

    const response = await request(app).post('/products').send({ sku: '' }).expect(403);

    expect(response.body).toEqual({ error: { code: 'FORBIDDEN' } });
    expect(service.create).not.toHaveBeenCalled();
  });

  it('refuses a caller without the grant before it looks at the query', async () => {
    const { app } = buildApp(null);

    await request(app).get('/products?pageSize=1000').expect(403);
  });

  it('validates the body once the grant is confirmed', async () => {
    const { app, rbac } = buildApp('ALL');

    const response = await request(app).post('/products').send({ sku: '' }).expect(400);

    expect(response.body).toEqual({ error: { code: 'VALIDATION_ERROR' } });
    expect(rbac.getPermissionScope).toHaveBeenCalledTimes(1);
  });
});
