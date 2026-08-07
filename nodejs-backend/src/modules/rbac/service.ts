import { createNoopCacheService, type CacheService } from '../../cache/cache.service.js';
import { userPermissionsKey, userPermissionsPrefix } from '../../cache/keys.js';
import { AppError } from '../../common/errors/app-error.js';
import type { PrismaDatabase, PrismaTransaction } from '../../db/prisma.js';
import {
  createPermissionKey,
  parsePermissionKey,
  type CreateRoleData,
  type PermissionRecord,
  type PermissionScope,
  type ReplaceRolePermissionsData,
  type RoleDto,
} from './types.js';

interface RbacUserRecord {
  isActive: boolean;
  userRoles: Array<{
    role: { permissions: Array<{ scope: PermissionScope; permission: { key: string } }> };
  }>;
}

interface RoleRecord {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  permissions: Array<{ scope: PermissionScope; permission: { key: string } }>;
}

export interface RbacDatabase {
  readonly user: Pick<PrismaDatabase['user'], 'findUnique'>;
  readonly role: Pick<PrismaDatabase['role'], 'findMany'>;
  readonly $transaction: PrismaDatabase['$transaction'];
}

export interface RbacService {
  getPermissionScope(
    userId: string,
    resource: string,
    action: string,
  ): Promise<PermissionScope | null>;
}

// Implemented by the RBAC service and consumed by any module that mutates the
// roles of a user, so the cached permission set is dropped straight away.
export interface UserPermissionsInvalidator {
  invalidateUserPermissions(userId: string): Promise<void>;
}

export interface RbacAdminService extends RbacService, UserPermissionsInvalidator {
  invalidateAllUserPermissions(): Promise<void>;
  listRoles(): Promise<RoleDto[]>;
  createRole(data: CreateRoleData): Promise<RoleDto>;
  replaceRolePermissions(id: string, data: ReplaceRolePermissionsData): Promise<RoleDto>;
}

// Default for services constructed without RBAC wiring, for example in tests.
export const noopUserPermissionsInvalidator: UserPermissionsInvalidator = {
  async invalidateUserPermissions() {
    // Intentionally empty: nothing is cached.
  },
};

// Snapshot of everything authorization needs about a user, cached as one entry
// so a single Redis read answers every permission check for that user.
interface CachedUserPermissions {
  readonly isActive: boolean;
  readonly scopes: Readonly<Record<string, PermissionScope>>;
}

const DEFAULT_PERMISSIONS_TTL_SECONDS = 300;

const roleSelection = {
  id: true,
  name: true,
  description: true,
  createdAt: true,
  updatedAt: true,
  permissions: {
    orderBy: { permission: { key: 'asc' as const } },
    select: { scope: true, permission: { select: { key: true } } },
  },
};

const toRoleDto = (role: RoleRecord): RoleDto => ({
  id: role.id,
  name: role.name,
  description: role.description,
  permissions: role.permissions.map(({ scope, permission }) => {
    const parts = parsePermissionKey(permission.key);
    if (!parts) throw new Error(`Invalid permission key in database: ${permission.key}`);
    return { ...parts, scope };
  }),
  createdAt: role.createdAt,
  updatedAt: role.updatedAt,
});

const resolvePermissions = async (
  transaction: PrismaTransaction,
  permissions: PermissionRecord[],
): Promise<Map<string, string>> => {
  const keys = permissions.map(({ resource, action }) => createPermissionKey(resource, action));
  const records = await transaction.permission.findMany({
    where: { key: { in: keys } },
    select: { id: true, key: true },
  });
  const idsByKey = new Map(records.map(({ id, key }) => [key, id]));
  const unknownKeys = keys.filter((key) => !idsByKey.has(key));
  if (unknownKeys.length > 0) {
    throw new AppError('Unknown permission', 400, 'UNKNOWN_PERMISSION', {
      keys: unknownKeys,
    });
  }
  return idsByKey;
};

const permissionCreates = (
  permissions: PermissionRecord[],
  idsByKey: ReadonlyMap<string, string>,
) =>
  permissions.map(({ resource, action, scope }) => ({
    permissionId: idsByKey.get(createPermissionKey(resource, action)) as string,
    scope,
  }));

const mapPersistenceError = (error: unknown): never => {
  if (error instanceof AppError) throw error;
  if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
    throw new AppError('A role with this name already exists', 409, 'ROLE_ALREADY_EXISTS');
  }
  if (typeof error === 'object' && error && 'code' in error && error.code === 'P2025') {
    throw new AppError('Role not found', 404, 'ROLE_NOT_FOUND');
  }
  throw error;
};

// Loads the full permission set of a user in a single query. The whole set is
// resolved at once because it is cached as one entry.
const loadUserPermissions = async (
  db: RbacDatabase,
  userId: string,
): Promise<CachedUserPermissions> => {
  const user = (await db.user.findUnique({
    where: { id: userId },
    select: {
      isActive: true,
      userRoles: {
        select: {
          role: {
            select: {
              permissions: { select: { scope: true, permission: { select: { key: true } } } },
            },
          },
        },
      },
    },
  })) as RbacUserRecord | null;
  if (!user) return { isActive: false, scopes: {} };

  const scopes: Record<string, PermissionScope> = {};
  for (const { role } of user.userRoles) {
    for (const { scope, permission } of role.permissions) {
      // ALL wins when several roles grant the same permission with a narrower
      // scope, matching the previous per-permission resolution.
      if (scopes[permission.key] !== 'ALL') scopes[permission.key] = scope;
    }
  }
  return { isActive: user.isActive, scopes };
};

export const createRbacService = (
  db: RbacDatabase,
  cache: CacheService = createNoopCacheService(),
  permissionsTtlSeconds: number = DEFAULT_PERMISSIONS_TTL_SECONDS,
): RbacAdminService => ({
  async getPermissionScope(userId, resource, action) {
    const permissions = await cache.remember(
      userPermissionsKey(userId),
      permissionsTtlSeconds,
      async () => loadUserPermissions(db, userId),
    );
    if (!permissions.isActive) return null;
    return permissions.scopes[createPermissionKey(resource, action)] ?? null;
  },

  async invalidateUserPermissions(userId) {
    await cache.del(userPermissionsKey(userId));
  },

  async invalidateAllUserPermissions() {
    // Role permission changes affect every holder of that role, and the cache
    // does not track the reverse mapping, so the namespace is dropped.
    await cache.invalidatePrefix(userPermissionsPrefix());
  },

  async listRoles() {
    const roles = (await db.role.findMany({
      orderBy: { name: 'asc' },
      select: roleSelection,
    })) as RoleRecord[];
    return roles.map(toRoleDto);
  },

  async createRole(data) {
    try {
      return await db.$transaction(async (transaction) => {
        const idsByKey = await resolvePermissions(transaction, data.permissions);
        const creates = permissionCreates(data.permissions, idsByKey);
        const role = (await transaction.role.create({
          data: {
            name: data.name,
            description: data.description ?? null,
            ...(creates.length > 0 ? { permissions: { create: creates } } : {}),
          },
          select: roleSelection,
        })) as RoleRecord;
        return toRoleDto(role);
      });
    } catch (error) {
      return mapPersistenceError(error);
    }
  },

  async replaceRolePermissions(id, data) {
    try {
      const updated = await db.$transaction(async (transaction) => {
        const roleExists = await transaction.role.findUnique({
          where: { id },
          select: { id: true },
        });
        if (!roleExists) throw new AppError('Role not found', 404, 'ROLE_NOT_FOUND');

        const idsByKey = await resolvePermissions(transaction, data.permissions);
        const creates = permissionCreates(data.permissions, idsByKey);
        const role = (await transaction.role.update({
          where: { id },
          data: {
            permissions: {
              deleteMany: {},
              ...(creates.length > 0 ? { create: creates } : {}),
            },
          },
          select: roleSelection,
        })) as RoleRecord;
        return toRoleDto(role);
      });
      // Every user holding this role now has a stale permission set.
      await cache.invalidatePrefix(userPermissionsPrefix());
      return updated;
    } catch (error) {
      return mapPersistenceError(error);
    }
  },
});
