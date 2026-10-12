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
import type { ProductsController } from './controller.js';
import { productSchema } from './types.js';
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
  const routes = describeRoutes(router, [{ name: 'Products', description: 'Каталог товарів' }]);

  routes.get(
    '/',
    {
      summary: 'Переглянути каталог товарів',
      description: 'Потребує дозволу `products:read`. `minPrice` не може перевищувати `maxPrice`.',
      response: ok('Сторінка товарів', pageOf(productSchema)),
      refusals: refusals(401, 403),
    },
    validate(listProductsSchema),
    controller.list,
  );
  routes.get(
    '/:id',
    {
      summary: 'Отримати товар',
      description: 'Потребує дозволу `products:read`. Помилки: 404 `PRODUCT_NOT_FOUND`.',
      response: ok('Товар', productSchema),
      refusals: refusals(401, 403, 404),
    },
    validate(getProductSchema),
    controller.getById,
  );
  routes.post(
    '/',
    {
      summary: 'Створити товар',
      description:
        'Потребує дозволу `products:write`. SKU нормалізується до верхнього регістру. ' +
        'Помилки: 409 `PRODUCT_SKU_TAKEN`, 400 `INVALID_PRODUCT_PRICE`.',
      response: created('Товар створено', productSchema),
      refusals: refusals(401, 403, 409),
    },
    validate(createProductSchema),
    controller.create,
  );
  routes.patch(
    '/:id',
    {
      summary: 'Оновити товар',
      description:
        'Потребує дозволу `products:write`. `version` обовʼязковий: якщо він не збігається з ' +
        'поточним, повертається 409 `PRODUCT_CONCURRENT_MODIFICATION`. SKU незмінний і не ' +
        'приймається. Помилки: 404 `PRODUCT_NOT_FOUND`, 409 `PRODUCT_SKU_TAKEN`, ' +
        '400 `INVALID_PRODUCT_PRICE`.',
      response: ok('Товар оновлено', productSchema),
      refusals: refusals(401, 403, 404, 409),
    },
    validate(updateProductSchema),
    controller.update,
  );
  routes.delete(
    '/:id',
    {
      summary: 'Видалити товар',
      description:
        'Потребує дозволу `products:delete`. Мʼяке видалення. `version` обовʼязковий: ' +
        'розбіжність версій дає 409 `PRODUCT_CONCURRENT_MODIFICATION`.',
      response: noContent('Товар видалено'),
      refusals: refusals(401, 403, 404, 409),
    },
    validate(deleteProductSchema),
    controller.delete,
  );
  return router;
};
