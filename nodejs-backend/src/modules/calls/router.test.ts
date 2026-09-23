import { describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import request from 'supertest';

import type { CallsController } from './controller.js';
import { createCallsRouter } from './router.js';

const noContent: RequestHandler = (_request, response) => {
  response.status(204).end();
};

const controller = {
  list: noContent,
  getById: jest.fn(noContent),
  sync: jest.fn(noContent),
  update: noContent,
  link: jest.fn(noContent),
  getRecording: jest.fn(noContent),
  delete: noContent,
} as CallsController;

const authenticate: RequestHandler = (_request, _response, next) => next();

const createApp = () =>
  express().use(express.json()).use('/calls', createCallsRouter(controller, authenticate));

const id = '5ff875e1-4c1d-4e45-9c8a-fceb5fb5d836';

describe('calls router', () => {
  it('imports at POST /sync without treating it as a call id', async () => {
    const app = createApp();

    await request(app).post('/calls/sync').send({}).expect(204);
    // `sync` is not a uuid, so the single-call route must not answer for it.
    await request(app).get('/calls/sync').expect(400);

    expect(controller.sync).toHaveBeenCalledTimes(1);
    expect(controller.getById).not.toHaveBeenCalled();
  });

  it('accepts an import with no body at all', async () => {
    await request(createApp()).post('/calls/sync').expect(204);
  });

  it('separates the recording from the call it belongs to', async () => {
    const app = createApp();

    await request(app).get(`/calls/${id}/recording`).expect(204);
    await request(app).get(`/calls/${id}`).expect(204);

    expect(controller.getRecording).toHaveBeenCalledTimes(1);
    expect(controller.getById).toHaveBeenCalledTimes(1);
  });

  it('exposes linking at POST /:id/link only', async () => {
    const app = createApp();

    const body = { version: 1, contactId: 'd2d0a3a1-0f9a-4c8e-8f0a-1f7f8ba2c111' };
    await request(app).post(`/calls/${id}/link`).send(body).expect(204);
    await request(app).post(`/calls/${id}/links`).send(body).expect(404);

    expect(controller.link).toHaveBeenCalledTimes(1);
  });
});
