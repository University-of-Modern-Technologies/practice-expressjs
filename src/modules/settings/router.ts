import { Router, type RequestHandler } from 'express';

import { validate } from '../../common/middleware/validate.js';
import { requirePermission } from '../rbac/middleware.js';
import type { RbacService } from '../rbac/service.js';
import type { SettingsController } from './controller.js';
import { deleteSettingSchema, getSettingSchema, upsertSettingSchema } from './validation.js';

export const createSettingsRouter = (
  controller: SettingsController,
  authenticate: RequestHandler,
  rbacService: RbacService,
): Router => {
  const router = Router();
  router.use(authenticate);

  const canRead = requirePermission(rbacService, { resource: 'settings', action: 'read' });
  const canWrite = requirePermission(rbacService, { resource: 'settings', action: 'write' });

  router.get('/', canRead, controller.list);
  router.get('/:key', canRead, validate(getSettingSchema), controller.getByKey);
  router.put('/:key', canWrite, validate(upsertSettingSchema), controller.upsert);
  router.delete('/:key', canWrite, validate(deleteSettingSchema), controller.remove);

  return router;
};
