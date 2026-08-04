import type { RequestHandler } from 'express';
import { AppError } from '../../common/errors/app-error.js';
import type { AuthService } from './service.js';
import { createRefreshCookieOptions, type AuthConfig } from './types.js';
import type { LoginInput } from './validation.js';

export interface AuthController {
  login: RequestHandler;
  refresh: RequestHandler;
  logout: RequestHandler;
  me: RequestHandler;
}

export const createAuthController = (
  authService: AuthService,
  config: AuthConfig,
): AuthController => {
  const cookieOptions = createRefreshCookieOptions(config);

  return {
    login: async (request, response) => {
      const result = await authService.login(request.body as LoginInput);
      response
        .cookie(config.refreshCookieName, result.refreshToken, cookieOptions)
        .status(200)
        .json({
          data: {
            user: result.user,
            accessToken: result.accessToken,
            accessTokenExpiresInSeconds: result.accessTokenExpiresInSeconds,
          },
        });
    },

    refresh: async (request, response) => {
      const refreshToken = request.cookies?.[config.refreshCookieName] as string | undefined;
      if (!refreshToken)
        throw new AppError('Refresh token is required', 401, 'REFRESH_TOKEN_REQUIRED');
      const result = await authService.refresh(refreshToken);
      response
        .cookie(config.refreshCookieName, result.refreshToken, cookieOptions)
        .status(200)
        .json({
          data: {
            user: result.user,
            accessToken: result.accessToken,
            accessTokenExpiresInSeconds: result.accessTokenExpiresInSeconds,
          },
        });
    },

    logout: async (request, response) => {
      await authService.logout(request.cookies?.[config.refreshCookieName] as string | undefined);
      response.clearCookie(config.refreshCookieName, cookieOptions).status(204).send();
    },

    me: async (request, response) => {
      if (!request.auth) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
      response.status(200).json({ data: await authService.me(request.auth.userId) });
    },
  };
};
