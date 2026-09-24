import { describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import request from 'supertest';

import type { HelpdeskController } from './controller.js';
import { createHelpdeskRouter } from './router.js';

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
} as HelpdeskController;

const authenticate: RequestHandler = (_request, _response, next) => next();

describe('helpdesk router', () => {
  it('exposes status changes at POST /tickets/:id/transitions only', async () => {
    const app = express()
      .use(express.json())
      .use('/helpdesk', createHelpdeskRouter(controller, authenticate));
    const id = '5ff875e1-4c1d-4e45-9c8a-fceb5fb5d836';

    await request(app)
      .post(`/helpdesk/tickets/${id}/transitions`)
      .send({ version: 1, toStatus: 'OPEN' })
      .expect(204);
    await request(app)
      .post(`/helpdesk/tickets/${id}/status`)
      .send({ version: 1, toStatus: 'OPEN' })
      .expect(404);

    expect(controller.transition).toHaveBeenCalledTimes(1);
  });
});
