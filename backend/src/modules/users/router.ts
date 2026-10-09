import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { validate } from '../../common/middleware/validate.js';
import {
  created,
  describeRoutes,
  noContent,
  ok,
  pageOf,
  refusals,
} from '../../common/openapi/index.js';
import type { RbacService } from '../rbac/service.js';
import { requirePermission } from '../rbac/middleware.js';
import type { UsersController } from './controller.js';
import { userSchema, userSessionSchema } from './types.js';
import {
  createUserSchema,
  disableUserSchema,
  getUserSchema,
  listUserSessionsSchema,
  listUsersSchema,
  revokeUserSessionSchema,
  updateUserSchema,
} from './validation.js';

const nestedUserId = (request: Request): string | undefined => {
  const id = request.params.id;
  return typeof id === 'string' ? id : undefined;
};

export const createUsersRouter = (
  controller: UsersController,
  authenticate: RequestHandler,
  rbacService: RbacService,
): Router => {
  const router = Router();
  router.use(authenticate);
  const routes = describeRoutes(router, [
    { name: 'Users', description: 'Користувачі системи' },
    { name: 'Sessions', description: 'Refresh-сесії користувачів' },
  ]);

  routes.get(
    '/',
    {
      summary: 'Переглянути користувачів',
      response: ok('Сторінка користувачів', pageOf(userSchema)),
      refusals: refusals(401, 403),
    },
    requirePermission(rbacService, { resource: 'users', action: 'read' }),
    validate(listUsersSchema),
    controller.list,
  );
  routes.get(
    '/:id',
    {
      summary: 'Отримати користувача',
      response: ok('Користувач', userSchema),
      refusals: refusals(401, 403, 404),
    },
    requirePermission(rbacService, {
      resource: 'users',
      action: 'read',
      ownerId: nestedUserId,
    }),
    validate(getUserSchema),
    controller.getById,
  );
  routes.get(
    '/:id/sessions',
    {
      tags: ['Sessions'],
      summary: 'Переглянути сесії користувача',
      response: ok('Сесії користувача', z.array(userSessionSchema)),
      refusals: refusals(401, 403, 404),
    },
    validate(listUserSessionsSchema),
    requirePermission(rbacService, {
      resource: 'users',
      action: 'read',
      ownerId: nestedUserId,
    }),
    controller.listSessions,
  );
  routes.delete(
    '/:id/sessions/:sessionId',
    {
      tags: ['Sessions'],
      summary: 'Відкликати сесію користувача',
      response: noContent('Сесію відкликано'),
      refusals: refusals(401, 403, 404),
    },
    validate(revokeUserSessionSchema),
    requirePermission(rbacService, {
      resource: 'users',
      action: 'update',
      ownerId: nestedUserId,
    }),
    controller.revokeSession,
  );
  routes.post(
    '/',
    {
      summary: 'Створити користувача',
      response: created('Користувача створено', userSchema),
      refusals: refusals(401, 403, 404, 409),
    },
    requirePermission(rbacService, { resource: 'users', action: 'create' }),
    validate(createUserSchema),
    controller.create,
  );
  routes.patch(
    '/:id',
    {
      summary: 'Оновити користувача',
      response: ok('Користувача оновлено', userSchema),
      refusals: refusals(401, 403, 404, 409),
    },
    requirePermission(rbacService, { resource: 'users', action: 'update' }),
    validate(updateUserSchema),
    controller.update,
  );
  routes.post(
    '/:id/disable',
    {
      summary: 'Деактивувати користувача',
      response: ok('Користувача деактивовано', userSchema),
      refusals: refusals(401, 403, 404),
    },
    requirePermission(rbacService, { resource: 'users', action: 'disable' }),
    validate(disableUserSchema),
    controller.disable,
  );
  return router;
};
