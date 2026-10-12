import { describe, expect, it, jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';
import { permissionGate, requirePermission } from './middleware.js';
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

// The gate splits the check around validation.
describe('permissionGate', () => {
  const gate = (scope: 'ALL' | 'OWN' | null) => {
    const service: RbacService = { getPermissionScope: jest.fn(async () => scope) };
    return permissionGate(service, {
      resource: 'users',
      action: 'read',
      ownerId: (req) => {
        const id = req.params.id;
        return typeof id === 'string' ? id : undefined;
      },
    });
  };

  it('refuses at the first half when the permission is held at no breadth', async () => {
    const next = jest.fn() as NextFunction;

    await expect(
      gate(null).held(request('user-1', 'user-1'), {} as Response, next),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(next).not.toHaveBeenCalled();
  });

  it('lets an OWN grant through the first half and applies it in the second', async () => {
    const { held, breadth } = gate('OWN');
    const req = request('user-1', 'user-2');
    const next = jest.fn() as NextFunction;

    await held(req, {} as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    await expect(breadth(req, {} as Response, next)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('admits an OWN grant on the record of the caller', async () => {
    const { held, breadth } = gate('OWN');
    const req = request('user-1', 'USER-1');
    const next = jest.fn() as NextFunction;

    await held(req, {} as Response, next);
    await breadth(req, {} as Response, next);

    expect(next).toHaveBeenCalledTimes(2);
  });

  it('refuses at the second half when the first one never ran', async () => {
    await expect(
      gate('ALL').breadth(request('user-1', 'user-1'), {} as Response, jest.fn() as NextFunction),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
