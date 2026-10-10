import { describe, expect, it, jest } from '@jest/globals';
import bcrypt from 'bcryptjs';

import type { AuditEvent } from '../audit/types.js';
import type { SessionRevocationListener } from '../auth/types.js';
import type { Actor } from '../rbac/types.js';
import { createUsersService, type AuditRecorder, type UsersDatabase } from './service.js';

const actor: Actor = { actorId: 'actor-1', ipAddress: '203.0.113.7' };
const adminRoleId = 'role-admin';

const userRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'user-1',
  email: 'user@example.com',
  name: 'User',
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
  userRoles: [{ role: { id: 'role-1', name: 'agent' } }],
  ...overrides,
});

const adminRecord = () => userRecord({ userRoles: [{ role: { id: adminRoleId, name: 'admin' } }] });

const sessionRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'session-1',
  userId: 'user-1',
  expiresAt: new Date('2026-02-01T00:00:00Z'),
  revokedAt: null as Date | null,
  ipAddress: '127.0.0.1',
  userAgent: 'test-agent',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

interface HarnessOptions {
  readonly existing?: ReturnType<typeof userRecord> | null;
  readonly emailTaken?: boolean;
  readonly knownRoleIds?: readonly string[];
  readonly otherActiveAdmins?: number;
  readonly session?: ReturnType<typeof sessionRecord> | null;
}

/** A database whose transaction client is one recorded object. */
const createHarness = ({
  existing = userRecord(),
  emailTaken = false,
  knownRoleIds,
  otherActiveAdmins = 1,
  session = sessionRecord(),
}: HarnessOptions = {}) => {
  const transaction = {
    user: {
      findUnique: jest.fn(async (_args: unknown) => existing),
      findFirst: jest.fn(async (_args: unknown) => (emailTaken ? { id: 'someone-else' } : null)),
      create: jest.fn(async (_args: unknown) => userRecord()),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => ({
        ...(existing ?? userRecord()),
        ...(args.data.isActive === false ? { isActive: false } : {}),
        ...(typeof args.data.name === 'string' ? { name: args.data.name } : {}),
      })),
    },
    role: {
      findMany: jest.fn(async (args: { where: { id: { in: string[] } } }) =>
        args.where.id.in
          .filter((id) => knownRoleIds === undefined || knownRoleIds.includes(id))
          .map((id) => ({ id })),
      ),
    },
    session: {
      findFirst: jest.fn(async (_args: unknown) => session),
      findUniqueOrThrow: jest.fn(async (_args: unknown) => ({
        ...(session ?? sessionRecord()),
        revokedAt: new Date('2026-01-03T00:00:00Z'),
        updatedAt: new Date('2026-01-03T00:00:00Z'),
      })),
      updateMany: jest.fn(async (_args: unknown) => ({ count: 1 })),
    },
    userRole: { count: jest.fn(async (_args: unknown) => otherActiveAdmins) },
    $queryRaw: jest.fn(async (..._args: unknown[]) => [{ id: adminRoleId }]),
  };
  const events: AuditEvent[] = [];
  const audit: AuditRecorder = {
    record: jest.fn(async (client: unknown, event: AuditEvent) => {
      // The entry goes into the same transaction as the change it describes.
      expect(client).toBe(transaction);
      events.push(event);
      return {} as Awaited<ReturnType<AuditRecorder['record']>>;
    }),
  };
  const permissions = { invalidateUserPermissions: jest.fn(async (_userId: string) => undefined) };
  let committed = false;
  /** Every notice, with whether the transaction behind it had committed by then. */
  const notices: Array<{ readonly ended: string; readonly committed: boolean }> = [];
  const sessions: SessionRevocationListener = {
    sessionsRevoked: (sessionIds) => {
      for (const sessionId of sessionIds)
        notices.push({ ended: `session:${sessionId}`, committed });
    },
    userSessionsRevoked: (userId) => {
      notices.push({ ended: `user:${userId}`, committed });
    },
  };
  const db = {
    user: { findUnique: transaction.user.findUnique },
    session: { findMany: jest.fn(async () => [session]) },
    $transaction: jest.fn(async (callback: (client: typeof transaction) => Promise<unknown>) => {
      const result = await callback(transaction);
      committed = true;
      return result;
    }),
  } as unknown as UsersDatabase;

  return {
    service: createUsersService(db, permissions, audit, sessions),
    transaction,
    events,
    permissions,
    notices,
  };
};

describe('users service', () => {
  it('disables a user and revokes active sessions in one transaction', async () => {
    const { service, transaction } = createHarness();

    const result = await service.disable(actor, 'user-1');

    expect(result).toMatchObject({ id: 'user-1', isActive: false });
    expect(transaction.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user-1' }, data: { isActive: false } }),
    );
    expect(transaction.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1', revokedAt: null } }),
    );
  });

  it('lists only public session fields for an existing user', async () => {
    const session = { ...sessionRecord(), tokenHash: 'must-not-leak' };
    const findSessions = jest.fn(async (_args: unknown) => [session]);
    const db = {
      user: { findUnique: jest.fn(async () => ({ id: 'user-1' })) },
      session: { findMany: findSessions },
    } as unknown as UsersDatabase;

    const result = await createUsersService(db).listSessions('user-1');

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
});

describe('users service session revocation', () => {
  it('returns USER_NOT_FOUND without touching sessions for a missing user', async () => {
    const { service, transaction } = createHarness({ existing: null });

    await expect(service.revokeSession(actor, 'missing-user', 'session-1')).rejects.toMatchObject({
      statusCode: 404,
      code: 'USER_NOT_FOUND',
    });
    expect(transaction.session.findFirst).not.toHaveBeenCalled();
    expect(transaction.session.updateMany).not.toHaveBeenCalled();
  });

  it('revokes only the session belonging to the nested user', async () => {
    const { service, transaction } = createHarness();

    await expect(service.revokeSession(actor, 'user-1', 'session-1')).resolves.toBeUndefined();
    expect(transaction.session.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'session-1', userId: 'user-1' } }),
    );
    expect(transaction.session.updateMany).toHaveBeenCalledWith({
      where: { id: 'session-1', userId: 'user-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('treats an already revoked session as revoked and records nothing', async () => {
    const { service, transaction, events } = createHarness({
      session: sessionRecord({ revokedAt: new Date('2026-01-02T00:00:00Z') }),
    });

    await expect(service.revokeSession(actor, 'user-1', 'session-1')).resolves.toBeUndefined();
    expect(transaction.session.updateMany).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('returns SESSION_NOT_FOUND when the session is absent or belongs to another user', async () => {
    const { service } = createHarness({ session: null });

    await expect(service.revokeSession(actor, 'user-1', 'other-session')).rejects.toMatchObject({
      statusCode: 404,
      code: 'SESSION_NOT_FOUND',
    });
  });
});

// Role ids are checked before they are written, and repeats collapse.
describe('users service role assignment', () => {
  it('answers 404 USER_OR_ROLE_NOT_FOUND for an unknown role on create', async () => {
    const { service, transaction } = createHarness({ knownRoleIds: [] });

    await expect(
      service.create(actor, {
        email: 'new@example.com',
        name: 'New',
        password: 'password-1234',
        roleIds: ['role-404'],
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'USER_OR_ROLE_NOT_FOUND' });
    expect(transaction.user.create).not.toHaveBeenCalled();
  });

  it('answers 404 USER_OR_ROLE_NOT_FOUND for an unknown role on update', async () => {
    const { service, transaction } = createHarness({ knownRoleIds: ['role-1'] });

    await expect(
      service.update(actor, 'user-1', { roleIds: ['role-1', 'role-404'] }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'USER_OR_ROLE_NOT_FOUND' });
    expect(transaction.user.update).not.toHaveBeenCalled();
  });

  it('assigns a repeated role once', async () => {
    const { service, transaction } = createHarness();

    await service.create(actor, {
      email: 'new@example.com',
      name: 'New',
      password: 'password-1234',
      roleIds: ['role-1', 'ROLE-1', 'role-1'],
    });

    expect(transaction.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userRoles: { create: [{ roleId: 'role-1' }] } }),
      }),
    );
  });

  it('reports a taken address before looking at the roles', async () => {
    const { service, transaction } = createHarness({ emailTaken: true, knownRoleIds: [] });

    await expect(
      service.create(actor, {
        email: 'taken@example.com',
        name: 'New',
        password: 'password-1234',
        roleIds: ['role-404'],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'EMAIL_ALREADY_EXISTS' });
    expect(transaction.role.findMany).not.toHaveBeenCalled();
  });

  it('answers USER_NOT_FOUND for an update of a missing user', async () => {
    const { service } = createHarness({ existing: null });

    await expect(service.update(actor, 'missing', { name: 'x' })).rejects.toMatchObject({
      statusCode: 404,
      code: 'USER_NOT_FOUND',
    });
  });
});

// A new password ends every session opened with the old one.
describe('users service password change', () => {
  it('stores only a digest and revokes the live sessions of that user', async () => {
    const { service, transaction } = createHarness();

    await service.update(actor, 'user-1', { password: 'new-password-1' });

    const [args] = transaction.user.update.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(args.data).not.toHaveProperty('password');
    await expect(bcrypt.compare('new-password-1', args.data.passwordHash as string)).resolves.toBe(
      true,
    );
    expect(transaction.session.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('keeps the sessions when the password is not changed', async () => {
    const { service, transaction } = createHarness();

    await service.update(actor, 'user-1', { name: 'Renamed' });

    expect(transaction.session.updateMany).not.toHaveBeenCalled();
  });
});

// An administrator cannot lock administrators out.
describe('users service administrator safeguards', () => {
  it('refuses to disable your own account', async () => {
    const { service, transaction } = createHarness();

    await expect(
      service.disable({ actorId: 'USER-1', ipAddress: null }, 'user-1'),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CANNOT_DISABLE_SELF' });
    expect(transaction.user.update).not.toHaveBeenCalled();
  });

  it('refuses to disable the last active admin, under a lock on the admin role', async () => {
    const { service, transaction } = createHarness({
      existing: adminRecord(),
      otherActiveAdmins: 0,
    });

    await expect(service.disable(actor, 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'LAST_ACTIVE_ADMIN',
    });
    const [strings] = transaction.$queryRaw.mock.calls[0] as [TemplateStringsArray];
    expect(strings.join('?')).toContain('FOR UPDATE');
    expect(transaction.userRole.count).toHaveBeenCalledWith({
      where: { roleId: adminRoleId, userId: { not: 'user-1' }, user: { isActive: true } },
    });
    expect(transaction.user.update).not.toHaveBeenCalled();
  });

  it('disables an admin while another one is active', async () => {
    const { service } = createHarness({ existing: adminRecord(), otherActiveAdmins: 1 });

    await expect(service.disable(actor, 'user-1')).resolves.toMatchObject({ isActive: false });
  });

  it('refuses to take the admin role from its last active holder', async () => {
    const { service, transaction } = createHarness({
      existing: adminRecord(),
      otherActiveAdmins: 0,
    });

    await expect(service.update(actor, 'user-1', { roleIds: ['role-1'] })).rejects.toMatchObject({
      statusCode: 409,
      code: 'LAST_ACTIVE_ADMIN',
    });
    expect(transaction.user.update).not.toHaveBeenCalled();
  });

  it('needs no other admin when the admin role is kept', async () => {
    const { service, transaction } = createHarness({
      existing: adminRecord(),
      otherActiveAdmins: 0,
    });

    await service.update(actor, 'user-1', { roleIds: [adminRoleId, 'role-1'] });

    expect(transaction.userRole.count).not.toHaveBeenCalled();
  });
});

// Every change to an account lands in the trail, attributed to the caller.
describe('users service audit', () => {
  it('records a created user', async () => {
    const { service, events } = createHarness();

    await service.create(actor, {
      email: 'user@example.com',
      name: 'User',
      password: 'password-1234',
      roleIds: ['role-1'],
    });

    expect(events).toEqual([
      expect.objectContaining({
        actorId: 'actor-1',
        ipAddress: '203.0.113.7',
        action: 'user.created',
        entityType: 'user',
        entityId: 'user-1',
        changes: { after: expect.objectContaining({ email: 'user@example.com' }) },
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain('password-1234');
  });

  it('records an update with the names of the changed fields', async () => {
    const { service, events } = createHarness();

    await service.update(actor, 'user-1', { password: 'new-password-1', name: 'Renamed' });

    expect(events).toEqual([
      expect.objectContaining({
        action: 'user.updated',
        entityId: 'user-1',
        changes: {
          before: expect.objectContaining({ name: 'User' }),
          after: expect.objectContaining({ name: 'Renamed' }),
        },
        metadata: { changedFields: ['name', 'password'] },
      }),
    ]);
  });

  it('records a disabled user', async () => {
    const { service, events } = createHarness();

    await service.disable(actor, 'user-1');

    expect(events).toEqual([
      expect.objectContaining({
        action: 'user.disabled',
        changes: {
          before: expect.objectContaining({ isActive: true }),
          after: expect.objectContaining({ isActive: false }),
        },
      }),
    ]);
  });

  it('records a revoked session without its token digest', async () => {
    const { service, events } = createHarness();

    await service.revokeSession(actor, 'user-1', 'session-1');

    expect(events).toEqual([
      expect.objectContaining({
        action: 'session.revoked',
        entityType: 'session',
        entityId: 'session-1',
        changes: {
          before: expect.objectContaining({ revokedAt: null }),
          after: expect.objectContaining({ revokedAt: expect.any(Date) }),
        },
        metadata: { userId: 'user-1' },
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain('tokenHash');
  });
});

describe('users service permission cache invalidation', () => {
  it('invalidates the cached permissions of a newly created user', async () => {
    const { service, permissions } = createHarness();

    await service.create(actor, {
      email: 'user@example.com',
      name: 'User',
      password: 'password-1234',
      roleIds: ['role-1'],
    });

    expect(permissions.invalidateUserPermissions).toHaveBeenCalledWith('user-1');
  });

  it('invalidates the cached permissions after a role change', async () => {
    const { service, permissions } = createHarness();

    await service.update(actor, 'user-1', { roleIds: ['role-2'] });

    expect(permissions.invalidateUserPermissions).toHaveBeenCalledWith('user-1');
  });

  it('invalidates the cached permissions when a user is disabled', async () => {
    const { service, permissions } = createHarness();

    await service.disable(actor, 'user-1');

    expect(permissions.invalidateUserPermissions).toHaveBeenCalledWith('user-1');
  });

  it('does not invalidate anything when the update fails', async () => {
    const { service, permissions } = createHarness({ existing: null });

    await expect(service.update(actor, 'user-1', { roleIds: ['role-2'] })).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
    });
    expect(permissions.invalidateUserPermissions).not.toHaveBeenCalled();
  });
});

// A socket opened with a session must not outlive it.
describe('users service tells realtime about sessions it ended', () => {
  it('names the revoked session, once the revocation has committed', async () => {
    const { service, notices } = createHarness();

    await service.revokeSession(actor, 'user-1', 'session-1');

    expect(notices).toEqual([{ ended: 'session:session-1', committed: true }]);
  });

  it('says nothing about a session that was already revoked', async () => {
    const { service, notices } = createHarness({
      session: sessionRecord({ revokedAt: new Date('2026-01-02T00:00:00Z') }),
    });

    await service.revokeSession(actor, 'user-1', 'session-1');

    expect(notices).toEqual([]);
  });

  it('ends every session of a disabled user, once the change has committed', async () => {
    const { service, notices } = createHarness();

    await service.disable(actor, 'user-1');

    expect(notices).toEqual([{ ended: 'user:user-1', committed: true }]);
  });

  it('ends every session of a user whose password changed', async () => {
    const { service, notices } = createHarness();

    await service.update(actor, 'user-1', { password: 'new-password-1' });

    expect(notices).toEqual([{ ended: 'user:user-1', committed: true }]);
  });

  it('ends nothing when the password is kept', async () => {
    const { service, notices } = createHarness();

    await service.update(actor, 'user-1', { name: 'Renamed' });

    expect(notices).toEqual([]);
  });

  it('ends nothing when the change is refused', async () => {
    const { service, notices } = createHarness({ existing: adminRecord(), otherActiveAdmins: 0 });

    await expect(service.disable(actor, 'user-1')).rejects.toMatchObject({ statusCode: 409 });

    expect(notices).toEqual([]);
  });
});
