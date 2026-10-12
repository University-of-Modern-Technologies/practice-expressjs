import { Router, type RequestHandler } from 'express';

import { validate } from '../../common/middleware/validate.js';
import { describeRoutes, ok, pageOf, refusals } from '../../common/openapi/index.js';
import type { AuditController } from './controller.js';
import { auditRecordSchema } from './types.js';
import { auditHistorySchema, getAuditSchema, listAuditSchema } from './validation.js';

const auditPage = pageOf(auditRecordSchema);

export const createAuditRouter = (
  controller: AuditController,
  authenticate: RequestHandler,
): Router => {
  const router = Router();
  router.use(authenticate);
  const routes = describeRoutes(router, [
    { name: 'Audit', description: 'Журнал аудиту' },
    { name: 'Resource history', description: 'Історія змін ресурсу' },
  ]);

  routes.get(
    '/',
    {
      summary: 'Переглянути журнал аудиту',
      response: ok('Сторінка подій аудиту', auditPage),
      refusals: refusals(401, 403),
    },
    validate(listAuditSchema),
    controller.list,
  );
  routes.get(
    '/:resource/:resourceId',
    {
      tags: ['Resource history'],
      summary: 'Переглянути історію конкретного ресурсу',
      response: ok('Сторінка подій аудиту', auditPage),
      refusals: refusals(401, 403),
    },
    validate(auditHistorySchema),
    controller.history,
  );
  routes.get(
    '/:id',
    {
      summary: 'Отримати подію аудиту',
      response: ok('Подія аудиту', auditRecordSchema),
      refusals: refusals(401, 403, 404),
    },
    validate(getAuditSchema),
    controller.getById,
  );
  return router;
};
