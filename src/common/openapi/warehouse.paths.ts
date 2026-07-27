import {
  dataResponse,
  errorRef,
  idParameter,
  jsonBody,
  pageParameters20,
  pageResponse,
  securedErrors,
  securedOperation,
} from './helpers.js';

const uuidSchema = { type: 'string', format: 'uuid' };
const quantitySchema = { type: 'integer', minimum: 1, maximum: 1000000000 };
const noteSchema = { type: 'string', minLength: 1, maxLength: 255 };
const referenceTypeSchema = { type: 'string', minLength: 1, maxLength: 64 };

const stockTargetProperties = {
  warehouseId: uuidSchema,
  productId: uuidSchema,
};

const stockLevelResponse = (description: string): Record<string, unknown> =>
  dataResponse(description, { $ref: '#/components/schemas/StockLevel' });

// Every stock write goes through the same optimistic-locking retry loop.
const stockWriteErrors =
  'Помилки: 404 `WAREHOUSE_NOT_FOUND`, `PRODUCT_NOT_FOUND`; 409 `WAREHOUSE_INACTIVE`, ' +
  '`STOCK_CONCURRENT_MODIFICATION` — рівень запасів змінив паралельний запит, операцію ' +
  'треба повторити.';

const stockOperation = (
  summary: string,
  description: string,
  body: object,
): Record<string, unknown> => ({
  ...securedOperation,
  tags: ['Stock'],
  summary,
  description: `Потребує дозволу \`warehouse:write\`. ${description} ${stockWriteErrors}`,
  requestBody: jsonBody(body),
  responses: {
    // The stock level is updated in place, so the operation answers 200 with
    // the modified resource rather than 201.
    '200': stockLevelResponse('Рух записано; повертається новий рівень запасів'),
    ...securedErrors,
    '404': errorRef('NotFound'),
    '409': errorRef('Conflict'),
  },
});

const reservationBody = {
  type: 'object',
  required: ['warehouseId', 'productId', 'quantity', 'referenceType', 'referenceId'],
  properties: {
    ...stockTargetProperties,
    quantity: quantitySchema,
    referenceType: referenceTypeSchema,
    referenceId: uuidSchema,
    note: noteSchema,
  },
};

export const warehousePaths = {
  '/api/v1/warehouse/warehouses': {
    get: {
      ...securedOperation,
      tags: ['Warehouses'],
      summary: 'Переглянути склади',
      description: 'Потребує дозволу `warehouse:read`.',
      parameters: [
        ...pageParameters20,
        { name: 'search', in: 'query', schema: { type: 'string', minLength: 1, maxLength: 120 } },
        { name: 'isActive', in: 'query', schema: { type: 'boolean' } },
      ],
      responses: {
        '200': pageResponse('Сторінка складів', { $ref: '#/components/schemas/Warehouse' }),
        ...securedErrors,
      },
    },
    post: {
      ...securedOperation,
      tags: ['Warehouses'],
      summary: 'Створити склад',
      description:
        'Потребує дозволу `warehouse:write`. Код нормалізується до верхнього регістру. ' +
        'Помилки: 409 `WAREHOUSE_CODE_TAKEN`.',
      requestBody: jsonBody({
        type: 'object',
        required: ['code', 'name'],
        properties: {
          code: {
            type: 'string',
            minLength: 2,
            maxLength: 32,
            pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$',
          },
          name: { type: 'string', minLength: 1, maxLength: 120 },
          isActive: { type: 'boolean' },
        },
      }),
      responses: {
        '201': dataResponse('Склад створено', { $ref: '#/components/schemas/Warehouse' }),
        ...securedErrors,
        '409': errorRef('Conflict'),
      },
    },
  },
  '/api/v1/warehouse/warehouses/{id}': {
    get: {
      ...securedOperation,
      tags: ['Warehouses'],
      summary: 'Отримати склад',
      description: 'Потребує дозволу `warehouse:read`. Помилки: 404 `WAREHOUSE_NOT_FOUND`.',
      parameters: [idParameter],
      responses: {
        '200': dataResponse('Склад', { $ref: '#/components/schemas/Warehouse' }),
        ...securedErrors,
        '404': errorRef('NotFound'),
      },
    },
    patch: {
      ...securedOperation,
      tags: ['Warehouses'],
      summary: 'Оновити склад',
      description:
        'Потребує дозволу `warehouse:write`. Код незмінний: значення, відмінне від поточного, ' +
        'дає 400 `WAREHOUSE_CODE_IMMUTABLE`. Помилки: 404 `WAREHOUSE_NOT_FOUND`.',
      parameters: [idParameter],
      requestBody: jsonBody({
        type: 'object',
        minProperties: 1,
        properties: {
          code: {
            type: 'string',
            minLength: 2,
            maxLength: 32,
            pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$',
          },
          name: { type: 'string', minLength: 1, maxLength: 120 },
          isActive: { type: 'boolean' },
        },
      }),
      responses: {
        '200': dataResponse('Склад оновлено', { $ref: '#/components/schemas/Warehouse' }),
        ...securedErrors,
        '404': errorRef('NotFound'),
      },
    },
  },
  '/api/v1/warehouse/stock': {
    get: {
      ...securedOperation,
      tags: ['Stock'],
      summary: 'Переглянути рівні запасів',
      description: 'Потребує дозволу `warehouse:read`.',
      parameters: [
        ...pageParameters20,
        { name: 'warehouseId', in: 'query', schema: uuidSchema },
        { name: 'productId', in: 'query', schema: uuidSchema },
        {
          name: 'lowStockThreshold',
          in: 'query',
          description: 'Залишає лише позиції, де залишок не перевищує це значення.',
          schema: { type: 'integer', minimum: 0 },
        },
      ],
      responses: {
        '200': pageResponse('Сторінка рівнів запасів', {
          $ref: '#/components/schemas/StockLevel',
        }),
        ...securedErrors,
      },
    },
  },
  '/api/v1/warehouse/stock/{warehouseId}/{productId}': {
    get: {
      ...securedOperation,
      tags: ['Stock'],
      summary: 'Отримати рівень запасів позиції на складі',
      description: 'Потребує дозволу `warehouse:read`. Помилки: 404 `STOCK_LEVEL_NOT_FOUND`.',
      parameters: [
        { name: 'warehouseId', in: 'path', required: true, schema: uuidSchema },
        { name: 'productId', in: 'path', required: true, schema: uuidSchema },
      ],
      responses: {
        '200': stockLevelResponse('Рівень запасів'),
        ...securedErrors,
        '404': errorRef('NotFound'),
      },
    },
  },
  '/api/v1/warehouse/stock/receive': {
    post: stockOperation(
      'Оприбуткувати запас',
      'Збільшує залишок на складі й записує рух типу RECEIPT.',
      {
        type: 'object',
        required: ['warehouseId', 'productId', 'quantity'],
        properties: {
          ...stockTargetProperties,
          quantity: quantitySchema,
          referenceType: referenceTypeSchema,
          referenceId: uuidSchema,
          note: noteSchema,
        },
      },
    ),
  },
  '/api/v1/warehouse/stock/issue': {
    post: stockOperation(
      'Списати запас',
      'Зменшує залишок і записує рух типу ISSUE. З `fromReservation: true` водночас ' +
        'зменшується резерв, і тоді `referenceType` та `referenceId` обовʼязкові. ' +
        'Брак залишку — 409 `INSUFFICIENT_STOCK`, брак резерву — 409 ' +
        '`INSUFFICIENT_RESERVATION`.',
      {
        type: 'object',
        required: ['warehouseId', 'productId', 'quantity'],
        properties: {
          ...stockTargetProperties,
          quantity: quantitySchema,
          fromReservation: { type: 'boolean' },
          referenceType: referenceTypeSchema,
          referenceId: uuidSchema,
          note: noteSchema,
        },
      },
    ),
  },
  '/api/v1/warehouse/stock/reserve': {
    post: stockOperation(
      'Зарезервувати запас',
      'Збільшує резерв і записує рух типу RESERVATION. Резерв завжди привʼязаний до ' +
        'зовнішнього обʼєкта, тому посилання обовʼязкове. Брак доступного залишку — ' +
        '409 `INSUFFICIENT_STOCK`.',
      reservationBody,
    ),
  },
  '/api/v1/warehouse/stock/release': {
    post: stockOperation(
      'Зняти резерв',
      'Зменшує резерв і записує рух типу RELEASE. Спроба зняти більше, ніж зарезервовано, — ' +
        '409 `INSUFFICIENT_RESERVATION`.',
      reservationBody,
    ),
  },
  '/api/v1/warehouse/stock/adjust': {
    post: stockOperation(
      'Скоригувати запас',
      'Записує знакову корекцію (рух типу ADJUSTMENT). `delta` не може бути нулем ' +
        '(400 `INVALID_STOCK_ADJUSTMENT`), `note` обовʼязковий ' +
        '(400 `STOCK_ADJUSTMENT_NOTE_REQUIRED`). Корекція в мінус нижче наявного залишку — ' +
        '409 `INSUFFICIENT_STOCK`.',
      {
        type: 'object',
        required: ['warehouseId', 'productId', 'delta', 'note'],
        properties: {
          ...stockTargetProperties,
          delta: { type: 'integer', description: 'Знакова корекція; нуль не приймається.' },
          note: noteSchema,
          referenceType: referenceTypeSchema,
          referenceId: uuidSchema,
        },
      },
    ),
  },
  '/api/v1/warehouse/movements': {
    get: {
      ...securedOperation,
      tags: ['Stock movements'],
      summary: 'Переглянути журнал рухів запасів',
      description:
        'Потребує дозволу `warehouse:read`. Журнал доповнюваний: змінити або видалити рух ' +
        'неможливо. `createdFrom` не може бути пізніше за `createdTo`.',
      parameters: [
        ...pageParameters20,
        { name: 'warehouseId', in: 'query', schema: uuidSchema },
        { name: 'productId', in: 'query', schema: uuidSchema },
        { name: 'type', in: 'query', schema: { $ref: '#/components/schemas/StockMovementType' } },
        { name: 'referenceType', in: 'query', schema: referenceTypeSchema },
        { name: 'referenceId', in: 'query', schema: uuidSchema },
        { name: 'createdFrom', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'createdTo', in: 'query', schema: { type: 'string', format: 'date-time' } },
      ],
      responses: {
        '200': pageResponse('Сторінка рухів запасів', {
          $ref: '#/components/schemas/StockMovement',
        }),
        ...securedErrors,
      },
    },
  },
} as const;
