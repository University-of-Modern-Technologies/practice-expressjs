import type { CookieOptions } from 'express';
import { z } from 'zod';

import type { AuthContext } from '../../common/types/auth-context.js';
import { permissionSchema, type PermissionRecord } from '../rbac/types.js';

export const REFRESH_COOKIE_NAME = 'refresh_token';

export type PermissionGrant = PermissionRecord;

export const authenticatedUserSchema = z
  .object({
    id: z.uuid(),
    email: z.email(),
    name: z.string(),
    roles: z.array(z.string()),
    permissions: z.array(permissionSchema),
  })
  .meta({ id: 'AuthenticatedUser' });

export type AuthenticatedUser = z.infer<typeof authenticatedUserSchema>;

/** What login and refresh answer with; the refresh token itself travels as a cookie. */
export const authPayloadSchema = z
  .object({
    user: authenticatedUserSchema,
    accessToken: z.string(),
    accessTokenExpiresInSeconds: z.int().min(1).meta({ example: 900 }),
  })
  .meta({ id: 'AuthPayload' });

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresInSeconds: number;
}

export interface AuthResult extends AuthTokens {
  user: AuthenticatedUser;
}

/** The identity behind a verified access token, and when that token runs out. */
export interface VerifiedAccess extends AuthContext {
  readonly expiresAt: Date;
}

/**
 * Told about sessions that can no longer authenticate, once the change that
 * ended them has committed. Whatever holds a connection open on the strength
 * of such a session — the realtime gateway — closes it instead of waiting for
 * the access token to run out.
 */
export interface SessionRevocationListener {
  sessionsRevoked(sessionIds: readonly string[]): void;
  /** Every session of this user ended at once. */
  userSessionsRevoked(userId: string): void;
}

/** Default for a service built without anything holding connections open. */
export const noopSessionRevocationListener: SessionRevocationListener = {
  sessionsRevoked: () => undefined,
  userSessionsRevoked: () => undefined,
};

/**
 * Delivers a notice without letting the listener fail the caller: the change
 * it reports has already committed and must be answered as a success. The
 * listener reports its own failures; the gateway logs every close it attempts.
 */
export const notifySessionsRevoked = (
  listener: SessionRevocationListener,
  notice: { readonly sessionIds: readonly string[] } | { readonly userId: string },
): void => {
  try {
    if ('userId' in notice) listener.userSessionsRevoked(notice.userId);
    else listener.sessionsRevoked(notice.sessionIds);
  } catch {
    // Nothing to undo: the sessions are revoked, and the access tokens behind
    // any socket still open run out on their own.
  }
};

export interface AuthConfig {
  accessTokenSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  refreshCookieName: string;
  refreshCookiePath: string;
  secureCookies: boolean;
}

export const createRefreshCookieOptions = (config: AuthConfig): CookieOptions => ({
  httpOnly: true,
  secure: config.secureCookies,
  sameSite: 'lax',
  path: config.refreshCookiePath,
  maxAge: config.refreshTokenTtlSeconds * 1000,
});

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}
