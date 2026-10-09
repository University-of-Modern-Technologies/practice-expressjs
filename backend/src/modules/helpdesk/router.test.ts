import { describe, expect, it, jest } from '@jest/globals';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import request from 'supertest';

import type { RbacService } from '../rbac/service.js';
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

const authenticate: RequestHandler = (req, _response, next) => {
  req.auth = { userId: 'user-1' } as NonNullable<typeof req.auth>;
  next();
};

/** Holds every grant: what these tests check is routing, not permissions. */
const rbac = {
  getPermissionScope: jest.fn(async () => 'ALL' as const),
} as unknown as RbacService;

describe('helpdesk router', () => {
  it('exposes status changes at POST /tickets/:id/transitions only', async () => {
    const app = express()
      .use(express.json())
      .use('/helpdesk', createHelpdeskRouter(controller, authenticate, rbac));
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

describe('helpdesk router permissions', () => {
  const refuse: ErrorRequestHandler = (
    error: { statusCode?: number; code?: string },
    _req,
    res,
    _next,
  ) => {
    res.status(error.statusCode ?? 500).json({ code: error.code });
  };

  it('refuses a caller without the grant before validating what they sent', async () => {
    const denied = { getPermissionScope: jest.fn(async () => null) } as unknown as RbacService;
    const app = express()
      .use(express.json())
      .use('/helpdesk', createHelpdeskRouter(controller, authenticate, denied))
      .use(refuse);

    const response = await request(app).post('/helpdesk/tickets').send({ subject: '' });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ code: 'FORBIDDEN' });
  });
});
