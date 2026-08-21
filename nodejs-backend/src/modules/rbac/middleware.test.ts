import { describe, expect, it, jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';
import { requirePermission } from './middleware.js';
import type { RbacService } from './service.js';

const request = (userId: string, ownerId: string): Request =>
  ({ auth: { userId, sessionId: 'session-1' }, params: { id: ownerId } }) as unknown as Request;

const run = async (scope: 'ALL' | 'OWN' | null, userId = 'user-1', ownerId = 'user-1') => {
  const getPermissionScope: RbacService['getPermissionScope'] = async () => scope;
  const service: RbacService = { getPermissionScope: jest.fn(getPermissionScope) };
  const next = jest.fn() as NextFunction;
  await requirePermission(service, {
    resource: 'contacts',
    action: 'update',
    ownerId: (req) => {
      const id = req.params.id;
      return typeof id === 'string' ? id : undefined;
    },
  })(request(userId, ownerId), {} as Response, next);
  return next;
};

describe('requirePermission', () => {
  it('allows ALL regardless of ownership', async () => {
    await expect(run('ALL', 'user-1', 'user-2')).resolves.toHaveBeenCalledTimes(1);
  });

  it('allows OWN for the matching owner', async () => {
    await expect(run('OWN')).resolves.toHaveBeenCalledTimes(1);
  });

  it('rejects OWN for another owner', async () => {
    await expect(run('OWN', 'user-1', 'user-2')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('denies when no permission matches', async () => {
    await expect(run(null)).rejects.toMatchObject({ statusCode: 403 });
  });
});
