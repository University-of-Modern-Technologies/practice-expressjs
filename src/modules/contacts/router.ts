import { Router, type RequestHandler } from 'express';

import { validate } from '../../common/middleware/validate.js';
import type { ContactsController } from './controller.js';
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
): Router => {
  const router = Router();
  router.use(authenticate);
  router.get('/', validate(listContactsSchema), controller.list);
  router.get('/:id', validate(getContactSchema), controller.getById);
  router.post('/', validate(createContactSchema), controller.create);
  router.patch('/:id', validate(updateContactSchema), controller.update);
  router.delete('/:id', validate(deleteContactSchema), controller.delete);
  return router;
};
