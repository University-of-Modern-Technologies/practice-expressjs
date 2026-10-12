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
import { requirePermission } from '../rbac/middleware.js';
import type { RbacService } from '../rbac/service.js';
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
  rbacService: RbacService,
): Router => {
  const router = Router();
  router.use(authenticate);
  const routes = describeRoutes(router, [
    { name: 'Helpdesk', description: 'Звернення клієнтів' },
    { name: 'Helpdesk transitions', description: 'Переходи звернень між станами' },
  ]);

  // The grant is checked before the request is validated, so a caller without
  // access is refused the same way whatever they sent. Any breadth admits the
  // caller here; what that breadth lets them touch is the service's business.
  const allowed = (action: 'read' | 'write' | 'delete'): RequestHandler =>
    requirePermission(rbacService, {
      resource: 'helpdesk',
      action,
      ownerId: (request) => request.auth?.userId,
    });

  routes.get(
    '/tickets',
    {
      summary: 'Переглянути звернення',
      response: ok('Сторінка звернень', pageOf(ticketSchema)),
      refusals: refusals(401, 403),
    },
    allowed('read'),
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
    allowed('read'),
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
    allowed('write'),
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
    allowed('write'),
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
    allowed('write'),
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
    allowed('delete'),
    validate(deleteTicketSchema),
    controller.delete,
  );
  return router;
};
