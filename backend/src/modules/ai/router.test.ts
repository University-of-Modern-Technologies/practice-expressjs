import { describe, expect, it, jest } from '@jest/globals';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import request from 'supertest';

import type { RbacService } from '../rbac/service.js';
import type { AiController } from './controller.js';
import { createAiRouter } from './router.js';
import { DEFAULT_AI_MAX_INPUT_CHARS } from './provider-factory.js';

const noContent: RequestHandler = (_request, response) => {
  response.status(204).end();
};

const controller = {
  summariseDeal: jest.fn(noContent),
  classifyInquiry: jest.fn(noContent),
} as AiController;

const authenticate: RequestHandler = (req, _response, next) => {
  req.auth = { userId: 'user-1' } as NonNullable<typeof req.auth>;
  next();
};

/** Holds every grant: what these tests check is routing, not permissions. */
const rbac = {
  getPermissionScope: jest.fn(async () => 'ALL' as const),
} as unknown as RbacService;

const app = express()
  .use(express.json())
  .use('/ai', createAiRouter(controller, authenticate, rbac))
  .use(((error: unknown, _request, response, _next) => {
    response.status(400).json({ code: (error as { code?: string }).code });
  }) as express.ErrorRequestHandler);

describe('ai router', () => {
  it('exposes both features at their documented paths', async () => {
    await request(app)
      .post('/ai/summaries/deal')
      .send({
        id: '5ff875e1-4c1d-4e45-9c8a-fceb5fb5d836',
        title: 'Warehouse automation',
        stage: 'PROPOSAL',
      })
      .expect(204);
    await request(app)
      .post('/ai/classify/inquiry')
      .send({ text: 'Where is my parcel?' })
      .expect(204);

    expect(controller.summariseDeal).toHaveBeenCalledTimes(1);
    expect(controller.classifyInquiry).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized inquiry text with 400 before the controller runs', async () => {
    const response = await request(app)
      .post('/ai/classify/inquiry')
      .send({ text: 'x'.repeat(DEFAULT_AI_MAX_INPUT_CHARS + 1) })
      .expect(400);

    expect(response.body).toEqual({ code: 'VALIDATION_ERROR' });
    expect(controller.classifyInquiry).not.toHaveBeenCalled();
  });
});

describe('ai router permissions', () => {
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
      .use('/ai', createAiRouter(controller, authenticate, denied))
      .use(refuse);

    const response = await request(app).post('/ai/classify/inquiry').send({ text: '' });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ code: 'FORBIDDEN' });
  });
});
