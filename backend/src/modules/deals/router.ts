import { Router, type RequestHandler } from 'express';

import { validate } from '../../common/middleware/validate.js';
import {
  created,
  describeRoutes,
  noContent,
  ok,
  pageOf,
  refusals,
} from '../../common/openapi/index.js';
import type { DealsController } from './controller.js';
import { dealSchema } from './types.js';
import {
  createDealSchema,
  deleteDealSchema,
  getDealSchema,
  listDealsSchema,
  transitionDealSchema,
  updateDealSchema,
} from './validation.js';

export const createDealsRouter = (
  controller: DealsController,
  authenticate: RequestHandler,
): Router => {
  const router = Router();
  router.use(authenticate);
  const routes = describeRoutes(router, [
    { name: 'Deals', description: 'Угоди CRM' },
    { name: 'Deal transitions', description: 'Переходи угод між stage' },
  ]);

  routes.get(
    '/',
    {
      summary: 'Переглянути угоди',
      response: ok('Сторінка угод', pageOf(dealSchema)),
      refusals: refusals(401, 403),
    },
    validate(listDealsSchema),
    controller.list,
  );
  routes.get(
    '/:id',
    {
      summary: 'Отримати угоду',
      response: ok('Угода', dealSchema),
      refusals: refusals(401, 403, 404),
    },
    validate(getDealSchema),
    controller.getById,
  );
  routes.post(
    '/',
    {
      summary: 'Створити угоду',
      response: created('Угоду створено', dealSchema),
      refusals: refusals(401, 403, 404),
    },
    validate(createDealSchema),
    controller.create,
  );
  routes.patch(
    '/:id',
    {
      summary: 'Оновити угоду без зміни stage',
      response: ok('Угоду оновлено', dealSchema),
      refusals: refusals(401, 403, 404, 409),
    },
    validate(updateDealSchema),
    controller.update,
  );
  routes.post(
    '/:id/transitions',
    {
      tags: ['Deal transitions'],
      summary: 'Перевести угоду на інший stage',
      description:
        'Дозволені переходи: LEAD → QUALIFIED, QUALIFIED → PROPOSAL, PROPOSAL → WON/LOST.',
      response: ok('Stage угоди змінено', dealSchema),
      refusals: refusals(401, 403, 404, 409),
    },
    validate(transitionDealSchema),
    controller.transition,
  );
  routes.delete(
    '/:id',
    {
      summary: 'Видалити угоду',
      response: noContent('Угоду видалено'),
      refusals: refusals(401, 403, 404, 409),
    },
    validate(deleteDealSchema),
    controller.delete,
  );
  return router;
};
