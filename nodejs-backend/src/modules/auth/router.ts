import { Router } from 'express';
import { validate } from '../../common/middleware/validate.js';
import type { AuthController } from './controller.js';
import type { RequestHandler } from 'express';
import { loginSchema } from './validation.js';

export const createAuthRouter = (
  controller: AuthController,
  authenticate: RequestHandler,
): Router => {
  const router = Router();
  router.post('/login', validate(loginSchema), controller.login);
  router.post('/refresh', controller.refresh);
  router.post('/logout', controller.logout);
  router.get('/me', authenticate, controller.me);
  return router;
};
