import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { AppError } from '../../common/errors/app-error.js';
import type {
  AuthConfig,
  AuthResult,
  AuthenticatedUser,
  AuthTokens,
  PermissionGrant,
} from './types.js';
import { parsePermissionKey } from '../rbac/types.js';
import type { LoginInput } from './validation.js';

interface UserRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  isActive: boolean;
  userRoles: Array<{
    role: {
      name: string;
      permissions: Array<{ scope: 'ALL' | 'OWN'; permission: { key: string } }>;
    };
  }>;
}

export type AuthDatabase = Pick<PrismaClient, 'user' | 'session'>;

export interface AuthService {
  login(input: LoginInput): Promise<AuthResult>;
  refresh(refreshToken: string): Promise<AuthResult>;
  logout(refreshToken?: string): Promise<void>;
  authenticate(accessToken: string): Promise<{ userId: string; sessionId: string }>;
  me(userId: string): Promise<AuthenticatedUser>;
}

const userSelection = {
  id: true,
  email: true,
  name: true,
  passwordHash: true,
  isActive: true,
  userRoles: {
    select: {
      role: {
        select: {
          name: true,
          permissions: { select: { scope: true, permission: { select: { key: true } } } },
        },
      },
    },
  },
};

const parsePermission = (key: string, scope: 'ALL' | 'OWN'): PermissionGrant | null => {
  const parsed = parsePermissionKey(key);
  return parsed ? { ...parsed, scope } : null;
};

const toUserDto = (user: UserRecord): AuthenticatedUser => {
  const permissions = new Map<string, PermissionGrant>();
  for (const { role } of user.userRoles) {
    for (const grant of role.permissions) {
      const parsed = parsePermission(grant.permission.key, grant.scope);
      if (!parsed) continue;
      const key = `${parsed.resource}:${parsed.action}`;
      if (!permissions.has(key) || parsed.scope === 'ALL') permissions.set(key, parsed);
    }
  }
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    roles: user.userRoles.map(({ role }) => role.name),
    permissions: [...permissions.values()],
  };
};

const splitRefreshToken = (token: string): { sessionId: string; secret: string } => {
  const separator = token.indexOf('.');
  if (separator < 1 || separator === token.length - 1) {
    throw new AppError('Invalid refresh token', 401, 'INVALID_REFRESH_TOKEN');
  }
  return { sessionId: token.slice(0, separator), secret: token.slice(separator + 1) };
};

export const createAuthService = (db: AuthDatabase, config: AuthConfig): AuthService => {
  const issueAccessToken = (userId: string, sessionId: string): string =>
    jwt.sign({ type: 'access', sessionId }, config.accessTokenSecret, {
      subject: userId,
      expiresIn: config.accessTokenTtlSeconds,
    });

  const issueSessionTokens = async (userId: string, sessionId?: string): Promise<AuthTokens> => {
    const secret = randomBytes(48).toString('base64url');
    const tokenHash = await bcrypt.hash(secret, 12);
    const expiresAt = new Date(Date.now() + config.refreshTokenTtlSeconds * 1000);
    const session = sessionId
      ? await db.session.update({
          where: { id: sessionId },
          data: { tokenHash, expiresAt, revokedAt: null },
        })
      : await db.session.create({ data: { userId, tokenHash, expiresAt } });
    return {
      accessToken: issueAccessToken(userId, session.id),
      refreshToken: `${session.id}.${secret}`,
      accessTokenExpiresInSeconds: config.accessTokenTtlSeconds,
    };
  };

  const getActiveUser = async (userId: string): Promise<UserRecord> => {
    const user = await db.user.findUnique({ where: { id: userId }, select: userSelection });
    if (!user || !user.isActive) throw new AppError('User is unavailable', 401, 'USER_UNAVAILABLE');
    return user;
  };

  return {
    async login(input) {
      const user = await db.user.findUnique({
        where: { email: input.email },
        select: userSelection,
      });
      if (!user || !user.isActive || !(await bcrypt.compare(input.password, user.passwordHash))) {
        throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
      }
      return { user: toUserDto(user), ...(await issueSessionTokens(user.id)) };
    },

    async refresh(refreshToken) {
      const { sessionId, secret } = splitRefreshToken(refreshToken);
      const session = await db.session.findUnique({
        where: { id: sessionId },
        include: { user: { select: userSelection } },
      });
      if (
        !session ||
        session.revokedAt ||
        session.expiresAt.getTime() <= Date.now() ||
        !session.user ||
        !session.user.isActive ||
        !(await bcrypt.compare(secret, session.tokenHash))
      ) {
        throw new AppError('Invalid refresh token', 401, 'INVALID_REFRESH_TOKEN');
      }
      return {
        user: toUserDto(session.user),
        ...(await issueSessionTokens(session.userId, session.id)),
      };
    },

    async logout(refreshToken) {
      if (!refreshToken) return;
      try {
        const { sessionId } = splitRefreshToken(refreshToken);
        await db.session.updateMany({
          where: { id: sessionId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
      }
    },

    async authenticate(accessToken) {
      try {
        const payload = jwt.verify(accessToken, config.accessTokenSecret);
        if (
          typeof payload === 'string' ||
          payload.type !== 'access' ||
          typeof payload.sub !== 'string' ||
          typeof payload.sessionId !== 'string'
        ) {
          throw new Error('Invalid access token payload');
        }
        const session = await db.session.findUnique({ where: { id: payload.sessionId } });
        if (
          !session ||
          session.userId !== payload.sub ||
          session.revokedAt ||
          session.expiresAt <= new Date()
        ) {
          throw new Error('Inactive session');
        }
        await getActiveUser(payload.sub);
        return { userId: payload.sub, sessionId: payload.sessionId };
      } catch {
        throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
      }
    },

    async me(userId) {
      return toUserDto(await getActiveUser(userId));
    },
  };
};

export const authConfigFromEnv = (): AuthConfig => {
  const accessTokenSecret = process.env.JWT_ACCESS_SECRET;
  if (!accessTokenSecret) throw new Error('JWT_ACCESS_SECRET is required');
  return {
    accessTokenSecret,
    accessTokenTtlSeconds: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900),
    refreshTokenTtlSeconds: Number(process.env.REFRESH_TOKEN_TTL_SECONDS ?? 7 * 24 * 60 * 60),
    refreshCookieName: process.env.REFRESH_COOKIE_NAME ?? 'refresh_token',
    refreshCookiePath: '/api/auth',
    secureCookies: process.env.NODE_ENV === 'production',
  };
};
