import { describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import request from 'supertest';

import type { DealsController } from './controller.js';
import { createDealsRouter } from './router.js';

const noContent: RequestHandler = (_request, response) => {
  response.status(204).end();
};

const controller = {
  list: noContent,
  getById: noContent,
  create: noContent,
  update: noContent,
  transition: jest.fn(noContent),
  delete: noContent,
} as DealsController;

const authenticate: RequestHandler = (_request, _response, next) => next();

describe('deals router', () => {
  it('exposes stage changes at POST /:id/transitions only', async () => {
    const app = express()
      .use(express.json())
      .use('/deals', createDealsRouter(controller, authenticate));
    const id = '5ff875e1-4c1d-4e45-9c8a-fceb5fb5d836';

    await request(app)
      .post(`/deals/${id}/transitions`)
      .send({ version: 1, stage: 'QUALIFIED' })
      .expect(204);
    await request(app)
      .post(`/deals/${id}/stage`)
      .send({ version: 1, stage: 'QUALIFIED' })
      .expect(404);

    expect(controller.transition).toHaveBeenCalledTimes(1);
  });
});
