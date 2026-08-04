import { describe, expect, it, jest } from '@jest/globals';

import { createUsersService, type UsersDatabase } from './service.js';

const disabledUser = {
  id: 'user-1',
  email: 'user@example.com',
  name: 'User',
  isActive: false,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
  userRoles: [{ role: { id: 'role-1', name: 'agent' } }],
};

describe('users service', () => {
  it('disables a user and revokes active sessions in one transaction', async () => {
    const updateUser = jest.fn(async (_args: unknown) => disabledUser);
    const revokeSessions = jest.fn(async (_args: unknown) => ({ count: 2 }));
    const db = {
      user: {
        update: updateUser,
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        count: jest.fn(),
      },
      session: { updateMany: revokeSessions },
      $transaction: jest.fn(
        async (
          callback: (transaction: {
            user: { update: typeof updateUser };
            session: { updateMany: typeof revokeSessions };
          }) => Promise<unknown>,
        ) =>
          callback({
            user: { update: updateUser },
            session: { updateMany: revokeSessions },
          }),
      ),
    } as unknown as UsersDatabase;

    const result = await createUsersService(db).disable('user-1');

    expect(result).toEqual({
      id: disabledUser.id,
      email: disabledUser.email,
      name: disabledUser.name,
      isActive: false,
      roles: [{ id: 'role-1', name: 'agent' }],
      createdAt: disabledUser.createdAt,
      updatedAt: disabledUser.updatedAt,
    });
    expect(updateUser).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-1' },
        data: { isActive: false },
      }),
    );
    expect(revokeSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1', revokedAt: null },
      }),
    );
  });

  it('lists only public session fields for an existing user', async () => {
    const session = {
      id: 'session-1',
      userId: 'user-1',
      tokenHash: 'must-not-leak',
      expiresAt: new Date('2026-02-01T00:00:00Z'),
      revokedAt: null,
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    const findSessions = jest.fn(async (_args: unknown) => [session]);
    const db = {
      user: { findUnique: jest.fn(async () => ({ id: 'user-1' })) },
      session: { findMany: findSessions },
    } as unknown as UsersDatabase;

    const result = await createUsersService(db).listSessions('user-1');

    expect(result).toEqual([
      {
        id: session.id,
        userId: session.userId,
        expiresAt: session.expiresAt,
        revokedAt: session.revokedAt,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
    ]);
    expect(result[0]).not.toHaveProperty('tokenHash');
    expect(findSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
        select: expect.not.objectContaining({ tokenHash: true }),
      }),
    );
  });

  it('returns USER_NOT_FOUND when listing sessions for a missing user', async () => {
    const findSessions = jest.fn();
    const db = {
      user: { findUnique: jest.fn(async () => null) },
      session: { findMany: findSessions },
    } as unknown as UsersDatabase;

    await expect(createUsersService(db).listSessions('missing-user')).rejects.toMatchObject({
      statusCode: 404,
      code: 'USER_NOT_FOUND',
    });
    expect(findSessions).not.toHaveBeenCalled();
  });

  it('returns USER_NOT_FOUND without touching sessions when revoking for a missing user', async () => {
    const updateMany = jest.fn();
    const findFirst = jest.fn();
    const db = {
      user: { findUnique: jest.fn(async () => null) },
      session: { updateMany, findFirst },
    } as unknown as UsersDatabase;

    await expect(
      createUsersService(db).revokeSession('missing-user', 'session-1'),
    ).rejects.toMatchObject({ statusCode: 404, code: 'USER_NOT_FOUND' });
    expect(updateMany).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('revokes only the session belonging to the nested user', async () => {
    const updateMany = jest.fn(async (_args: unknown) => ({ count: 1 }));
    const db = {
      user: { findUnique: jest.fn(async () => ({ id: 'user-1' })) },
      session: { updateMany, findFirst: jest.fn() },
    } as unknown as UsersDatabase;

    await expect(
      createUsersService(db).revokeSession('user-1', 'session-1'),
    ).resolves.toBeUndefined();
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'session-1', userId: 'user-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('treats an already revoked matching session as successfully revoked', async () => {
    const findFirst = jest.fn(async (_args: unknown) => ({ id: 'session-1' }));
    const db = {
      user: { findUnique: jest.fn(async () => ({ id: 'user-1' })) },
      session: {
        updateMany: jest.fn(async () => ({ count: 0 })),
        findFirst,
      },
    } as unknown as UsersDatabase;

    await expect(
      createUsersService(db).revokeSession('user-1', 'session-1'),
    ).resolves.toBeUndefined();
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'session-1', userId: 'user-1' },
      select: { id: true },
    });
  });

  it('returns SESSION_NOT_FOUND when the session is absent or belongs to another user', async () => {
    const findFirst = jest.fn(async (_args: unknown) => null);
    const db = {
      user: { findUnique: jest.fn(async () => ({ id: 'user-1' })) },
      session: {
        updateMany: jest.fn(async () => ({ count: 0 })),
        findFirst,
      },
    } as unknown as UsersDatabase;

    await expect(
      createUsersService(db).revokeSession('user-1', 'other-session'),
    ).rejects.toMatchObject({ statusCode: 404, code: 'SESSION_NOT_FOUND' });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'other-session', userId: 'user-1' } }),
    );
  });
});

describe('users service permission cache invalidation', () => {
  const createInvalidator = (): {
    invalidateUserPermissions: jest.Mock<(userId: string) => Promise<void>>;
  } => ({ invalidateUserPermissions: jest.fn(async () => undefined) });

  it('invalidates the cached permissions of a newly created user', async () => {
    const db = {
      user: { create: jest.fn(async () => ({ ...disabledUser, isActive: true })) },
    } as unknown as UsersDatabase;
    const permissions = createInvalidator();

    await createUsersService(db, permissions).create({
      email: 'user@example.com',
      name: 'User',
      password: 'password-1234',
      roleIds: ['role-1'],
    });

    expect(permissions.invalidateUserPermissions).toHaveBeenCalledWith('user-1');
  });

  it('invalidates the cached permissions after a role change', async () => {
    const db = {
      user: { update: jest.fn(async () => disabledUser) },
    } as unknown as UsersDatabase;
    const permissions = createInvalidator();

    await createUsersService(db, permissions).update('user-1', { roleIds: ['role-2'] });

    expect(permissions.invalidateUserPermissions).toHaveBeenCalledWith('user-1');
  });

  it('invalidates the cached permissions when a user is disabled', async () => {
    const db = {
      user: { update: jest.fn(async () => disabledUser) },
      session: { updateMany: jest.fn(async () => ({ count: 0 })) },
      $transaction: jest.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
        callback({
          user: { update: jest.fn(async () => disabledUser) },
          session: { updateMany: jest.fn(async () => ({ count: 0 })) },
        }),
      ),
    } as unknown as UsersDatabase;
    const permissions = createInvalidator();

    await createUsersService(db, permissions).disable('user-1');

    expect(permissions.invalidateUserPermissions).toHaveBeenCalledWith('user-1');
  });

  it('does not invalidate anything when the update fails', async () => {
    const db = {
      user: {
        update: jest.fn(async () => {
          throw { code: 'P2025' };
        }),
      },
    } as unknown as UsersDatabase;
    const permissions = createInvalidator();

    await expect(
      createUsersService(db, permissions).update('user-1', { roleIds: ['role-2'] }),
    ).rejects.toMatchObject({ code: 'USER_OR_ROLE_NOT_FOUND' });
    expect(permissions.invalidateUserPermissions).not.toHaveBeenCalled();
  });
});
