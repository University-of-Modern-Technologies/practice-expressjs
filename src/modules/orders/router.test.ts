import { describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import request from 'supertest';

import type { OrdersController } from './controller.js';
import { createOrdersRouter } from './router.js';

const noContent: RequestHandler = (_request, response) => {
  response.status(204).end();
};

const controller = {
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
