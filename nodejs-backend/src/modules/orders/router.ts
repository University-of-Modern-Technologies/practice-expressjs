import { Router, type RequestHandler } from 'express';

import { validate } from '../../common/middleware/validate.js';
import type { OrdersController } from './controller.js';
import {
  addOrderItemSchema,
  createOrderSchema,
  deleteOrderSchema,
  duplicateOrderSchema,
  getOrderSchema,
  listOrdersSchema,
  removeOrderItemSchema,
  transitionOrderSchema,
  updateOrderItemSchema,
  updateOrderSchema,
} from './validation.js';

export const createOrdersRouter = (
  controller: OrdersController,
  authenticate: RequestHandler,
): Router => {
  const router = Router();
  router.use(authenticate);
  router.get('/', validate(listOrdersSchema), controller.list);
  router.get('/:id', validate(getOrderSchema), controller.getById);
  router.post('/', validate(createOrderSchema), controller.create);
  router.post('/:id/duplicate', validate(duplicateOrderSchema), controller.duplicate);
  router.patch('/:id', validate(updateOrderSchema), controller.update);
  router.post('/:id/items', validate(addOrderItemSchema), controller.addItem);
  router.patch('/:id/items/:itemId', validate(updateOrderItemSchema), controller.updateItem);
  router.delete('/:id/items/:itemId', validate(removeOrderItemSchema), controller.removeItem);
  // The status is server-owned: it is never settable through a plain update.
  router.post('/:id/transitions', validate(transitionOrderSchema), controller.transition);
  router.delete('/:id', validate(deleteOrderSchema), controller.delete);
  return router;
};
