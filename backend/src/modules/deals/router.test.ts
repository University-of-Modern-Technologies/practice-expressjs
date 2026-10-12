import { describe, expect, it, jest } from '@jest/globals';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import request from 'supertest';

import type { RbacService } from '../rbac/service.js';
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

const authenticate: RequestHandler = (req, _response, next) => {
  req.auth = { userId: 'user-1' } as NonNullable<typeof req.auth>;
  next();
};

/** Holds every grant: what these tests check is routing, not permissions. */
const rbac = {
  getPermissionScope: jest.fn(async () => 'ALL' as const),
} as unknown as RbacService;

describe('deals router', () => {
  it('exposes stage changes at POST /:id/transitions only', async () => {
    const app = express()
      .use(express.json())
      .use('/deals', createDealsRouter(controller, authenticate, rbac));
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

describe('deals router permissions', () => {
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
      .use('/deals', createDealsRouter(controller, authenticate, denied))
      .use(refuse);

    const response = await request(app).post('/deals').send({ title: '' });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ code: 'FORBIDDEN' });
  });
});
