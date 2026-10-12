import { Router, type RequestHandler } from 'express';

import { validate } from '../../common/middleware/validate.js';
import {
  created,
  describeRoutes,
  ok,
  pageOf,
  refusals,
  type ApiOperation,
} from '../../common/openapi/index.js';
import type { WarehouseController } from './controller.js';
import { stockLevelSchema, stockMovementSchema, warehouseSchema } from './types.js';
import {
  adjustStockSchema,
  createWarehouseSchema,
  getWarehouseSchema,
  getStockSchema,
  issueStockSchema,
  listMovementsSchema,
  listStockSchema,
  listWarehousesSchema,
  receiveStockSchema,
  releaseStockSchema,
  reserveStockSchema,
  updateWarehouseSchema,
} from './validation.js';

// Every stock write goes through the same optimistic-locking retry loop.
const stockWriteErrors =
  'Помилки: 404 `WAREHOUSE_NOT_FOUND`, `PRODUCT_NOT_FOUND`; 409 `WAREHOUSE_INACTIVE`, ' +
  '`STOCK_CONCURRENT_MODIFICATION` — рівень запасів змінив паралельний запит, операцію ' +
  'треба повторити.';

const stockOperation = (summary: string, description: string): ApiOperation => ({
  tags: ['Stock'],
  summary,
  description: `Потребує дозволу \`warehouse:write\`. ${description} ${stockWriteErrors}`,
  // The stock level is updated in place, so the operation answers 200 with the
  // modified resource rather than 201.
  response: ok('Рух записано; повертається новий рівень запасів', stockLevelSchema),
  refusals: refusals(401, 403, 404, 409),
});

/**
 * Movements are append-only by design: the router exposes no update or delete
 * verb for them, so the ledger can only ever grow. A mistake is corrected by
 * recording a compensating adjustment, never by rewriting history.
 */
export const createWarehouseRouter = (
  controller: WarehouseController,
  authenticate: RequestHandler,
): Router => {
  const router = Router();
  router.use(authenticate);
  const routes = describeRoutes(router, [
    { name: 'Warehouses', description: 'Склади' },
    { name: 'Stock', description: 'Рівні запасів та складські операції' },
    { name: 'Stock movements', description: 'Журнал рухів запасів' },
  ]);

  routes.get(
    '/warehouses',
    {
      summary: 'Переглянути склади',
      description: 'Потребує дозволу `warehouse:read`.',
      response: ok('Сторінка складів', pageOf(warehouseSchema)),
      refusals: refusals(401, 403),
    },
    validate(listWarehousesSchema),
    controller.listWarehouses,
  );
  routes.get(
    '/warehouses/:id',
    {
      summary: 'Отримати склад',
      description: 'Потребує дозволу `warehouse:read`. Помилки: 404 `WAREHOUSE_NOT_FOUND`.',
      response: ok('Склад', warehouseSchema),
      refusals: refusals(401, 403, 404),
    },
    validate(getWarehouseSchema),
    controller.getWarehouse,
  );
  routes.post(
    '/warehouses',
    {
      summary: 'Створити склад',
      description:
        'Потребує дозволу `warehouse:write`. Код нормалізується до верхнього регістру. ' +
        'Помилки: 409 `WAREHOUSE_CODE_TAKEN`.',
      response: created('Склад створено', warehouseSchema),
      refusals: refusals(401, 403, 409),
    },
    validate(createWarehouseSchema),
    controller.createWarehouse,
  );
  routes.patch(
    '/warehouses/:id',
    {
      summary: 'Оновити склад',
      description:
        'Потребує дозволу `warehouse:write`. Код незмінний: значення, відмінне від поточного, ' +
        'дає 400 `WAREHOUSE_CODE_IMMUTABLE`. Помилки: 404 `WAREHOUSE_NOT_FOUND`.',
      response: ok('Склад оновлено', warehouseSchema),
      refusals: refusals(401, 403, 404),
    },
    validate(updateWarehouseSchema),
    controller.updateWarehouse,
  );

  routes.get(
    '/stock',
    {
      tags: ['Stock'],
      summary: 'Переглянути рівні запасів',
      description: 'Потребує дозволу `warehouse:read`.',
      response: ok('Сторінка рівнів запасів', pageOf(stockLevelSchema)),
      refusals: refusals(401, 403),
    },
    validate(listStockSchema),
    controller.listStock,
  );
  routes.get(
    '/stock/:warehouseId/:productId',
    {
      tags: ['Stock'],
      summary: 'Отримати рівень запасів позиції на складі',
      description: 'Потребує дозволу `warehouse:read`. Помилки: 404 `STOCK_LEVEL_NOT_FOUND`.',
      response: ok('Рівень запасів', stockLevelSchema),
      refusals: refusals(401, 403, 404),
    },
    validate(getStockSchema),
    controller.getStock,
  );
  routes.post(
    '/stock/receive',
    stockOperation('Оприбуткувати запас', 'Збільшує залишок на складі й записує рух типу RECEIPT.'),
    validate(receiveStockSchema),
    controller.receive,
  );
  routes.post(
    '/stock/issue',
    stockOperation(
      'Списати запас',
      'Зменшує залишок і записує рух типу ISSUE. З `fromReservation: true` водночас ' +
        'зменшується резерв, і тоді `referenceType` та `referenceId` обовʼязкові. ' +
        'Брак залишку — 409 `INSUFFICIENT_STOCK`, брак резерву — 409 ' +
        '`INSUFFICIENT_RESERVATION`.',
    ),
    validate(issueStockSchema),
    controller.issue,
  );
  routes.post(
    '/stock/reserve',
    stockOperation(
      'Зарезервувати запас',
      'Збільшує резерв і записує рух типу RESERVATION. Резерв завжди привʼязаний до ' +
        'зовнішнього обʼєкта, тому посилання обовʼязкове. Брак доступного залишку — ' +
        '409 `INSUFFICIENT_STOCK`.',
    ),
    validate(reserveStockSchema),
    controller.reserve,
  );
  routes.post(
    '/stock/release',
    stockOperation(
      'Зняти резерв',
      'Зменшує резерв і записує рух типу RELEASE. Спроба зняти більше, ніж зарезервовано, — ' +
        '409 `INSUFFICIENT_RESERVATION`.',
    ),
    validate(releaseStockSchema),
    controller.release,
  );
  routes.post(
    '/stock/adjust',
    stockOperation(
      'Скоригувати запас',
      'Записує знакову корекцію (рух типу ADJUSTMENT). `delta` не може бути нулем ' +
        '(400 `INVALID_STOCK_ADJUSTMENT`), `note` обовʼязковий ' +
        '(400 `STOCK_ADJUSTMENT_NOTE_REQUIRED`). Корекція в мінус нижче наявного залишку — ' +
        '409 `INSUFFICIENT_STOCK`.',
    ),
    validate(adjustStockSchema),
    controller.adjust,
  );

  routes.get(
    '/movements',
    {
      tags: ['Stock movements'],
      summary: 'Переглянути журнал рухів запасів',
      description:
        'Потребує дозволу `warehouse:read`. Журнал доповнюваний: змінити або видалити рух ' +
        'неможливо. `createdFrom` не може бути пізніше за `createdTo`.',
      response: ok('Сторінка рухів запасів', pageOf(stockMovementSchema)),
      refusals: refusals(401, 403),
    },
    validate(listMovementsSchema),
    controller.listMovements,
  );

  return router;
};
