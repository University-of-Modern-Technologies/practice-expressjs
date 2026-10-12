import { describe, expect, it, jest } from '@jest/globals';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import request from 'supertest';

import type { RbacService } from '../rbac/service.js';
import type { ContactsController } from './controller.js';
import { createContactsRouter } from './router.js';
import { listContactsSchema, updateContactSchema } from './validation.js';

const noContent: RequestHandler = (_request, response) => {
  response.status(204).end();
};

const controller: ContactsController = {
  list: noContent,
  getById: noContent,
  create: jest.fn(noContent),
  update: noContent,
  delete: noContent,
};

const authenticate: RequestHandler = (req, _response, next) => {
  req.auth = { userId: 'user-1' } as NonNullable<typeof req.auth>;
  next();
};

const errors: ErrorRequestHandler = (
  error: { statusCode?: number; code?: string },
  _req,
  res,
  _next,
) => {
  res.status(error.statusCode ?? 500).json({ code: error.code });
};

const appWith = (scope: 'ALL' | 'OWN' | null) => {
  const rbac = { getPermissionScope: jest.fn(async () => scope) } as unknown as RbacService;
  return express()
    .use(express.json())
    .use('/contacts', createContactsRouter(controller, authenticate, rbac))
    .use(errors);
};

describe('contacts router', () => {
  it('refuses a caller without the grant before looking at the body', async () => {
    const response = await request(appWith(null)).post('/contacts').send({ firstName: '' });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ code: 'FORBIDDEN' });
    expect(controller.create).not.toHaveBeenCalled();
  });

  it('validates the body once the caller holds any breadth of the grant', async () => {
    const response = await request(appWith('OWN')).post('/contacts').send({ firstName: '' });

    expect(response.status).toBe(400);
  });
});

describe('contacts validation', () => {
  it('refuses an empty company on PATCH, as on create', () => {
    const params = { id: '5ff875e1-4c1d-4e45-9c8a-fceb5fb5d836' };

    expect(updateContactSchema.safeParse({ params, body: { company: '' } }).success).toBe(false);
    expect(updateContactSchema.safeParse({ params, body: { company: '   ' } }).success).toBe(false);
    expect(updateContactSchema.safeParse({ params, body: { company: null } }).success).toBe(true);
  });

  it('puts an upper bound on the page number', () => {
    expect(listContactsSchema.safeParse({ query: { page: '1000000' } }).success).toBe(true);
    expect(listContactsSchema.safeParse({ query: { page: '1000001' } }).success).toBe(false);
    expect(listContactsSchema.safeParse({ query: { page: '1e20' } }).success).toBe(false);
  });

  it('refuses a search made of whitespace only', () => {
    expect(listContactsSchema.safeParse({ query: { search: '   ' } }).success).toBe(false);
  });
});
