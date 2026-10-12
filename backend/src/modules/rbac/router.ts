import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { validate } from '../../common/middleware/validate.js';
import { created, describeRoutes, ok, refusals } from '../../common/openapi/index.js';
import type { RbacController } from './controller.js';
import { permissionGate, requirePermission } from './middleware.js';
import type { RbacAdminService } from './service.js';
import { permissionScopes, roleSchema } from './types.js';
import {
  createRoleSchema,
  permissionKeySchema,
  replaceRolePermissionsSchema,
} from './validation.js';

const permissionCheckSchema = z.object({
  allowed: z.boolean(),
  scope: z.enum(permissionScopes).nullable(),
});

export const createRbacRouter = (
  controller: RbacController,
  authenticate: RequestHandler,
  rbacService: RbacAdminService,
): Router => {
  const router = Router();
  router.use(authenticate);
  const routes = describeRoutes(router, [
    { name: 'RBAC', description: 'Перевірка дозволів' },
    { name: 'Roles', description: 'Ролі та їхні дозволи' },
  ]);

  routes.get(
    '/check/:resource/:action',
    {
      summary: 'Перевірити дозвіл поточного користувача',
      response: ok('Результат перевірки', permissionCheckSchema),
      refusals: refusals(401),
    },
    validate(permissionKeySchema),
    controller.check,
  );
  routes.get(
    '/roles',
    {
      tags: ['Roles'],
      summary: 'Переглянути ролі',
      response: ok('Ролі', z.array(roleSchema)),
      refusals: refusals(401, 403),
    },
    requirePermission(rbacService, { resource: 'users', action: 'read' }),
    controller.listRoles,
  );
  // Permission first, then validation, then breadth: the order the sibling
  // backend refuses in (see `permissionGate`).
  const canCreate = permissionGate(rbacService, { resource: 'users', action: 'create' });
  routes.post(
    '/roles',
    {
      tags: ['Roles'],
      summary: 'Створити роль',
      response: created('Роль створено', roleSchema),
      refusals: refusals(401, 403, 409),
    },
    canCreate.held,
    validate(createRoleSchema),
    canCreate.breadth,
    controller.createRole,
  );
  const canUpdate = permissionGate(rbacService, { resource: 'users', action: 'update' });
  routes.put(
    '/roles/:id/permissions',
    {
      tags: ['Roles'],
      summary: 'Замінити дозволи ролі',
      response: ok('Дозволи ролі замінено', roleSchema),
      refusals: refusals(401, 403, 404),
    },
    canUpdate.held,
    validate(replaceRolePermissionsSchema),
    canUpdate.breadth,
    controller.replaceRolePermissions,
  );
  return router;
};
