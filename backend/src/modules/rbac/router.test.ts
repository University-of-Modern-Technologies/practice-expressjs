import { describe, expect, it, jest } from '@jest/globals';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import request from 'supertest';

import { AppError } from '../../common/errors/app-error.js';
import { createRbacController } from './controller.js';
import { createRbacRouter } from './router.js';
import type { RbacAdminService } from './service.js';
import type {
  Actor,
  CreateRoleData,
  PermissionScope,
  ReplaceRolePermissionsData,
} from './types.js';

const roleId = '40000000-0000-4000-8000-000000000001';
const role = {
  id: roleId,
  name: 'support',
  description: 'Support team',
  permissions: [{ resource: 'contacts', action: 'read', scope: 'ALL' as const }],
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
};

const actorId = '10000000-0000-4000-8000-000000000001';

const createHarness = (granted = true) => {
  const getPermissionScope = jest.fn(
    async (_userId: string, resource: string, action: string): Promise<PermissionScope | null> =>
      granted && resource === 'users' && ['read', 'create', 'update'].includes(action)
        ? 'ALL'
        : null,
  );
  const listRoles = jest.fn(async () => [role]);
  const createRole = jest.fn(async (_actor: Actor, _data: CreateRoleData) => role);
  const replaceRolePermissions = jest.fn(
    async (_actor: Actor, _id: string, _data: ReplaceRolePermissionsData) => role,
  );
  const invalidateUserPermissions = jest.fn(async (_userId: string) => undefined);
  const invalidateAllUserPermissions = jest.fn(async () => undefined);
  const service: RbacAdminService = {
    getPermissionScope,
    invalidateUserPermissions,
    invalidateAllUserPermissions,
    listRoles,
    createRole,
    replaceRolePermissions,
  };
  const authenticate: RequestHandler = (req, _response, next) => {
    req.auth = { userId: actorId, sessionId: 'session-1' };
    next();
  };
  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof AppError) {
      response
        .status(error.statusCode)
        .json({ error: { code: error.code, details: error.details } });
      return;
    }
    response.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR' } });
  };
  const app = express()
    .use(express.json())
    .use('/api/v1/rbac', createRbacRouter(createRbacController(service), authenticate, service))
    .use(errorHandler);

  return { app, getPermissionScope, listRoles, createRole, replaceRolePermissions };
};

describe('rbac role administration router', () => {
  it('lists roles with users:read and returns 200', async () => {
    const harness = createHarness();

    const response = await request(harness.app).get('/api/v1/rbac/roles').expect(200);

    expect(response.body.data[0]).toMatchObject({ id: roleId, name: 'support' });
    expect(harness.getPermissionScope).toHaveBeenCalledWith(
      '10000000-0000-4000-8000-000000000001',
      'users',
      'read',
    );
    expect(harness.listRoles).toHaveBeenCalledTimes(1);
  });

  it('creates a validated role with users:create and returns 201', async () => {
    const harness = createHarness();

    await request(harness.app)
      .post('/api/v1/rbac/roles')
      .send({
        name: ' support ',
        description: ' Support team ',
        permissions: [{ resource: 'contacts', action: 'read', scope: 'ALL' }],
      })
      .expect(201);

    expect(harness.getPermissionScope).toHaveBeenCalledWith(
      '10000000-0000-4000-8000-000000000001',
      'users',
      'create',
    );
    expect(harness.createRole).toHaveBeenCalledWith(expect.objectContaining({ actorId }), {
      name: 'support',
      description: 'Support team',
      permissions: [{ resource: 'contacts', action: 'read', scope: 'ALL' }],
    });
  });

  it('replaces permissions with users:update and returns 200', async () => {
    const harness = createHarness();

    await request(harness.app)
      .put(`/api/v1/rbac/roles/${roleId}/permissions`)
      .send({ permissions: [{ resource: 'contacts', action: 'read', scope: 'OWN' }] })
      .expect(200);

    expect(harness.getPermissionScope).toHaveBeenCalledWith(
      '10000000-0000-4000-8000-000000000001',
      'users',
      'update',
    );
    expect(harness.replaceRolePermissions).toHaveBeenCalledWith(
      expect.objectContaining({ actorId }),
      roleId,
      { permissions: [{ resource: 'contacts', action: 'read', scope: 'OWN' }] },
    );
  });

  it('rejects duplicate permission keys before calling the service', async () => {
    const harness = createHarness();

    const response = await request(harness.app)
      .post('/api/v1/rbac/roles')
      .send({
        name: 'support',
        permissions: [
          { resource: 'contacts', action: 'read', scope: 'ALL' },
          { resource: 'contacts', action: 'read', scope: 'OWN' },
        ],
      })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(harness.createRole).not.toHaveBeenCalled();
  });

  it('rejects invalid UUIDs and unknown body properties', async () => {
    const harness = createHarness();

    await request(harness.app)
      .put('/api/v1/rbac/roles/not-a-uuid/permissions')
      .send({ permissions: [], extra: true })
      .expect(400);

    expect(harness.replaceRolePermissions).not.toHaveBeenCalled();
  });

  it('preserves the permission check endpoint', async () => {
    const harness = createHarness();

    const response = await request(harness.app).get('/api/v1/rbac/check/contacts/read').expect(200);

    expect(response.body.data).toEqual({ allowed: false, scope: null });
  });

  // A caller without the permission learns nothing about the body.
  it('refuses a caller without the permission before validating the body', async () => {
    const harness = createHarness(false);

    const created = await request(harness.app)
      .post('/api/v1/rbac/roles')
      .send({ name: '', permissions: 'not-a-list' })
      .expect(403);
    const replaced = await request(harness.app)
      .put('/api/v1/rbac/roles/not-a-uuid/permissions')
      .send({ extra: true })
      .expect(403);

    expect(created.body.error.code).toBe('FORBIDDEN');
    expect(replaced.body.error.code).toBe('FORBIDDEN');
    expect(harness.createRole).not.toHaveBeenCalled();
    expect(harness.replaceRolePermissions).not.toHaveBeenCalled();
  });

  it('takes a permission named in the path as sent, without trimming it', async () => {
    const harness = createHarness();

    const response = await request(harness.app).get('/api/v1/rbac/check/%20contacts/read');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});
