import { describe, expect, it, jest } from '@jest/globals';
import type { RequestHandler } from 'express';
import pino from 'pino';
import request from 'supertest';

import { createApp } from '../../app/create-app.js';
import { AppError } from '../../common/errors/app-error.js';
import { createTestConfig } from '../../test/config.js';
import type { RbacService } from '../rbac/service.js';
import { createUsersController } from './controller.js';
import { createUsersRouter } from './router.js';
import type { UsersService } from './service.js';
import type { UserSessionDto } from './types.js';

const authUserId = '11111111-1111-4111-8111-111111111111';
const otherUserId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';

const config = createTestConfig({ corsOrigins: ['*'] });

const session: UserSessionDto = {
  id: sessionId,
  userId: authUserId,
  expiresAt: new Date('2026-02-01T00:00:00Z'),
  revokedAt: null,
  ipAddress: '127.0.0.1',
  userAgent: 'test-agent',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const authenticate: RequestHandler = (request, _response, next) => {
  if (request.header('authorization') !== 'Bearer test-token') {
    throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  }
  request.auth = { userId: authUserId, sessionId };
  next();
};

interface TestAppOptions {
  readonly scope?: 'ALL' | 'OWN' | null;
  readonly listSessions?: UsersService['listSessions'];
  readonly revokeSession?: UsersService['revokeSession'];
}

const createTestApp = ({
  scope = 'ALL',
  listSessions = async () => [session],
  revokeSession = async () => undefined,
}: TestAppOptions = {}) => {
  const getPermissionScope: RbacService['getPermissionScope'] = jest.fn(async () => scope);
  const rbacService: RbacService = { getPermissionScope };
  const usersService: UsersService = {
    list: async () => ({ items: [], page: 1, pageSize: 20, total: 0 }),
    getById: async () => {
      throw new Error('Not used');
    },
    listSessions,
    revokeSession,
    create: async () => {
      throw new Error('Not used');
    },
    update: async () => {
      throw new Error('Not used');
    },
    disable: async () => {
      throw new Error('Not used');
    },
  };
  const router = createUsersRouter(createUsersController(usersService), authenticate, rbacService);

  return {
    app: createApp({
      config,
      logger: pino({ level: 'silent' }),
      routers: [{ path: '/api/v1/users', router }],
    }),
    getPermissionScope,
  };
};

const authorized = (testRequest: request.Test): request.Test =>
  testRequest.set('authorization', 'Bearer test-token');

describe('users session routes', () => {
  it('requires authentication', async () => {
    const listSessions = jest.fn<UsersService['listSessions']>(async () => [session]);
    const { app, getPermissionScope } = createTestApp({ listSessions });

    const response = await request(app).get(`/api/v1/users/${authUserId}/sessions`);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(getPermissionScope).not.toHaveBeenCalled();
    expect(listSessions).not.toHaveBeenCalled();
  });

  it('lists sessions with users:read OWN permission for the nested user id', async () => {
    const listSessions = jest.fn<UsersService['listSessions']>(async () => [session]);
    const { app, getPermissionScope } = createTestApp({ scope: 'OWN', listSessions });

    const response = await authorized(request(app).get(`/api/v1/users/${authUserId}/sessions`));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: [
        {
          ...session,
          expiresAt: session.expiresAt.toISOString(),
          createdAt: session.createdAt.toISOString(),
          updatedAt: session.updatedAt.toISOString(),
        },
      ],
    });
    expect(getPermissionScope).toHaveBeenCalledWith(authUserId, 'users', 'read');
    expect(listSessions).toHaveBeenCalledWith(authUserId);
  });

  it('rejects users:read OWN permission for another nested user id', async () => {
    const listSessions = jest.fn<UsersService['listSessions']>(async () => [session]);
    const { app } = createTestApp({ scope: 'OWN', listSessions });

    const response = await authorized(request(app).get(`/api/v1/users/${otherUserId}/sessions`));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(listSessions).not.toHaveBeenCalled();
  });

  it('revokes a session with users:update OWN permission and returns 204', async () => {
    const revokeSession = jest.fn<UsersService['revokeSession']>(async () => undefined);
    const { app, getPermissionScope } = createTestApp({ scope: 'OWN', revokeSession });

    const response = await authorized(
      request(app).delete(`/api/v1/users/${authUserId}/sessions/${sessionId}`),
    );

    expect(response.status).toBe(204);
    expect(response.body).toEqual({});
    expect(getPermissionScope).toHaveBeenCalledWith(authUserId, 'users', 'update');
    expect(revokeSession).toHaveBeenCalledWith(authUserId, sessionId);
  });

  it('validates both nested UUID path parameters before authorization', async () => {
    const revokeSession = jest.fn<UsersService['revokeSession']>(async () => undefined);
    const { app, getPermissionScope } = createTestApp({ revokeSession });

    const response = await authorized(
      request(app).delete(`/api/v1/users/${authUserId}/sessions/not-a-uuid`),
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(getPermissionScope).not.toHaveBeenCalled();
    expect(revokeSession).not.toHaveBeenCalled();
  });

  it('returns service 404 errors through the standard error envelope', async () => {
    const revokeSession = jest.fn<UsersService['revokeSession']>(async () => {
      throw new AppError('Session not found', 404, 'SESSION_NOT_FOUND');
    });
    const { app } = createTestApp({ revokeSession });

    const response = await authorized(
      request(app).delete(`/api/v1/users/${authUserId}/sessions/${sessionId}`),
    );

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('SESSION_NOT_FOUND');
  });
});
