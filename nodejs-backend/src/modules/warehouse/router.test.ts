import { describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import request from 'supertest';

import type { WarehouseController } from './controller.js';
import { createWarehouseRouter } from './router.js';

const noContent: RequestHandler = (_request, response) => {
  response.status(204).end();
};

const controller = {
  listWarehouses: noContent,
  getWarehouse: noContent,
  createWarehouse: noContent,
  updateWarehouse: noContent,
  listStock: noContent,
  getStock: noContent,
  receive: jest.fn(noContent),
  issue: noContent,
  reserve: noContent,
  release: noContent,
  adjust: noContent,
  listMovements: jest.fn(noContent),
} as WarehouseController;

const authenticate: RequestHandler = (_request, _response, next) => next();

const buildApp = () =>
  express().use(express.json()).use('/warehouse', createWarehouseRouter(controller, authenticate));

const warehouseId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';

describe('warehouse router', () => {
  it('routes a receipt to the receive handler', async () => {
    await request(buildApp())
      .post('/warehouse/stock/receive')
      .send({ warehouseId, productId, quantity: 5 })
      .expect(204);

    expect(controller.receive).toHaveBeenCalledTimes(1);
  });

  it('keeps the movement ledger append-only', async () => {
    const app = buildApp();

    await request(app).get('/warehouse/movements').expect(204);
    await request(app).patch('/warehouse/movements/movement-1').expect(404);
    await request(app).delete('/warehouse/movements/movement-1').expect(404);

    expect(controller.listMovements).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed stock lookup before reaching the controller', async () => {
    await request(buildApp()).get(`/warehouse/stock/not-a-uuid/${productId}`).expect(400);
  });

  it('rejects an adjustment without a note', async () => {
    await request(buildApp())
      .post('/warehouse/stock/adjust')
      .send({ warehouseId, productId, delta: -3 })
      .expect(400);
  });
});
