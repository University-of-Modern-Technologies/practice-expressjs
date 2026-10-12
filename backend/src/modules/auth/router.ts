import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../common/middleware/validate.js';
import { describeRoutes, noContent, ok, refusals } from '../../common/openapi/index.js';
import type { AuthController } from './controller.js';
import type { RequestHandler } from 'express';
import { authenticatedUserSchema, authPayloadSchema, REFRESH_COOKIE_NAME } from './types.js';
import { loginSchema } from './validation.js';

// Refresh and logout read the refresh cookie in the handler, not through
// `validate()`, so the cookie they accept is declared here.
const refreshCookieRequest = z.object({
  cookies: z.object({ [REFRESH_COOKIE_NAME]: z.string().optional() }),
});

export const createAuthRouter = (
  controller: AuthController,
  authenticate: RequestHandler,
): Router => {
  const router = Router();
  const routes = describeRoutes(router, [
    { name: 'Auth', description: 'Автентифікація та токени' },
  ]);

  routes.post(
    '/login',
    {
      summary: 'Увійти до системи',
      access: 'public',
      response: ok('Access token і поточний користувач', authPayloadSchema),
      refusals: refusals(401),
    },
    validate(loginSchema),
    controller.login,
  );
  routes.post(
    '/refresh',
    {
      summary: 'Оновити пару токенів',
      access: 'refreshCookie',
      request: refreshCookieRequest,
      response: ok('Access token і поточний користувач', authPayloadSchema),
      refusals: refusals(401),
    },
    controller.refresh,
  );
  routes.post(
    '/logout',
    {
      summary: 'Завершити refresh-сесію',
      access: 'optionalRefreshCookie',
      request: refreshCookieRequest,
      response: noContent('Сесію завершено, refresh cookie очищено'),
      refusals: refusals(),
    },
    controller.logout,
  );
  routes.get(
    '/me',
    {
      summary: 'Отримати поточного користувача',
      response: ok('Поточний користувач', authenticatedUserSchema),
      refusals: refusals(401),
    },
    authenticate,
    controller.me,
  );
  return router;
};
