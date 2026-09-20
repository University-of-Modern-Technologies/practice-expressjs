import { Router, type RequestHandler } from 'express';

import { validate } from '../../common/middleware/validate.js';
import type { HelpdeskController } from './controller.js';
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
  router.get('/tickets', validate(listTicketsSchema), controller.list);
  router.get('/tickets/:id', validate(getTicketSchema), controller.getById);
  router.post('/tickets', validate(createTicketSchema), controller.create);
  router.patch('/tickets/:id', validate(updateTicketSchema), controller.update);
  router.post('/tickets/:id/transitions', validate(transitionTicketSchema), controller.transition);
  router.delete('/tickets/:id', validate(deleteTicketSchema), controller.delete);
  return router;
};
