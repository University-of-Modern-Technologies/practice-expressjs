import { describe, expect, it } from '@jest/globals';
import { Router } from 'express';
import pino from 'pino';
import request from 'supertest';
import { z } from 'zod';

import { createApp } from '../../app/create-app.js';
import { createTestConfig } from '../../test/config.js';
import { validate } from './validate.js';

const schema = z.object({
  body: z.object({
    email: z.email({ message: 'Invalid email address' }),
    items: z.array(z.object({ quantity: z.number().int().min(1, { message: 'Too small' }) })),
  }),
  query: z.object({ dryRun: z.enum(['true', 'false'], { message: 'Invalid option' }).optional() }),
});

const router = Router();
router.post('/', validate(schema), (_request, response) => {
  response.status(204).end();
});

const app = createApp({
  config: createTestConfig(),
  logger: pino({ level: 'silent' }),
  routers: [{ path: '/api/v1/probe', router }],
});

describe('validate', () => {
  it('names the field of every refused value, grouped by the part of the request', async () => {
    const response = await request(app)
      .post('/api/v1/probe')
      .query({ dryRun: 'maybe' })
      .send({ email: 'not-an-email', items: [{ quantity: 2 }, { quantity: 0 }] });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
    });
    // The sibling backend's shape: the path inside the part leads the message,
    // which is what the client splits on to put the message on its input.
    expect(response.body.error.details).toEqual({
      formErrors: [],
      fieldErrors: {
        body: ['email: Invalid email address', 'items.1.quantity: Too small'],
        query: ['dryRun: Invalid option'],
      },
    });
  });

  it('keeps a message about a whole part unprefixed', async () => {
    const response = await request(app).post('/api/v1/probe').send([]);

    expect(response.status).toBe(400);
    const body = response.body.error.details.fieldErrors.body as string[];
    expect(body).toHaveLength(1);
    expect(body[0]).not.toMatch(/^[\w.]+: /);
  });
});
