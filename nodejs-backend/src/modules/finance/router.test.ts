import { describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import request from 'supertest';

import type { FinanceController } from './controller.js';
import { createFinanceRouter } from './router.js';

const noContent: RequestHandler = (_request, response) => {
  response.status(204).end();
};

const controller = {
  listStatements: noContent,
  importStatement: jest.fn(noContent),
  listTransactions: noContent,
  getTransactionById: jest.fn(noContent),
  match: jest.fn(noContent),
  unmatch: jest.fn(noContent),
  reconcile: jest.fn(noContent),
  summary: jest.fn(noContent),
} as FinanceController;

const authenticate: RequestHandler = (_request, _response, next) => next();

const createApp = () =>
  express().use(express.json()).use('/finance', createFinanceRouter(controller, authenticate));

const id = '5ff875e1-4c1d-4e45-9c8a-fceb5fb5d836';
const orderId = 'd2d0a3a1-0f9a-4c8e-8f0a-1f7f8ba2c111';

describe('finance router', () => {
  it('imports at POST /statements/import without treating it as a statement id', async () => {
    const app = createApp();

    await request(app).post('/finance/statements/import').send({}).expect(204);
    await request(app).post('/finance/statements/import').expect(204);

    expect(controller.importStatement).toHaveBeenCalledTimes(2);
  });

  it('keeps the fixed segments out of the transaction id route', async () => {
    const app = createApp();

    await request(app).post('/finance/reconcile').expect(204);
    await request(app).get('/finance/summary').expect(204);
    // `reconcile` is not a uuid, so nothing may answer for it as one.
    await request(app).get('/finance/transactions/reconcile').expect(400);

    expect(controller.reconcile).toHaveBeenCalledTimes(1);
    expect(controller.summary).toHaveBeenCalledTimes(1);
    expect(controller.getTransactionById).not.toHaveBeenCalled();
  });

  it('matches and unmatches at the same address, by method', async () => {
    const app = createApp();

    await request(app)
      .post(`/finance/transactions/${id}/match`)
      .send({ version: 1, orderId })
      .expect(204);
    await request(app).delete(`/finance/transactions/${id}/match?version=1`).expect(204);

    expect(controller.match).toHaveBeenCalledTimes(1);
    expect(controller.unmatch).toHaveBeenCalledTimes(1);
  });

  it('refuses to undo a match without the version it was made at', async () => {
    await request(createApp()).delete(`/finance/transactions/${id}/match`).expect(400);
  });

  it('exposes no way to author a statement or a transaction', async () => {
    const app = createApp();

    // Nothing here is written in this system: a statement is imported and a
    // transaction arrives on one.
    await request(app).post('/finance/statements').send({}).expect(404);
    await request(app).post('/finance/transactions').send({}).expect(404);
  });
});
