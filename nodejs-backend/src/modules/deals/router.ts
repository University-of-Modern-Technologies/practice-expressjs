import { Router, type RequestHandler } from 'express';

import { validate } from '../../common/middleware/validate.js';
import type { DealsController } from './controller.js';
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
  router.get('/', validate(listDealsSchema), controller.list);
  router.get('/:id', validate(getDealSchema), controller.getById);
  router.post('/', validate(createDealSchema), controller.create);
  router.patch('/:id', validate(updateDealSchema), controller.update);
  router.post('/:id/transitions', validate(transitionDealSchema), controller.transition);
  router.delete('/:id', validate(deleteDealSchema), controller.delete);
  return router;
};
