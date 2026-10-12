import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { AppError } from '../../common/errors/app-error.js';
import {
  noopSessionRevocationListener,
  notifySessionsRevoked,
  type AuthConfig,
  type AuthResult,
  type AuthenticatedUser,
  type AuthTokens,
  type PermissionGrant,
  type SessionRevocationListener,
  type VerifiedAccess,
} from './types.js';
import { parsePermissionKey } from '../rbac/types.js';
import type { SessionClient } from './client.js';
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
  login(input: LoginInput, client?: SessionClient): Promise<AuthResult>;
  refresh(refreshToken: string, client?: SessionClient): Promise<AuthResult>;
  logout(refreshToken?: string): Promise<void>;
  authenticate(accessToken: string): Promise<VerifiedAccess>;
  me(userId: string): Promise<AuthenticatedUser>;
}

/** Work factor for every digest this service writes. */
const BCRYPT_ROUNDS = 12;

/**
 * Digest of a throwaway password at the same work factor. A login for an
 * address nobody holds is checked against it, so that case costs the same time
 * as a wrong password and the response time does not reveal who has an account.
 */
export const DUMMY_PASSWORD_HASH = '$2b$12$gZVMDJyGYCaF.8HNnTCql.wJGnSgdF5t1tOnnHEZohOMJ3TR.KlTC';

/** Identifiers exactly as they are issued; nothing else reaches a query. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

const invalidRefreshToken = (): AppError =>
  new AppError('Invalid refresh token', 401, 'INVALID_REFRESH_TOKEN');

const unauthorized = (): AppError => new AppError('Unauthorized', 401, 'UNAUTHORIZED');

/**
 * Splits `"{sessionId}.{secret}"`. The session half must be an identifier in
 * the form it was issued in, so a forged cookie is a 401 and never reaches the
 * database as a value the column cannot hold.
 */
export const splitRefreshToken = (token: string): { sessionId: string; secret: string } => {
  const separator = token.indexOf('.');
  if (separator < 1 || separator === token.length - 1) throw invalidRefreshToken();
  const sessionId = token.slice(0, separator);
  if (!UUID_PATTERN.test(sessionId)) throw invalidRefreshToken();
  return { sessionId: sessionId.toLowerCase(), secret: token.slice(separator + 1) };
};

/** The claims an access token must carry, or `null` when it carries anything else. */
const verifyAccessClaims = (accessToken: string, secret: string): VerifiedAccess | null => {
  let payload: string | JwtPayload;
  try {
    payload = jwt.verify(accessToken, secret);
  } catch {
    return null;
  }
  if (
    typeof payload === 'string' ||
    payload.type !== 'access' ||
    typeof payload.sub !== 'string' ||
    typeof payload.sessionId !== 'string' ||
    // A token without a lifetime would be valid forever; none is ever issued.
    typeof payload.exp !== 'number' ||
    !UUID_PATTERN.test(payload.sub) ||
    !UUID_PATTERN.test(payload.sessionId)
  ) {
    return null;
  }
  return {
    userId: payload.sub,
    sessionId: payload.sessionId,
    expiresAt: new Date(payload.exp * 1000),
  };
};

const clientColumns = (client: SessionClient | undefined) =>
  client ? { ipAddress: client.ipAddress, userAgent: client.userAgent } : {};

export const createAuthService = (
  db: AuthDatabase,
  config: AuthConfig,
  // Told about a session a logout ended, so a socket opened with it is closed
  // now rather than when its access token runs out.
  sessions: SessionRevocationListener = noopSessionRevocationListener,
): AuthService => {
  const issueAccessToken = (userId: string, sessionId: string): string =>
    jwt.sign({ type: 'access', sessionId }, config.accessTokenSecret, {
      subject: userId,
      expiresIn: config.accessTokenTtlSeconds,
    });

  const tokensFor = (userId: string, sessionId: string, secret: string): AuthTokens => ({
    accessToken: issueAccessToken(userId, sessionId),
    refreshToken: `${sessionId}.${secret}`,
    accessTokenExpiresInSeconds: config.accessTokenTtlSeconds,
  });

  const freshSecret = async () => {
    const secret = randomBytes(48).toString('base64url');
    const tokenHash = await bcrypt.hash(secret, BCRYPT_ROUNDS);
    const expiresAt = new Date(Date.now() + config.refreshTokenTtlSeconds * 1000);
    return { secret, tokenHash, expiresAt };
  };

  const openSession = async (userId: string, client?: SessionClient): Promise<AuthTokens> => {
    const { secret, tokenHash, expiresAt } = await freshSecret();
    const session = await db.session.create({
      data: { userId, tokenHash, expiresAt, ...clientColumns(client) },
    });
    return tokensFor(userId, session.id, secret);
  };

  const rotateSession = async (
    userId: string,
    sessionId: string,
    client?: SessionClient,
  ): Promise<AuthTokens> => {
    const { secret, tokenHash, expiresAt } = await freshSecret();
    // The write is conditional on the row still being live. A revocation that
    // commits while this refresh is in flight therefore wins: the row stays
    // revoked, and the caller gets the answer any other unusable token gets.
    const { count } = await db.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { tokenHash, expiresAt, ...clientColumns(client) },
    });
    if (count !== 1) throw invalidRefreshToken();
    return tokensFor(userId, sessionId, secret);
  };

  const getActiveUser = async (userId: string): Promise<UserRecord> => {
    const user = await db.user.findUnique({ where: { id: userId }, select: userSelection });
    if (!user || !user.isActive) throw new AppError('User is unavailable', 401, 'USER_UNAVAILABLE');
    return user;
  };

  return {
    async login(input, client) {
      const user = await db.user.findUnique({
        where: { email: input.email },
        select: userSelection,
      });
      // The password is checked in every case, against a throwaway digest when
      // there is no account, so a missing account, a disabled one and a wrong
      // password all take the same time to refuse.
      const passwordMatches = await bcrypt.compare(
        input.password,
        user?.passwordHash ?? DUMMY_PASSWORD_HASH,
      );
      if (!user || !user.isActive || !passwordMatches) {
        throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
      }
      return { user: toUserDto(user), ...(await openSession(user.id, client)) };
    },

    async refresh(refreshToken, client) {
      const { sessionId, secret } = splitRefreshToken(refreshToken);
      const session = await db.session.findUnique({
        where: { id: sessionId },
        include: { user: { select: userSelection } },
      });
      if (
        !session ||
        session.revokedAt ||
        session.expiresAt.getTime() <= Date.now() ||
        !(await bcrypt.compare(secret, session.tokenHash)) ||
        !session.user ||
        !session.user.isActive
      ) {
        throw invalidRefreshToken();
      }
      return {
        user: toUserDto(session.user),
        ...(await rotateSession(session.userId, session.id, client)),
      };
    },

    async logout(refreshToken) {
      // Only the holder of the whole refresh token may end its session: the
      // session id alone is not a secret. Every refusal looks the same as a
      // logout without a cookie, so the answer never says whether the session
      // exists.
      if (!refreshToken) return;
      let parts: { sessionId: string; secret: string };
      try {
        parts = splitRefreshToken(refreshToken);
      } catch (error) {
        if (error instanceof AppError) return;
        throw error;
      }

      const session = await db.session.findUnique({
        where: { id: parts.sessionId },
        select: { id: true, tokenHash: true, revokedAt: true },
      });
      // The secret is checked in every case, against a throwaway digest when
      // there is no row, so a missing session costs the same time as a wrong
      // secret.
      const secretMatches = await bcrypt.compare(
        parts.secret,
        session?.tokenHash ?? DUMMY_PASSWORD_HASH,
      );
      if (!session || !secretMatches || session.revokedAt) return;

      // Conditional on the digest just checked: a refresh that rotated the
      // secret in the meantime leaves this, now stale, token without effect.
      const { count } = await db.session.updateMany({
        where: { id: session.id, tokenHash: session.tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (count === 1) notifySessionsRevoked(sessions, { sessionIds: [session.id] });
    },

    async authenticate(accessToken) {
      // Only a token that fails verification is the caller's problem. A store
      // that cannot be read is an outage, and it propagates as one instead of
      // being reported as "you are not signed in".
      const claims = verifyAccessClaims(accessToken, config.accessTokenSecret);
      if (!claims) throw unauthorized();

      const session = await db.session.findUnique({ where: { id: claims.sessionId } });
      if (
        !session ||
        session.userId !== claims.userId ||
        session.revokedAt ||
        session.expiresAt <= new Date()
      ) {
        throw unauthorized();
      }
      const user = await db.user.findUnique({
        where: { id: claims.userId },
        select: { isActive: true },
      });
      if (!user || !user.isActive) throw unauthorized();
      return claims;
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
    secureCookies: process.env.APP_ENV === 'production',
  };
};
