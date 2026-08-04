import { Router, type RequestHandler } from 'express';

import { validate } from '../../common/middleware/validate.js';
import type { ProductsController } from './controller.js';
import {
  createProductSchema,
  deleteProductSchema,
  getProductSchema,
  listProductsSchema,
  updateProductSchema,
} from './validation.js';

export const createProductsRouter = (
  controller: ProductsController,
  authenticate: RequestHandler,
): Router => {
  const router = Router();
  router.use(authenticate);
  router.get('/', validate(listProductsSchema), controller.list);
  router.get('/:id', validate(getProductSchema), controller.getById);
  router.post('/', validate(createProductSchema), controller.create);
  router.patch('/:id', validate(updateProductSchema), controller.update);
  router.delete('/:id', validate(deleteProductSchema), controller.delete);
  return router;
};
