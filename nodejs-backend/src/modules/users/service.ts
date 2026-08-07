import type { Prisma, PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { AppError } from '../../common/errors/app-error.js';
import { createListReader, type ListReaderModel } from '../../common/query/list-reader.js';
import {
  noopUserPermissionsInvalidator,
  type UserPermissionsInvalidator,
} from '../rbac/service.js';
import type {
  CreateUserData,
  UpdateUserData,
  UserDto,
  UserListResult,
  UserSessionDto,
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

export interface UsersService {
  list(page: number, pageSize: number): Promise<UserListResult>;
  getById(id: string): Promise<UserDto>;
  listSessions(userId: string): Promise<UserSessionDto[]>;
  revokeSession(userId: string, sessionId: string): Promise<void>;
  create(data: CreateUserData): Promise<UserDto>;
  update(id: string, data: UpdateUserData): Promise<UserDto>;
  disable(id: string): Promise<UserDto>;
}

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

const mapPersistenceError = (error: unknown): never => {
  if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
    throw new AppError('A user with this email already exists', 409, 'EMAIL_ALREADY_EXISTS');
  }
  if (typeof error === 'object' && error && 'code' in error && error.code === 'P2025') {
    throw new AppError('User or role not found', 404, 'USER_OR_ROLE_NOT_FOUND');
  }
  throw error;
};

export const createUsersService = (
  db: UsersDatabase,
  // Role and activation changes invalidate the cached permission set so that
  // authorization decisions never lag behind the database.
  permissions: UserPermissionsInvalidator = noopUserPermissionsInvalidator,
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
      if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');
      return toDto(user);
    },

    async listSessions(userId) {
      const user = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');

      const sessions = await db.session.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: sessionPublicSelection,
      });
      return sessions.map(toSessionDto);
    },

    async revokeSession(userId, sessionId) {
      const user = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');

      const result = await db.session.updateMany({
        where: { id: sessionId, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (result.count > 0) return;

      const session = await db.session.findFirst({
        where: { id: sessionId, userId },
        select: { id: true },
      });
      if (!session) throw new AppError('Session not found', 404, 'SESSION_NOT_FOUND');
    },

    async create(data) {
      try {
        const user = await db.user.create({
          data: {
            email: data.email,
            name: data.name,
            passwordHash: await bcrypt.hash(data.password, 12),
            userRoles: { create: data.roleIds.map((roleId) => ({ roleId })) },
          },
          select: publicSelection,
        });
        await permissions.invalidateUserPermissions(user.id);
        return toDto(user);
      } catch (error) {
        return mapPersistenceError(error);
      }
    },

    async update(id, data) {
      try {
        const { password, roleIds, ...fields } = data;
        const user = await db.user.update({
          where: { id },
          data: {
            ...fields,
            ...(password ? { passwordHash: await bcrypt.hash(password, 12) } : {}),
            ...(roleIds
              ? { userRoles: { deleteMany: {}, create: roleIds.map((roleId) => ({ roleId })) } }
              : {}),
          },
          select: publicSelection,
        });
        await permissions.invalidateUserPermissions(id);
        return toDto(user);
      } catch (error) {
        return mapPersistenceError(error);
      }
    },

    async disable(id) {
      try {
        const disabled = await db.$transaction(async (transaction: Prisma.TransactionClient) => {
          const user = await transaction.user.update({
            where: { id },
            data: { isActive: false },
            select: publicSelection,
          });
          await transaction.session.updateMany({
            where: { userId: id, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          return toDto(user);
        });
        await permissions.invalidateUserPermissions(id);
        return disabled;
      } catch (error) {
        return mapPersistenceError(error);
      }
    },
  };
};
