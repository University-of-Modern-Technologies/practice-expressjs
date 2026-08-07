import type { CookieOptions } from 'express';

import type { AuthContext } from '../../common/types/auth-context.js';

export const REFRESH_COOKIE_NAME = 'refresh_token';

export interface PermissionGrant {
  resource: string;
  action: string;
  scope: 'ALL' | 'OWN';
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  roles: string[];
  permissions: PermissionGrant[];
}

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
