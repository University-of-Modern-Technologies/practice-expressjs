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
import type { OrdersController } from './controller.js';
import { orderSchema } from './types.js';
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

// Repeated in the description of every write route that carries a `version`.
const concurrencyNote =
  '`version` обовʼязковий: розбіжність із поточною версією дає 409 ' +
  '`ORDER_CONCURRENT_MODIFICATION`.';
const draftNote =
  'Рядки та грошові поля змінюються лише поки замовлення в статусі DRAFT, інакше 409 ' +
  '`ORDER_NOT_EDITABLE`.';
const capNote = 'Якщо після зміни рядків знижка перевищила б підсумок, її зменшено до підсумку.';
const amountNote =
  '400 `ORDER_AMOUNT_OUT_OF_RANGE` — сума рядка, підсумок або разом перевищили б ' +
  '999999999999.99.';

export const createOrdersRouter = (
  controller: OrdersController,
  authenticate: RequestHandler,
): Router => {
  const router = Router();
  router.use(authenticate);
  const routes = describeRoutes(router, [
    { name: 'Orders', description: 'Замовлення' },
    { name: 'Order items', description: 'Рядки замовлення' },
    { name: 'Order transitions', description: 'Переходи замовлень між статусами' },
  ]);

  routes.get(
    '/',
    {
      summary: 'Переглянути замовлення',
      description:
        'Потребує дозволу `orders:read`. Зі scope `OWN` видно лише власні замовлення. ' +
        '`minTotal` не може перевищувати `maxTotal`.',
      response: ok('Сторінка замовлень', pageOf(orderSchema)),
      refusals: refusals(401, 403),
    },
    controller.authorize.read,
    validate(listOrdersSchema),
    controller.list,
  );
  routes.get(
    '/:id',
    {
      summary: 'Отримати замовлення разом із рядками',
      description: 'Потребує дозволу `orders:read`. Помилки: 404 `ORDER_NOT_FOUND`.',
      response: ok('Замовлення', orderSchema),
      refusals: refusals(401, 403, 404),
    },
    controller.authorize.read,
    validate(getOrderSchema),
    controller.getById,
  );
  routes.post(
    '/',
    {
      summary: 'Створити замовлення',
      description:
        'Потребує дозволу `orders:write`. Номер, статус і суми обчислює сервер: замовлення ' +
        'створюється у статусі DRAFT. Власник — наявний активний користувач. ' +
        'Помилки: 404 `CONTACT_NOT_FOUND`, `DEAL_NOT_FOUND`, ' +
        '`PRODUCT_NOT_FOUND`, `ORDER_OWNER_NOT_FOUND`; 409 `PRODUCT_INACTIVE`, ' +
        '`ORDER_CURRENCY_MISMATCH`, `ORDER_ITEM_DUPLICATE`, `ORDER_NUMBER_UNAVAILABLE`; ' +
        `400 \`ORDER_TOTALS_INVALID\` — знижка більша за підсумок; ${amountNote}`,
      response: created('Замовлення створено', orderSchema),
      refusals: refusals(401, 403, 404, 409),
    },
    controller.authorize.write,
    validate(createOrderSchema),
    controller.create,
  );
  routes.post(
    '/:id/duplicate',
    {
      summary: 'Повторити замовлення',
      description:
        'Потребує дозволу `orders:write` (те саме, що й на створення). Тіла запиту немає. ' +
        'Нове замовлення створюється у статусі DRAFT з власним номером і нульовою версією ' +
        'історії: контакт, власник і валюта копіюються з джерела, а рядки перецінюються за ' +
        'поточним каталогом, а не за ціною джерела. Джерело може бути в будь-якому статусі. ' +
        'Помилки: 404 `ORDER_NOT_FOUND`; 409 `PRODUCT_INACTIVE`, `ORDER_CURRENCY_MISMATCH`.',
      response: created('Замовлення продубльовано', orderSchema),
      refusals: refusals(401, 403, 404, 409),
    },
    controller.authorize.write,
    validate(duplicateOrderSchema),
    controller.duplicate,
  );
  routes.patch(
    '/:id',
    {
      summary: 'Оновити реквізити замовлення',
      description:
        'Потребує дозволу `orders:write`. Статус, номер і суми не приймаються від клієнта. ' +
        `${concurrencyNote} ${draftNote} ` +
        'Помилки: 404 `ORDER_NOT_FOUND`, `CONTACT_NOT_FOUND`, `DEAL_NOT_FOUND`, ' +
        '`ORDER_OWNER_NOT_FOUND`; 409 `ORDER_CURRENCY_MISMATCH`; 400 `ORDER_TOTALS_INVALID` — ' +
        'надіслана знижка більша за підсумок.',
      response: ok('Замовлення оновлено', orderSchema),
      refusals: refusals(401, 403, 404, 409),
    },
    controller.authorize.write,
    validate(updateOrderSchema),
    controller.update,
  );
  routes.post(
    '/:id/items',
    {
      tags: ['Order items'],
      summary: 'Додати рядок до замовлення',
      description:
        'Потребує дозволу `orders:write`. Ціна й назва фіксуються знімком каталогу. ' +
        `${concurrencyNote} ${draftNote} ` +
        'Помилки: 404 `ORDER_NOT_FOUND`, `PRODUCT_NOT_FOUND`; 409 `ORDER_ITEM_DUPLICATE` ' +
        '(перевіряється раніше за стан товару в каталозі), `PRODUCT_INACTIVE`, ' +
        `\`ORDER_CURRENCY_MISMATCH\`; ${amountNote}`,
      response: created('Рядок додано; повертається все замовлення', orderSchema),
      refusals: refusals(401, 403, 404, 409),
    },
    controller.authorize.write,
    validate(addOrderItemSchema),
    controller.addItem,
  );
  routes.patch(
    '/:id/items/:itemId',
    {
      tags: ['Order items'],
      summary: 'Змінити кількість у рядку',
      description:
        'Потребує дозволу `orders:write`. ' +
        `${concurrencyNote} ${draftNote} ` +
        `${capNote} Помилки: 404 \`ORDER_NOT_FOUND\`, \`ORDER_ITEM_NOT_FOUND\`; ${amountNote}`,
      response: ok('Рядок оновлено; повертається все замовлення', orderSchema),
      refusals: refusals(401, 403, 404, 409),
    },
    controller.authorize.write,
    validate(updateOrderItemSchema),
    controller.updateItem,
  );
  routes.delete(
    '/:id/items/:itemId',
    {
      tags: ['Order items'],
      summary: 'Вилучити рядок із замовлення',
      description:
        'Потребує дозволу `orders:write`. ' +
        `${concurrencyNote} ${draftNote} ` +
        `${capNote} Помилки: 404 \`ORDER_NOT_FOUND\`, \`ORDER_ITEM_NOT_FOUND\`.`,
      response: ok('Рядок вилучено; повертається все замовлення', orderSchema),
      refusals: refusals(401, 403, 404, 409),
    },
    controller.authorize.write,
    validate(removeOrderItemSchema),
    controller.removeItem,
  );
  // The status is server-owned: it is never settable through a plain update.
  routes.post(
    '/:id/transitions',
    {
      tags: ['Order transitions'],
      summary: 'Перевести замовлення в інший статус',
      description:
        'Потребує дозволу `orders:write`. Дозволені переходи: DRAFT → CONFIRMED/CANCELLED, ' +
        'CONFIRMED → PAID/CANCELLED, PAID → FULFILLED/CANCELLED; FULFILLED і CANCELLED — ' +
        'кінцеві. Підтвердити можна лише чернетку з рядками; скасувати — і порожню. ' +
        `${concurrencyNote} Помилки: 404 \`ORDER_NOT_FOUND\`; ` +
        '409 `INVALID_ORDER_STATUS_TRANSITION`, `ORDER_HAS_NO_ITEMS`.',
      response: ok('Статус замовлення змінено', orderSchema),
      refusals: refusals(401, 403, 404, 409),
    },
    controller.authorize.write,
    validate(transitionOrderSchema),
    controller.transition,
  );
  routes.delete(
    '/:id',
    {
      summary: 'Видалити замовлення',
      description: `Потребує дозволу \`orders:delete\`. Мʼяке видалення. ${concurrencyNote}`,
      response: noContent('Замовлення видалено'),
      refusals: refusals(401, 403, 404, 409),
    },
    controller.authorize.delete,
    validate(deleteOrderSchema),
    controller.delete,
  );
  return router;
};
