import { describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import request from 'supertest';

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

const authenticate: RequestHandler = (_request, _response, next) => next();

const app = express()
  .use(express.json())
  .use('/ai', createAiRouter(controller, authenticate))
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
