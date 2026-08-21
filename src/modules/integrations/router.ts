import { Router, type RequestHandler } from 'express';

import { validate } from '../../common/middleware/validate.js';
import type { IntegrationsController } from './controller.js';
import { createQuoteSchema, createShipmentSchema, getShipmentSchema } from './validation.js';

export const createIntegrationsRouter = (
  controller: IntegrationsController,
  authenticate: RequestHandler,
): Router => {
  const router = Router();
  router.use(authenticate);
  router.get('/health', controller.health);
  router.post('/delivery/quotes', validate(createQuoteSchema), controller.createQuote);
  router.post('/delivery/shipments', validate(createShipmentSchema), controller.createShipment);
  router.get('/delivery/shipments/:id', validate(getShipmentSchema), controller.getShipment);
  return router;
};
