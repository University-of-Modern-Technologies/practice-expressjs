import { describe, expect, it, jest } from '@jest/globals';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import request from 'supertest';

import { AppError } from '../../common/errors/index.js';
import type { RbacService } from '../rbac/service.js';
import { createOrdersController, type OrdersController } from './controller.js';
import { createOrdersRouter } from './router.js';
import type { OrdersService } from './service.js';

const noContent: RequestHandler = (_request, response) => {
  response.status(204).end();
};

const pass: RequestHandler = (_request, _response, next) => next();

const controller = {
  authorize: { read: pass, write: pass, delete: pass },
  list: noContent,
  getById: noContent,
  create: noContent,
  duplicate: jest.fn(noContent),
  update: jest.fn(noContent),
  addItem: jest.fn(noContent),
  updateItem: jest.fn(noContent),
  removeItem: jest.fn(noContent),
  transition: jest.fn(noContent),
  delete: noContent,
} as OrdersController;

const authenticate: RequestHandler = (_request, _response, next) => next();

const app = express()
  .use(express.json())
  .use('/orders', createOrdersRouter(controller, authenticate));

const id = '5ff875e1-4c1d-4e45-9c8a-fceb5fb5d836';
const itemId = '0e3e1b74-25cf-4b6b-8f3e-2d1a4e30cf01';

describe('orders router', () => {
  it('exposes status changes at POST /:id/transitions only', async () => {
    await request(app)
      .post(`/orders/${id}/transitions`)
      .send({ version: 1, status: 'CONFIRMED' })
      .expect(204);
    await request(app)
      .post(`/orders/${id}/status`)
      .send({ version: 1, status: 'CONFIRMED' })
      .expect(404);

    expect(controller.transition).toHaveBeenCalledTimes(1);
  });

  it('ignores a status supplied through a plain update', async () => {
    await request(app)
      .patch(`/orders/${id}`)
      .send({ version: 1, notes: 'rush', status: 'PAID' })
      .expect(204);

    expect(controller.update).toHaveBeenCalledTimes(1);
  });

  it('routes POST /:id/duplicate to its handler', async () => {
    await request(app).post(`/orders/${id}/duplicate`).expect(204);

    expect(controller.duplicate).toHaveBeenCalledTimes(1);
  });

  it('routes the item endpoints to their handlers', async () => {
    await request(app)
      .post(`/orders/${id}/items`)
      .send({ version: 1, productId: itemId, quantity: 2 })
      .expect(204);
    await request(app)
      .patch(`/orders/${id}/items/${itemId}`)
      .send({ version: 1, quantity: 3 })
      .expect(204);
    await request(app).delete(`/orders/${id}/items/${itemId}?version=1`).expect(204);

    expect(controller.addItem).toHaveBeenCalledTimes(1);
    expect(controller.updateItem).toHaveBeenCalledTimes(1);
    expect(controller.removeItem).toHaveBeenCalledTimes(1);
  });
});

describe('orders router permission order', () => {
  const renderError: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    const appError = error instanceof AppError ? error : new AppError('boom', 500, 'INTERNAL');
    response.status(appError.statusCode).json({ error: { code: appError.code } });
  };

  const buildApp = (scope: 'ALL' | null) => {
    const rbac = {
      getPermissionScope: jest.fn(async () => scope),
    } as unknown as RbacService;
    const service = {
      create: jest.fn(async () => ({ id })),
    } as unknown as OrdersService;
    const signedIn: RequestHandler = (req, _response, next) => {
      req.auth = { userId: 'user-1', sessionId: 'session-1' };
      next();
    };
    const app = express()
      .use(express.json())
      .use('/orders', createOrdersRouter(createOrdersController(service, rbac), signedIn))
      .use(renderError);
    return { app, rbac, service };
  };

  it('refuses a caller without the grant before it looks at the body', async () => {
    const { app } = buildApp(null);

    const response = await request(app).post('/orders').send({ items: 'not-a-list' }).expect(403);

    expect(response.body).toEqual({ error: { code: 'FORBIDDEN' } });
  });

  it('refuses a caller without the grant before it looks at the path', async () => {
    const { app } = buildApp(null);

    await request(app).get('/orders/not-a-uuid').expect(403);
  });

  it('still validates the body once the grant is confirmed, asking for the grant only once', async () => {
    const { app, rbac, service } = buildApp('ALL');

    const response = await request(app).post('/orders').send({ items: 'not-a-list' }).expect(400);

    expect(response.body).toEqual({ error: { code: 'VALIDATION_ERROR' } });
    expect(service.create).not.toHaveBeenCalled();

    await request(app).post('/orders').send({}).expect(201);
    // One lookup per request: the handler reuses what the guard resolved.
    expect(rbac.getPermissionScope).toHaveBeenCalledTimes(2);
  });
});
