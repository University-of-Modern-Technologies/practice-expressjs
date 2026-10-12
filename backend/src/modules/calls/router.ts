import { Router, type RequestHandler } from 'express';

import { validate } from '../../common/middleware/validate.js';
import { describeRoutes, noContent, ok, pageOf, refusals } from '../../common/openapi/index.js';
import type { CallsController } from './controller.js';
import { callRecordingSchema, callSchema, callSyncResultSchema } from './types.js';
import {
  deleteCallSchema,
  getCallRecordingSchema,
  getCallSchema,
  linkCallSchema,
  listCallsSchema,
  syncCallsSchema,
  updateCallSchema,
} from './validation.js';

/**
 * There is no `POST /` here: a call is not something this system creates, it is
 * something the switchboard already did and we import. Import is therefore its
 * own route, and the collection has no write of its own.
 */
export const createCallsRouter = (
  controller: CallsController,
  authenticate: RequestHandler,
): Router => {
  const router = Router();
  router.use(authenticate);
  const routes = describeRoutes(router, [{ name: 'Calls', description: 'Журнал дзвінків' }]);

  routes.get(
    '/',
    {
      summary: 'Переглянути журнал дзвінків',
      response: ok('Сторінка дзвінків', pageOf(callSchema)),
      refusals: refusals(401, 403),
    },
    validate(listCallsSchema),
    controller.list,
  );
  routes.post(
    '/sync',
    {
      summary: 'Підтягнути дзвінки від провайдера',
      description:
        'Імпорт ідемпотентний: ключ — externalId, тож повторний виклик з тією самою пачкою ' +
        'нічого не дублює й повертає їх у skipped. Недоступний провайдер — 502 ' +
        '`CALL_PROVIDER_UNAVAILABLE`.',
      response: ok('Підсумок синхронізації', callSyncResultSchema),
      refusals: refusals(401, 403, 502),
    },
    validate(syncCallsSchema),
    controller.sync,
  );
  routes.get(
    '/:id',
    {
      summary: 'Отримати дзвінок',
      response: ok('Дзвінок', callSchema),
      refusals: refusals(401, 403, 404),
    },
    validate(getCallSchema),
    controller.getById,
  );
  routes.get(
    '/:id/recording',
    {
      summary: 'Отримати посилання на запис дзвінка',
      description: 'Якщо запису немає — 404 `CALL_RECORDING_UNAVAILABLE`.',
      response: ok('Посилання на запис', callRecordingSchema),
      refusals: refusals(401, 403, 404),
    },
    validate(getCallRecordingSchema),
    controller.getRecording,
  );
  routes.patch(
    '/:id',
    {
      summary: 'Оновити дзвінок',
      description:
        'Змінюються лише contactId, dealId, ownerId і notes. Решта полів приїжджає від ' +
        'провайдера й руками не правиться.',
      response: ok('Дзвінок оновлено', callSchema),
      refusals: refusals(401, 403, 404, 409),
    },
    validate(updateCallSchema),
    controller.update,
  );
  routes.post(
    '/:id/link',
    {
      summary: 'Прив’язати дзвінок до контакту або угоди',
      response: ok('Дзвінок прив’язано', callSchema),
      refusals: refusals(401, 403, 404, 409),
    },
    validate(linkCallSchema),
    controller.link,
  );
  routes.delete(
    '/:id',
    {
      summary: 'Видалити дзвінок',
      response: noContent('Дзвінок видалено'),
      refusals: refusals(401, 403, 404, 409),
    },
    validate(deleteCallSchema),
    controller.delete,
  );
  return router;
};
