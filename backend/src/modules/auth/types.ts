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
