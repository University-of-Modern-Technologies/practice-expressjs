import { Router, type Request, type RequestHandler } from 'express';
import { validate } from '../../common/middleware/validate.js';
import type { RbacService } from '../rbac/service.js';
import { requirePermission } from '../rbac/middleware.js';
import type { UsersController } from './controller.js';
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
  router.get(
    '/',
    requirePermission(rbacService, { resource: 'users', action: 'read' }),
    validate(listUsersSchema),
    controller.list,
  );
  router.get(
    '/:id',
    requirePermission(rbacService, {
      resource: 'users',
      action: 'read',
      ownerId: nestedUserId,
    }),
    validate(getUserSchema),
    controller.getById,
  );
  router.get(
    '/:id/sessions',
    validate(listUserSessionsSchema),
    requirePermission(rbacService, {
      resource: 'users',
      action: 'read',
      ownerId: nestedUserId,
    }),
    controller.listSessions,
  );
  router.delete(
    '/:id/sessions/:sessionId',
    validate(revokeUserSessionSchema),
    requirePermission(rbacService, {
      resource: 'users',
      action: 'update',
      ownerId: nestedUserId,
    }),
    controller.revokeSession,
  );
  router.post(
    '/',
    requirePermission(rbacService, { resource: 'users', action: 'create' }),
    validate(createUserSchema),
    controller.create,
  );
  router.patch(
    '/:id',
    requirePermission(rbacService, { resource: 'users', action: 'update' }),
    validate(updateUserSchema),
    controller.update,
  );
  router.post(
    '/:id/disable',
    requirePermission(rbacService, { resource: 'users', action: 'disable' }),
    validate(disableUserSchema),
    controller.disable,
  );
  return router;
};
