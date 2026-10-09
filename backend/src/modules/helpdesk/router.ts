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
import type { HelpdeskController } from './controller.js';
import { ticketSchema } from './types.js';
import {
  createTicketSchema,
  deleteTicketSchema,
  getTicketSchema,
  listTicketsSchema,
  transitionTicketSchema,
  updateTicketSchema,
} from './validation.js';

/**
 * Mounted under the module, not under the resource: tickets are what the
 * helpdesk exposes today, and a second resource would sit beside them here
 * instead of forcing a second mount point.
 */
export const createHelpdeskRouter = (
  controller: HelpdeskController,
  authenticate: RequestHandler,
): Router => {
  const router = Router();
  router.use(authenticate);
  const routes = describeRoutes(router, [
    { name: 'Helpdesk', description: 'Звернення клієнтів' },
    { name: 'Helpdesk transitions', description: 'Переходи звернень між станами' },
  ]);

  routes.get(
    '/tickets',
    {
      summary: 'Переглянути звернення',
      response: ok('Сторінка звернень', pageOf(ticketSchema)),
      refusals: refusals(401, 403),
    },
    validate(listTicketsSchema),
    controller.list,
  );
  routes.get(
    '/tickets/:id',
    {
      summary: 'Отримати звернення',
      response: ok('Звернення', ticketSchema),
      refusals: refusals(401, 403, 404),
    },
    validate(getTicketSchema),
    controller.getById,
  );
  routes.post(
    '/tickets',
    {
      summary: 'Створити звернення',
      description: 'Звернення завжди відкривається у статусі NEW під згенерованим номером.',
      response: created('Звернення створено', ticketSchema),
      refusals: refusals(401, 403, 404, 409),
    },
    validate(createTicketSchema),
    controller.create,
  );
  routes.patch(
    '/tickets/:id',
    {
      summary: 'Оновити звернення без зміни статусу',
      response: ok('Звернення оновлено', ticketSchema),
      refusals: refusals(401, 403, 404, 409),
    },
    validate(updateTicketSchema),
    controller.update,
  );
  routes.post(
    '/tickets/:id/transitions',
    {
      tags: ['Helpdesk transitions'],
      summary: 'Перевести звернення в інший статус',
      description:
        'Дозволені переходи: NEW → OPEN/CLOSED, OPEN → PENDING/RESOLVED/CLOSED, ' +
        'PENDING → OPEN/RESOLVED/CLOSED, RESOLVED → CLOSED/OPEN. Перехід поза таблицею — ' +
        '422 `TICKET_TRANSITION_NOT_ALLOWED`.',
      response: ok('Статус звернення змінено', ticketSchema),
      refusals: refusals(401, 403, 404, 409, 422),
    },
    validate(transitionTicketSchema),
    controller.transition,
  );
  routes.delete(
    '/tickets/:id',
    {
      summary: 'Видалити звернення',
      response: noContent('Звернення видалено'),
      refusals: refusals(401, 403, 404, 409),
    },
    validate(deleteTicketSchema),
    controller.delete,
  );
  return router;
};
