import { Router, type RequestHandler } from 'express';
import { validate } from '../../common/middleware/validate.js';
import type { RbacController } from './controller.js';
import { requirePermission } from './middleware.js';
import type { RbacAdminService } from './service.js';
import {
  createRoleSchema,
  permissionKeySchema,
  replaceRolePermissionsSchema,
} from './validation.js';

export const createRbacRouter = (
  controller: RbacController,
  authenticate: RequestHandler,
  rbacService: RbacAdminService,
): Router => {
  const router = Router();
  router.use(authenticate);
  router.get('/check/:resource/:action', validate(permissionKeySchema), controller.check);
  router.get(
    '/roles',
    requirePermission(rbacService, { resource: 'users', action: 'read' }),
    controller.listRoles,
  );
  router.post(
    '/roles',
    requirePermission(rbacService, { resource: 'users', action: 'create' }),
    validate(createRoleSchema),
    controller.createRole,
  );
  router.put(
    '/roles/:id/permissions',
    requirePermission(rbacService, { resource: 'users', action: 'update' }),
    validate(replaceRolePermissionsSchema),
    controller.replaceRolePermissions,
  );
  return router;
};
