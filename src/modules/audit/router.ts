import { Router, type RequestHandler } from 'express';

import { validate } from '../../common/middleware/validate.js';
import type { AuditController } from './controller.js';
import { auditHistorySchema, getAuditSchema, listAuditSchema } from './validation.js';

export const createAuditRouter = (
  controller: AuditController,
  authenticate: RequestHandler,
): Router => {
  const router = Router();
  router.use(authenticate);
  router.get('/', validate(listAuditSchema), controller.list);
  router.get('/:resource/:resourceId', validate(auditHistorySchema), controller.history);
  router.get('/:id', validate(getAuditSchema), controller.getById);
  return router;
};
