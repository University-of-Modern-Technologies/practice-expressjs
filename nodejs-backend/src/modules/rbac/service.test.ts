import { describe, expect, it, jest } from '@jest/globals';

import type { CacheService } from '../../cache/cache.service.js';
import { createRbacService, type RbacDatabase } from './service.js';

interface RecordingCache extends CacheService {
  readonly store: Map<string, unknown>;
  readonly deleted: string[];
  readonly invalidatedPrefixes: string[];
}

// In-memory stand-in that records the calls the RBAC service makes.
const createRecordingCache = (): RecordingCache => {
  const store = new Map<string, unknown>();
  const deleted: string[] = [];
  const invalidatedPrefixes: string[] = [];

  const cache: RecordingCache = {
    store,
    deleted,
    invalidatedPrefixes,
    async get<T>(key: string) {
      return store.has(key) ? (store.get(key) as T) : null;
    },
    async set<T>(key: string, value: T) {
      store.set(key, value);
    },
    async remember<T>(key: string, _ttlSeconds: number, loader: () => Promise<T>) {
      const cached = await cache.get<T>(key);
      if (cached !== null) return cached;
      const value = await loader();
      await cache.set(key, value);
      return value;
    },
    async del(keys: string | readonly string[]) {
      for (const key of typeof keys === 'string' ? [keys] : keys) {
        deleted.push(key);
        store.delete(key);
      }
    },
    async invalidatePrefix(prefix: string) {
      invalidatedPrefixes.push(prefix);
      for (const key of [...store.keys()]) {
        if (key.startsWith(prefix)) store.delete(key);
      }
    },
  };

  return cache;
};

const databaseWithScopes = (scopes: Array<'ALL' | 'OWN'>): RbacDatabase =>
  ({
    user: {
      findUnique: jest.fn(async () => ({
        isActive: true,
        userRoles: [
          {
            role: {
              permissions: scopes.map((scope) => ({
                scope,
                permission: { key: 'contacts:read' },
              })),
            },
          },
        ],
      })),
    },
  }) as unknown as RbacDatabase;

const roleRecord = {
  id: '40000000-0000-4000-8000-000000000001',
  name: 'support',
  description: 'Support team',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
  permissions: [
    {
      scope: 'ALL' as const,
      permission: { key: 'contacts:read' },
    },
  ],
};

const createTransactionDatabase = (transaction: object): RbacDatabase =>
  ({
    user: { findUnique: jest.fn() },
    role: { findMany: jest.fn() },
    $transaction: jest.fn(async (callback: (value: object) => Promise<unknown>) =>
      callback(transaction),
    ),
  }) as unknown as RbacDatabase;

describe('rbac service', () => {
  it('prefers ALL when both scopes are granted', async () => {
    await expect(
      createRbacService(databaseWithScopes(['OWN', 'ALL'])).getPermissionScope(
        'user-1',
        'contacts',
        'read',
      ),
    ).resolves.toBe('ALL');
  });

  it('returns OWN when it is the only matching scope', async () => {
    await expect(
      createRbacService(databaseWithScopes(['OWN'])).getPermissionScope(
        'user-1',
        'contacts',
        'read',
      ),
    ).resolves.toBe('OWN');
  });

  it('denies inactive users', async () => {
    const db = {
      user: {
        findUnique: jest.fn(async () => ({
          isActive: false,
          userRoles: [],
        })),
      },
    } as unknown as RbacDatabase;
    await expect(
      createRbacService(db).getPermissionScope('user-1', 'contacts', 'read'),
    ).resolves.toBeNull();
  });

  it('lists roles with parsed permission keys', async () => {
    const findMany = jest.fn(async (_args: unknown) => [roleRecord]);
    const db = {
      user: { findUnique: jest.fn() },
      role: { findMany },
      $transaction: jest.fn(),
    } as unknown as RbacDatabase;

    await expect(createRbacService(db).listRoles()).resolves.toEqual([
      {
        id: roleRecord.id,
        name: roleRecord.name,
        description: roleRecord.description,
        permissions: [{ resource: 'contacts', action: 'read', scope: 'ALL' }],
        createdAt: roleRecord.createdAt,
        updatedAt: roleRecord.updatedAt,
      },
    ]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { name: 'asc' } }));
  });

  it('creates a role and its permissions in one transaction', async () => {
    const findPermissions = jest.fn(async () => [{ id: 'permission-1', key: 'contacts:read' }]);
    const createRole = jest.fn(async (_args: unknown) => roleRecord);
    const db = createTransactionDatabase({
      permission: { findMany: findPermissions },
      role: { create: createRole },
    });

    const result = await createRbacService(db).createRole({
      name: 'support',
      description: 'Support team',
      permissions: [{ resource: 'contacts', action: 'read', scope: 'ALL' }],
    });

    expect(result.permissions).toEqual([{ resource: 'contacts', action: 'read', scope: 'ALL' }]);
    expect(createRole).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'support',
          permissions: {
            create: [{ permissionId: 'permission-1', scope: 'ALL' }],
          },
        }),
      }),
    );
  });

  it('rejects unknown permissions before creating a role', async () => {
    const createRole = jest.fn();
    const db = createTransactionDatabase({
      permission: { findMany: jest.fn(async () => []) },
      role: { create: createRole },
    });

    await expect(
      createRbacService(db).createRole({
        name: 'support',
        permissions: [{ resource: 'unknown', action: 'read', scope: 'ALL' }],
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'UNKNOWN_PERMISSION' });
    expect(createRole).not.toHaveBeenCalled();
  });

  it('maps a duplicate role name to conflict', async () => {
    const db = createTransactionDatabase({
      permission: { findMany: jest.fn(async () => []) },
      role: {
        create: jest.fn(async () => {
          throw { code: 'P2002' };
        }),
      },
    });

    await expect(
      createRbacService(db).createRole({ name: 'support', permissions: [] }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ROLE_ALREADY_EXISTS' });
  });

  it('replaces all role permissions in one transaction', async () => {
    const updateRole = jest.fn(async (_args: unknown) => roleRecord);
    const db = createTransactionDatabase({
      permission: {
        findMany: jest.fn(async () => [{ id: 'permission-1', key: 'contacts:read' }]),
      },
      role: {
        findUnique: jest.fn(async () => ({ id: roleRecord.id })),
        update: updateRole,
      },
    });

    await createRbacService(db).replaceRolePermissions(roleRecord.id, {
      permissions: [{ resource: 'contacts', action: 'read', scope: 'ALL' }],
    });

    expect(updateRole).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: roleRecord.id },
        data: {
          permissions: {
            deleteMany: {},
            create: [{ permissionId: 'permission-1', scope: 'ALL' }],
          },
        },
      }),
    );
  });

  it('returns not found when replacing permissions for a missing role', async () => {
    const db = createTransactionDatabase({
      permission: { findMany: jest.fn() },
      role: { findUnique: jest.fn(async () => null), update: jest.fn() },
    });

    await expect(
      createRbacService(db).replaceRolePermissions(roleRecord.id, { permissions: [] }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'ROLE_NOT_FOUND' });
  });
});

describe('rbac permission caching', () => {
  it('reads the database once and serves further checks from the cache', async () => {
    const db = databaseWithScopes(['ALL']);
    const cache = createRecordingCache();
    const service = createRbacService(db, cache, 120);

    await expect(service.getPermissionScope('user-1', 'contacts', 'read')).resolves.toBe('ALL');
    await expect(service.getPermissionScope('user-1', 'contacts', 'read')).resolves.toBe('ALL');

    expect(db.user.findUnique).toHaveBeenCalledTimes(1);
    expect(cache.store.has('rbac:user-permissions:user-1')).toBe(true);
  });

  it('answers unrelated permissions from the same cached entry', async () => {
    const db = databaseWithScopes(['ALL']);
    const service = createRbacService(db, createRecordingCache(), 120);

    await expect(service.getPermissionScope('user-1', 'contacts', 'read')).resolves.toBe('ALL');
    await expect(service.getPermissionScope('user-1', 'deals', 'delete')).resolves.toBeNull();

    expect(db.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it('caches per user rather than globally', async () => {
    const db = databaseWithScopes(['OWN']);
    const service = createRbacService(db, createRecordingCache(), 120);

    await service.getPermissionScope('user-1', 'contacts', 'read');
    await service.getPermissionScope('user-2', 'contacts', 'read');

    expect(db.user.findUnique).toHaveBeenCalledTimes(2);
  });

  it('keeps working when the cache always misses', async () => {
    const db = databaseWithScopes(['ALL']);
    const service = createRbacService(db);

    await expect(service.getPermissionScope('user-1', 'contacts', 'read')).resolves.toBe('ALL');
    await expect(service.getPermissionScope('user-1', 'contacts', 'read')).resolves.toBe('ALL');
    expect(db.user.findUnique).toHaveBeenCalledTimes(2);
  });

  it('caches the denial for an unknown user', async () => {
    const db = {
      user: { findUnique: jest.fn(async () => null) },
    } as unknown as RbacDatabase;

    await expect(
      createRbacService(db, createRecordingCache()).getPermissionScope('ghost', 'contacts', 'read'),
    ).resolves.toBeNull();
  });

  it('drops the cached entry of a single user on invalidation', async () => {
    const db = databaseWithScopes(['ALL']);
    const cache = createRecordingCache();
    const service = createRbacService(db, cache, 120);

    await service.getPermissionScope('user-1', 'contacts', 'read');
    await service.invalidateUserPermissions('user-1');
    await service.getPermissionScope('user-1', 'contacts', 'read');

    expect(cache.deleted).toEqual(['rbac:user-permissions:user-1']);
    expect(db.user.findUnique).toHaveBeenCalledTimes(2);
  });

  it('drops every cached entry when the permissions of a role change', async () => {
    const cache = createRecordingCache();
    const db = createTransactionDatabase({
      permission: {
        findMany: jest.fn(async () => [{ id: 'permission-1', key: 'contacts:read' }]),
      },
      role: {
        findUnique: jest.fn(async () => ({ id: roleRecord.id })),
        update: jest.fn(async () => roleRecord),
      },
    });
    cache.store.set('rbac:user-permissions:user-1', { isActive: true, scopes: {} });

    await createRbacService(db, cache, 120).replaceRolePermissions(roleRecord.id, {
      permissions: [{ resource: 'contacts', action: 'read', scope: 'ALL' }],
    });

    expect(cache.invalidatedPrefixes).toEqual(['rbac:user-permissions:']);
    expect(cache.store.size).toBe(0);
  });

  it('leaves the cache untouched when the role update fails', async () => {
    const cache = createRecordingCache();
    const db = createTransactionDatabase({
      permission: { findMany: jest.fn() },
      role: { findUnique: jest.fn(async () => null), update: jest.fn() },
    });

    await expect(
      createRbacService(db, cache, 120).replaceRolePermissions(roleRecord.id, { permissions: [] }),
    ).rejects.toMatchObject({ code: 'ROLE_NOT_FOUND' });
    expect(cache.invalidatedPrefixes).toEqual([]);
  });

  it('exposes an explicit namespace-wide invalidation', async () => {
    const cache = createRecordingCache();
    await createRbacService(databaseWithScopes(['ALL']), cache, 120).invalidateAllUserPermissions();

    expect(cache.invalidatedPrefixes).toEqual(['rbac:user-permissions:']);
  });
});
