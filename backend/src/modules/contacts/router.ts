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
import type { ContactsController } from './controller.js';
import { contactSchema } from './types.js';
import {
  createContactSchema,
  deleteContactSchema,
  getContactSchema,
  listContactsSchema,
  updateContactSchema,
} from './validation.js';

export const createContactsRouter = (
  controller: ContactsController,
  authenticate: RequestHandler,
  rbacService: RbacService,
): Router => {
  const router = Router();
  router.use(authenticate);
  const routes = describeRoutes(router, [{ name: 'Contacts', description: 'Контакти CRM' }]);

  // The grant is checked before the request is validated, so a caller without
  // access is refused the same way whatever they sent. Any breadth admits the
  // caller here; narrowing to their own records is the service's job.
  const allowed = (action: 'read' | 'write' | 'delete'): RequestHandler =>
    requirePermission(rbacService, {
      resource: 'contacts',
      action,
      ownerId: (request) => request.auth?.userId,
    });

  routes.get(
    '/',
    {
      summary: 'Переглянути контакти',
      response: ok('Сторінка контактів', pageOf(contactSchema)),
      refusals: refusals(401, 403),
    },
    allowed('read'),
    validate(listContactsSchema),
    controller.list,
  );
  routes.get(
    '/:id',
    {
      summary: 'Отримати контакт',
      response: ok('Контакт', contactSchema),
      refusals: refusals(401, 403, 404),
    },
    allowed('read'),
    validate(getContactSchema),
    controller.getById,
  );
  routes.post(
    '/',
    {
      summary: 'Створити контакт',
      description: 'Потрібно передати принаймні email або phone.',
      response: created('Контакт створено', contactSchema),
      refusals: refusals(401, 403, 409),
    },
    allowed('write'),
    validate(createContactSchema),
    controller.create,
  );
  routes.patch(
    '/:id',
    {
      summary: 'Оновити контакт',
      response: ok('Контакт оновлено', contactSchema),
      refusals: refusals(401, 403, 404, 409),
    },
    allowed('write'),
    validate(updateContactSchema),
    controller.update,
  );
  routes.delete(
    '/:id',
    {
      summary: 'Видалити контакт',
      response: noContent('Контакт видалено'),
      refusals: refusals(401, 403, 404),
    },
    allowed('delete'),
    validate(deleteContactSchema),
    controller.delete,
  );
  return router;
};
