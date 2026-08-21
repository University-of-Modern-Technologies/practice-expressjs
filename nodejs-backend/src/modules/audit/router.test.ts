import { describe, expect, it, jest } from '@jest/globals';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import request from 'supertest';

import { AppError } from '../../common/errors/index.js';
import type { RbacService } from '../rbac/service.js';
import { createAuditController } from './controller.js';
import { createAuditRouter } from './router.js';
import type { AuditService } from './service.js';
import type { AuditListResult, AuditRecordDto } from './types.js';

const actorId = '40d136cb-267d-4f80-bb0c-06db87ff28ba';
const resourceId = '5ff875e1-4c1d-4e45-9c8a-fceb5fb5d836';
const recordId = '9c5d2de8-f914-4da6-88d6-6073dfee34aa';
const createdAt = new Date('2026-08-05T12:00:00.000Z');
const record: AuditRecordDto = {
  id: recordId,
  actorId,
  action: 'update',
  entityType: 'contacts',
  entityId: resourceId,
  changes: null,
  metadata: null,
  ipAddress: null,
  createdAt,
};
const historyResult: AuditListResult = { items: [record], page: 2, pageSize: 10, total: 1 };

const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  if (error instanceof AppError) {
    response.status(error.statusCode).json({ error: { code: error.code } });
    return;
  }
  response.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR' } });
};

const createHarness = (
  authenticate: RequestHandler,
  permissionScope: 'ALL' | 'OWN' | null = 'ALL',
) => {
  const history = jest.fn<AuditService['history']>(async () => historyResult);
  const getById = jest.fn<AuditService['getById']>(async () => record);
  const service = {
    record: jest.fn(),
    list: jest.fn(),
    history,
    getById,
  } as unknown as AuditService;
  const getPermissionScope = jest.fn<RbacService['getPermissionScope']>(
    async () => permissionScope,
  );
  const rbac = { getPermissionScope } as RbacService;
  const controller = createAuditController(service, rbac);
  const app = express().use('/api/v1/audit', createAuditRouter(controller, authenticate));
  app.use(errorHandler);

  return { app, history, getById, getPermissionScope };
};

const authenticated: RequestHandler = (request, _response, next) => {
  request.auth = { userId: actorId, sessionId: 'session-1' };
  next();
};

describe('audit resource history route', () => {
  it('returns filtered history and enforces audit:read permission', async () => {
    const { app, history, getPermissionScope } = createHarness(authenticated);

    const response = await request(app)
      .get(`/api/v1/audit/%20contacts%20/${resourceId}`)
      .query({
        page: 2,
        pageSize: 10,
        action: ' update ',
        createdFrom: '2026-08-01T00:00:00.000Z',
        createdTo: '2026-08-31T23:59:59.000Z',
      })
      .expect(200);

    expect(getPermissionScope).toHaveBeenCalledWith(actorId, 'audit', 'read');
    expect(history).toHaveBeenCalledWith(actorId, 'ALL', 'contacts', resourceId, {
      page: 2,
      pageSize: 10,
      action: 'update',
      createdFrom: new Date('2026-08-01T00:00:00.000Z'),
      createdTo: new Date('2026-08-31T23:59:59.000Z'),
    });
    expect(response.body.data).toMatchObject({ page: 2, pageSize: 10, total: 1 });
  });

  it('requires authentication before checking permission or loading history', async () => {
    const { app, history, getPermissionScope } = createHarness((_request, _response, next) =>
      next(),
    );

    await request(app).get(`/api/v1/audit/contacts/${resourceId}`).expect(401);

    expect(getPermissionScope).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
  });

  it('denies resource history without audit:read permission', async () => {
    const { app, history, getPermissionScope } = createHarness(authenticated, null);

    await request(app).get(`/api/v1/audit/contacts/${resourceId}`).expect(403);

    expect(getPermissionScope).toHaveBeenCalledWith(actorId, 'audit', 'read');
    expect(history).not.toHaveBeenCalled();
  });

  it('rejects invalid resource history parameters', async () => {
    const { app, history } = createHarness(authenticated);
    const longResource = 'a'.repeat(65);

    await request(app).get(`/api/v1/audit/${longResource}/${resourceId}`).expect(400);
    await request(app).get('/api/v1/audit/contacts/not-a-uuid').expect(400);

    expect(history).not.toHaveBeenCalled();
  });

  it('preserves GET /:id routing', async () => {
    const { app, history, getById } = createHarness(authenticated);

    await request(app).get(`/api/v1/audit/${recordId}`).expect(200);

    expect(getById).toHaveBeenCalledWith(actorId, 'ALL', recordId);
    expect(history).not.toHaveBeenCalled();
  });
});
