import type { Prisma, PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { AppError } from '../../common/errors/app-error.js';
import { createListReader, type ListReaderModel } from '../../common/query/list-reader.js';
import { createAuditService, type AuditService } from '../audit/service.js';
import {
  noopUserPermissionsInvalidator,
  type UserPermissionsInvalidator,
} from '../rbac/service.js';
import type { Actor } from '../rbac/types.js';
import {
  ADMIN_ROLE_NAME,
  CANNOT_DISABLE_SELF,
  LAST_ACTIVE_ADMIN,
  SESSION_ENTITY_TYPE,
  SESSION_REVOKED,
  USER_CREATED,
  USER_DISABLED,
  USER_ENTITY_TYPE,
  USER_UPDATED,
  type CreateUserData,
  type UpdateUserData,
  type UserDto,
  type UserListResult,
  type UserSessionDto,
} from './types.js';

interface UserRecord {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  userRoles: Array<{ role: { id: string; name: string } }>;
}

interface UserSessionRecord {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type UsersDatabase = PrismaClient;
type UsersTransaction = Prisma.TransactionClient;

/** The slice of the audit service user administration writes through. */
export type AuditRecorder = Pick<AuditService, 'record'>;

export interface UsersService {
  list(page: number, pageSize: number): Promise<UserListResult>;
  getById(id: string): Promise<UserDto>;
  listSessions(userId: string): Promise<UserSessionDto[]>;
  revokeSession(actor: Actor, userId: string, sessionId: string): Promise<void>;
  create(actor: Actor, data: CreateUserData): Promise<UserDto>;
  update(actor: Actor, id: string, data: UpdateUserData): Promise<UserDto>;
  disable(actor: Actor, id: string): Promise<UserDto>;
}

/** Work factor for password digests; the same in both backends. */
const BCRYPT_ROUNDS = 12;

const publicSelection = {
  id: true,
  email: true,
  name: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  userRoles: { select: { role: { select: { id: true, name: true } } } },
};

const sessionPublicSelection = {
  id: true,
  userId: true,
  expiresAt: true,
  revokedAt: true,
  ipAddress: true,
  userAgent: true,
  createdAt: true,
  updatedAt: true,
};

const toDto = (user: UserRecord): UserDto => ({
  id: user.id,
  email: user.email,
  name: user.name,
  isActive: user.isActive,
  roles: user.userRoles.map(({ role }) => role),
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

const toSessionDto = (session: UserSessionRecord): UserSessionDto => ({
  id: session.id,
  userId: session.userId,
  expiresAt: session.expiresAt,
  revokedAt: session.revokedAt,
  ipAddress: session.ipAddress,
  userAgent: session.userAgent,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
});

const userNotFound = (): AppError => new AppError('User not found', 404, 'USER_NOT_FOUND');

const mapPersistenceError = (error: unknown): never => {
  if (error instanceof AppError) throw error;
  const code = typeof error === 'object' && error && 'code' in error ? error.code : undefined;
  // Races against a concurrent writer: the checks inside the transaction
  // passed, and the constraint caught what changed after them.
  if (code === 'P2002') {
    throw new AppError('A user with this email already exists', 409, 'EMAIL_ALREADY_EXISTS');
  }
  if (code === 'P2003') {
    throw new AppError('User or role not found', 404, 'USER_OR_ROLE_NOT_FOUND');
  }
  if (code === 'P2025') throw userNotFound();
  throw error;
};

/** Identifiers are compared without regard to case, as the database does. */
const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/** Role ids without repeats: the same role named twice is assigned once. */
const uniqueIds = (ids: readonly string[]): string[] => [
  ...new Set(ids.map((id) => id.toLowerCase())),
];

const holdsAdminRole = (user: UserRecord): boolean =>
  user.userRoles.some(({ role }) => role.name === ADMIN_ROLE_NAME);

/**
 * The fields a patch sets, by their wire names, for the audit entry. Names
 * only: a password change leaves no trace in the snapshots, and its value has
 * no place in the trail.
 */
const changedFields = (data: UpdateUserData): string[] =>
  (['email', 'name', 'password', 'roleIds'] as const)
    .filter((field) => data[field] !== undefined)
    .sort();

const findUser = async (transaction: UsersTransaction, id: string): Promise<UserRecord> => {
  const user = await transaction.user.findUnique({ where: { id }, select: publicSelection });
  if (!user) throw userNotFound();
  return user;
};

const requireEmailAvailable = async (
  transaction: UsersTransaction,
  email: string,
  excludeId?: string,
): Promise<void> => {
  const taken = await transaction.user.findFirst({
    where: { email, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true },
  });
  if (taken) {
    throw new AppError('A user with this email already exists', 409, 'EMAIL_ALREADY_EXISTS');
  }
};

const requireRolesExist = async (
  transaction: UsersTransaction,
  roleIds: readonly string[],
): Promise<void> => {
  const found = await transaction.role.findMany({
    where: { id: { in: [...roleIds] } },
    select: { id: true },
  });
  if (found.length !== roleIds.length) {
    throw new AppError('User or role not found', 404, 'USER_OR_ROLE_NOT_FOUND');
  }
};

/**
 * Locks the admin role row for the rest of the transaction.
 *
 * Every change that could leave the role without an active holder takes this
 * lock first, so two administrators disabling each other at the same moment
 * are serialised instead of each seeing the other still active.
 */
const lockAdminRole = async (transaction: UsersTransaction): Promise<string | null> => {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM roles WHERE name = ${ADMIN_ROLE_NAME} FOR UPDATE
  `;
  return rows[0]?.id ?? null;
};

const requireAnotherActiveAdmin = async (
  transaction: UsersTransaction,
  adminRoleId: string,
  userId: string,
): Promise<void> => {
  const others = await transaction.userRole.count({
    where: { roleId: adminRoleId, userId: { not: userId }, user: { isActive: true } },
  });
  if (others === 0) {
    throw new AppError(
      'The last active administrator cannot be disabled or lose the admin role',
      409,
      LAST_ACTIVE_ADMIN,
    );
  }
};

/** Refuses a role change that takes the admin role from its last active holder. */
const guardAdminRoleRemoval = async (
  transaction: UsersTransaction,
  user: UserRecord,
  roleIds: readonly string[],
): Promise<void> => {
  if (!user.isActive || !holdsAdminRole(user)) return;
  const adminRoleId = await lockAdminRole(transaction);
  if (!adminRoleId || roleIds.some((roleId) => sameId(roleId, adminRoleId))) return;
  await requireAnotherActiveAdmin(transaction, adminRoleId, user.id);
};

const revokeAllSessions = async (transaction: UsersTransaction, userId: string): Promise<void> => {
  await transaction.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
};

export const createUsersService = (
  db: UsersDatabase,
  // Role and activation changes invalidate the cached permission set so that
  // authorization decisions never lag behind the database.
  permissions: UserPermissionsInvalidator = noopUserPermissionsInvalidator,
  // Every change is written to the trail inside its own transaction, so the
  // change and its entry commit, or roll back, as one.
  audit: AuditRecorder = createAuditService(db),
): UsersService => {
  // Prisma's generic `findMany` overload can't be structurally verified against
  // a plain interface once the select includes a nested relation (`userRoles`),
  // so the delegate is narrowed once here to the exact shape the reader needs.
  const readPage = createListReader({
    model: db.user as unknown as ListReaderModel<
      Prisma.UserWhereInput,
      unknown,
      typeof publicSelection,
      UserRecord
    >,
    select: publicSelection,
    toDto,
  });

  return {
    async list(page, pageSize) {
      return readPage({
        where: {},
        page,
        pageSize,
        orderBy: { createdAt: 'desc' },
      });
    },

    async getById(id) {
      const user = await db.user.findUnique({ where: { id }, select: publicSelection });
      if (!user) throw userNotFound();
      return toDto(user);
    },

    async listSessions(userId) {
      const user = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!user) throw userNotFound();

      const sessions = await db.session.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: sessionPublicSelection,
      });
      return sessions.map(toSessionDto);
    },

    async revokeSession(actor, userId, sessionId) {
      await db.$transaction(async (transaction: UsersTransaction) => {
        const user = await transaction.user.findUnique({
          where: { id: userId },
          select: { id: true },
        });
        if (!user) throw userNotFound();

        const session = await transaction.session.findFirst({
          where: { id: sessionId, userId },
          select: sessionPublicSelection,
        });
        if (!session) throw new AppError('Session not found', 404, 'SESSION_NOT_FOUND');
        // Revoking an already revoked session succeeds: the caller asked for a
        // state, and that state holds. Nothing changed, so nothing is audited.
        if (session.revokedAt) return;

        const { count } = await transaction.session.updateMany({
          where: { id: session.id, userId: session.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        if (count === 0) return;

        const revoked = await transaction.session.findUniqueOrThrow({
          where: { id: session.id },
          select: sessionPublicSelection,
        });
        await audit.record(transaction, {
          actorId: actor.actorId,
          action: SESSION_REVOKED,
          entityType: SESSION_ENTITY_TYPE,
          entityId: session.id,
          changes: { before: toSessionDto(session), after: toSessionDto(revoked) },
          metadata: { userId: session.userId },
          ipAddress: actor.ipAddress,
        });
      });
    },

    async create(actor, data) {
      const roleIds = uniqueIds(data.roleIds);
      // Hashed before the transaction opens, so no row lock waits on bcrypt.
      const passwordHash = await bcrypt.hash(data.password, BCRYPT_ROUNDS);
      try {
        const created = await db.$transaction(async (transaction: UsersTransaction) => {
          await requireEmailAvailable(transaction, data.email);
          await requireRolesExist(transaction, roleIds);
          const user = await transaction.user.create({
            data: {
              email: data.email,
              name: data.name,
              passwordHash,
              userRoles: { create: roleIds.map((roleId) => ({ roleId })) },
            },
            select: publicSelection,
          });
          const dto = toDto(user);
          await audit.record(transaction, {
            actorId: actor.actorId,
            action: USER_CREATED,
            entityType: USER_ENTITY_TYPE,
            entityId: user.id,
            changes: { after: dto },
            ipAddress: actor.ipAddress,
          });
          return dto;
        });
        await permissions.invalidateUserPermissions(created.id);
        return created;
      } catch (error) {
        return mapPersistenceError(error);
      }
    },

    async update(actor, id, data) {
      const roleIds = data.roleIds ? uniqueIds(data.roleIds) : undefined;
      const passwordHash = data.password
        ? await bcrypt.hash(data.password, BCRYPT_ROUNDS)
        : undefined;
      try {
        const updated = await db.$transaction(async (transaction: UsersTransaction) => {
          const existing = await findUser(transaction, id);
          if (data.email !== undefined) await requireEmailAvailable(transaction, data.email, id);
          if (roleIds) {
            await requireRolesExist(transaction, roleIds);
            await guardAdminRoleRemoval(transaction, existing, roleIds);
          }

          const user = await transaction.user.update({
            where: { id },
            data: {
              ...(data.email !== undefined ? { email: data.email } : {}),
              ...(data.name !== undefined ? { name: data.name } : {}),
              ...(passwordHash ? { passwordHash } : {}),
              ...(roleIds
                ? { userRoles: { deleteMany: {}, create: roleIds.map((roleId) => ({ roleId })) } }
                : {}),
            },
            select: publicSelection,
          });
          if (passwordHash) {
            // A session opened with the old password must not outlive it: the
            // change is often made precisely because that password leaked.
            await revokeAllSessions(transaction, id);
          }
          const after = toDto(user);
          await audit.record(transaction, {
            actorId: actor.actorId,
            action: USER_UPDATED,
            entityType: USER_ENTITY_TYPE,
            entityId: user.id,
            changes: { before: toDto(existing), after },
            metadata: { changedFields: changedFields(data) },
            ipAddress: actor.ipAddress,
          });
          return after;
        });
        await permissions.invalidateUserPermissions(updated.id);
        return updated;
      } catch (error) {
        return mapPersistenceError(error);
      }
    },

    async disable(actor, id) {
      try {
        const disabled = await db.$transaction(async (transaction: UsersTransaction) => {
          const existing = await findUser(transaction, id);
          // Either refusal would lock administrators out: nobody may disable
          // their own account, and the admin role keeps an active holder.
          if (sameId(existing.id, actor.actorId)) {
            throw new AppError('You cannot disable your own account', 409, CANNOT_DISABLE_SELF);
          }
          if (existing.isActive && holdsAdminRole(existing)) {
            const adminRoleId = await lockAdminRole(transaction);
            if (adminRoleId) {
              await requireAnotherActiveAdmin(transaction, adminRoleId, existing.id);
            }
          }

          const user = await transaction.user.update({
            where: { id: existing.id },
            data: { isActive: false },
            select: publicSelection,
          });
          // Leaving the sessions alive would let an already issued refresh
          // token keep minting access tokens for a disabled account.
          await revokeAllSessions(transaction, existing.id);
          const after = toDto(user);
          await audit.record(transaction, {
            actorId: actor.actorId,
            action: USER_DISABLED,
            entityType: USER_ENTITY_TYPE,
            entityId: user.id,
            changes: { before: toDto(existing), after },
            ipAddress: actor.ipAddress,
          });
          return after;
        });
        await permissions.invalidateUserPermissions(disabled.id);
        return disabled;
      } catch (error) {
        return mapPersistenceError(error);
      }
    },
  };
};
