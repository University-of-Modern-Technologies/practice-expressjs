import {
  dataResponse,
  errorRef,
  idParameter,
  jsonBody,
  noContentResponse,
  pageParameters20,
  pageResponse,
  securedErrors,
  securedOperation,
} from './helpers.js';

const moneySchema = { type: 'string', pattern: '^\\d{1,12}(?:\\.\\d{1,2})?$' };
const currencySchema = { type: 'string', pattern: '^[A-Za-z]{3}$' };
const versionSchema = { type: 'integer', minimum: 1 };
const quantitySchema = { type: 'integer', minimum: 1, maximum: 1000000 };
const itemIdParameter = {
  name: 'itemId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};
const versionQueryParameter = {
  name: 'version',
  in: 'query',
  required: true,
  schema: versionSchema,
};

const orderResponse = (description: string): Record<string, unknown> =>
  dataResponse(description, { $ref: '#/components/schemas/Order' });

const orderQueryParameters = [
  ...pageParameters20,
  { name: 'search', in: 'query', schema: { type: 'string', minLength: 1, maxLength: 64 } },
  { name: 'ownerId', in: 'query', schema: { type: 'string', format: 'uuid' } },
  { name: 'contactId', in: 'query', schema: { type: 'string', format: 'uuid' } },
  { name: 'dealId', in: 'query', schema: { type: 'string', format: 'uuid' } },
  { name: 'status', in: 'query', schema: { $ref: '#/components/schemas/OrderStatus' } },
  { name: 'minTotal', in: 'query', schema: moneySchema },
  { name: 'maxTotal', in: 'query', schema: moneySchema },
  {
    name: 'sortBy',
    in: 'query',
    schema: {
      type: 'string',
      enum: ['createdAt', 'updatedAt', 'orderNumber', 'total', 'placedAt', 'status'],
      default: 'createdAt',
    },
  },
  {
    name: 'sortOrder',
    in: 'query',
    schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
  },
];

// Repeated in the description of every write route that carries a `version`.
const concurrencyNote =
  '`version` обовʼязковий: розбіжність із поточною версією дає 409 ' +
  '`ORDER_CONCURRENT_MODIFICATION`.';
const draftNote =
  'Рядки та грошові поля змінюються лише поки замовлення в статусі DRAFT, інакше 409 ' +
  '`ORDER_NOT_EDITABLE`.';

export const ordersPaths = {
  '/api/v1/orders': {
    get: {
      ...securedOperation,
      tags: ['Orders'],
      summary: 'Переглянути замовлення',
      description:
        'Потребує дозволу `orders:read`. Зі scope `OWN` видно лише власні замовлення. ' +
        '`minTotal` не може перевищувати `maxTotal`.',
      parameters: orderQueryParameters,
      responses: {
        '200': pageResponse('Сторінка замовлень', { $ref: '#/components/schemas/Order' }),
        ...securedErrors,
      },
    },
    post: {
      ...securedOperation,
      tags: ['Orders'],
      summary: 'Створити замовлення',
      description:
        'Потребує дозволу `orders:write`. Номер, статус і суми обчислює сервер: замовлення ' +
        'створюється у статусі DRAFT. Помилки: 404 `CONTACT_NOT_FOUND`, `DEAL_NOT_FOUND`, ' +
        '`PRODUCT_NOT_FOUND`; 409 `PRODUCT_INACTIVE`, `ORDER_CURRENCY_MISMATCH`, ' +
        '`ORDER_ITEM_DUPLICATE`, `ORDER_NUMBER_UNAVAILABLE`.',
      requestBody: jsonBody({
        type: 'object',
        properties: {
          ownerId: { type: 'string', format: 'uuid' },
          contactId: { type: 'string', format: 'uuid' },
          dealId: { type: 'string', format: 'uuid' },
          currency: currencySchema,
          discountTotal: moneySchema,
          taxTotal: moneySchema,
          notes: { type: 'string', maxLength: 4000 },
          items: {
            type: 'array',
            maxItems: 200,
            description: 'Кожен товар може зустрічатися в замовленні лише раз.',
            items: {
              type: 'object',
              required: ['productId', 'quantity'],
              properties: {
                productId: { type: 'string', format: 'uuid' },
                quantity: quantitySchema,
              },
            },
          },
        },
      }),
      responses: {
        '201': orderResponse('Замовлення створено'),
        ...securedErrors,
        '404': errorRef('NotFound'),
        '409': errorRef('Conflict'),
      },
    },
  },
  '/api/v1/orders/{id}/duplicate': {
    post: {
      ...securedOperation,
      tags: ['Orders'],
      summary: 'Повторити замовлення',
      description:
        'Потребує дозволу `orders:write` (те саме, що й на створення). Тіла запиту немає. ' +
        'Нове замовлення створюється у статусі DRAFT з власним номером і нульовою версією ' +
        'історії: контакт, власник і валюта копіюються з джерела, а рядки перецінюються за ' +
        'поточним каталогом, а не за ціною джерела. Джерело може бути в будь-якому статусі. ' +
        'Помилки: 404 `ORDER_NOT_FOUND`; 409 `PRODUCT_INACTIVE`, `ORDER_CURRENCY_MISMATCH`.',
      parameters: [idParameter],
      responses: {
        '201': orderResponse('Замовлення продубльовано'),
        ...securedErrors,
        '404': errorRef('NotFound'),
        '409': errorRef('Conflict'),
      },
    },
  },
  '/api/v1/orders/{id}': {
    get: {
      ...securedOperation,
      tags: ['Orders'],
      summary: 'Отримати замовлення разом із рядками',
      description: 'Потребує дозволу `orders:read`. Помилки: 404 `ORDER_NOT_FOUND`.',
      parameters: [idParameter],
      responses: {
        '200': orderResponse('Замовлення'),
        ...securedErrors,
        '404': errorRef('NotFound'),
      },
    },
    patch: {
      ...securedOperation,
      tags: ['Orders'],
      summary: 'Оновити реквізити замовлення',
      description:
        'Потребує дозволу `orders:write`. Статус, номер і суми не приймаються від клієнта. ' +
        `${concurrencyNote} ${draftNote} ` +
        'Помилки: 404 `ORDER_NOT_FOUND`, `CONTACT_NOT_FOUND`, `DEAL_NOT_FOUND`; ' +
        '409 `ORDER_CURRENCY_MISMATCH`.',
      parameters: [idParameter],
      requestBody: jsonBody({
        type: 'object',
        required: ['version'],
        minProperties: 2,
        properties: {
          version: versionSchema,
          ownerId: { type: 'string', format: 'uuid' },
          contactId: { type: 'string', format: 'uuid', nullable: true },
          dealId: { type: 'string', format: 'uuid', nullable: true },
          currency: currencySchema,
          discountTotal: moneySchema,
          taxTotal: moneySchema,
          notes: { type: 'string', maxLength: 4000, nullable: true },
        },
      }),
      responses: {
        '200': orderResponse('Замовлення оновлено'),
        ...securedErrors,
        '404': errorRef('NotFound'),
        '409': errorRef('Conflict'),
      },
    },
    delete: {
      ...securedOperation,
      tags: ['Orders'],
      summary: 'Видалити замовлення',
      description: `Потребує дозволу \`orders:delete\`. Мʼяке видалення. ${concurrencyNote}`,
      parameters: [idParameter, versionQueryParameter],
      responses: {
        '204': noContentResponse('Замовлення видалено'),
        ...securedErrors,
        '404': errorRef('NotFound'),
        '409': errorRef('Conflict'),
      },
    },
  },
  '/api/v1/orders/{id}/items': {
    post: {
      ...securedOperation,
      tags: ['Order items'],
      summary: 'Додати рядок до замовлення',
      description:
        'Потребує дозволу `orders:write`. Ціна й назва фіксуються знімком каталогу. ' +
        `${concurrencyNote} ${draftNote} ` +
        'Помилки: 404 `ORDER_NOT_FOUND`, `PRODUCT_NOT_FOUND`; 409 `ORDER_ITEM_DUPLICATE`, ' +
        '`PRODUCT_INACTIVE`, `ORDER_CURRENCY_MISMATCH`.',
      parameters: [idParameter],
      requestBody: jsonBody({
        type: 'object',
        required: ['version', 'productId', 'quantity'],
        properties: {
          version: versionSchema,
          productId: { type: 'string', format: 'uuid' },
          quantity: quantitySchema,
        },
      }),
      responses: {
        '201': orderResponse('Рядок додано; повертається все замовлення'),
        ...securedErrors,
        '404': errorRef('NotFound'),
        '409': errorRef('Conflict'),
      },
    },
  },
  '/api/v1/orders/{id}/items/{itemId}': {
    patch: {
      ...securedOperation,
      tags: ['Order items'],
      summary: 'Змінити кількість у рядку',
      description:
        'Потребує дозволу `orders:write`. ' +
        `${concurrencyNote} ${draftNote} ` +
        'Помилки: 404 `ORDER_NOT_FOUND`, `ORDER_ITEM_NOT_FOUND`.',
      parameters: [idParameter, itemIdParameter],
      requestBody: jsonBody({
        type: 'object',
        required: ['version', 'quantity'],
        properties: { version: versionSchema, quantity: quantitySchema },
      }),
      responses: {
        '200': orderResponse('Рядок оновлено; повертається все замовлення'),
        ...securedErrors,
        '404': errorRef('NotFound'),
        '409': errorRef('Conflict'),
      },
    },
    delete: {
      ...securedOperation,
      tags: ['Order items'],
      summary: 'Вилучити рядок із замовлення',
      description:
        'Потребує дозволу `orders:write`. ' +
        `${concurrencyNote} ${draftNote} ` +
        'Помилки: 404 `ORDER_NOT_FOUND`, `ORDER_ITEM_NOT_FOUND`.',
      parameters: [idParameter, itemIdParameter, versionQueryParameter],
      responses: {
        '200': orderResponse('Рядок вилучено; повертається все замовлення'),
        ...securedErrors,
        '404': errorRef('NotFound'),
        '409': errorRef('Conflict'),
      },
    },
  },
  '/api/v1/orders/{id}/transitions': {
    post: {
      ...securedOperation,
      tags: ['Order transitions'],
      summary: 'Перевести замовлення в інший статус',
      description:
        'Потребує дозволу `orders:write`. Дозволені переходи: DRAFT → CONFIRMED/CANCELLED, ' +
        'CONFIRMED → PAID/CANCELLED, PAID → FULFILLED/CANCELLED; FULFILLED і CANCELLED — ' +
        `кінцеві. ${concurrencyNote} Помилки: 404 \`ORDER_NOT_FOUND\`; ` +
        '409 `INVALID_ORDER_STATUS_TRANSITION`, `ORDER_HAS_NO_ITEMS`.',
      parameters: [idParameter],
      requestBody: jsonBody({
        type: 'object',
        required: ['version', 'status'],
        properties: {
          version: versionSchema,
          status: { $ref: '#/components/schemas/OrderStatus' },
        },
      }),
      responses: {
        '200': orderResponse('Статус замовлення змінено'),
        ...securedErrors,
        '404': errorRef('NotFound'),
        '409': errorRef('Conflict'),
      },
    },
  },
} as const;
