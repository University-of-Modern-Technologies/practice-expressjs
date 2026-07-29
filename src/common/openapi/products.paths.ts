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

const priceSchema = { type: 'string', pattern: '^\\d{1,12}(?:\\.\\d{1,2})?$' };
const currencySchema = { type: 'string', pattern: '^[A-Za-z]{3}$' };
const versionSchema = { type: 'integer', minimum: 1 };

const productQueryParameters = [
  ...pageParameters20,
  { name: 'search', in: 'query', schema: { type: 'string', minLength: 1, maxLength: 160 } },
  { name: 'category', in: 'query', schema: { type: 'string', minLength: 1, maxLength: 80 } },
  { name: 'isActive', in: 'query', schema: { type: 'boolean' } },
  { name: 'minPrice', in: 'query', schema: priceSchema },
  { name: 'maxPrice', in: 'query', schema: priceSchema },
  {
    name: 'sortBy',
    in: 'query',
    schema: {
      type: 'string',
      enum: ['createdAt', 'updatedAt', 'name', 'sku', 'unitPrice', 'category'],
      default: 'createdAt',
    },
  },
  {
    name: 'sortOrder',
    in: 'query',
    schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
  },
];

export const productsPaths = {
  '/api/v1/products': {
    get: {
      ...securedOperation,
      tags: ['Products'],
      summary: 'Переглянути каталог товарів',
      description: 'Потребує дозволу `products:read`. `minPrice` не може перевищувати `maxPrice`.',
      parameters: productQueryParameters,
      responses: {
        '200': pageResponse('Сторінка товарів', { $ref: '#/components/schemas/Product' }),
        ...securedErrors,
      },
    },
    post: {
      ...securedOperation,
      tags: ['Products'],
      summary: 'Створити товар',
      description:
        'Потребує дозволу `products:write`. SKU нормалізується до верхнього регістру. ' +
        'Помилки: 409 `PRODUCT_SKU_TAKEN`, 400 `INVALID_PRODUCT_PRICE`.',
      requestBody: jsonBody({
        type: 'object',
        required: ['sku', 'name', 'unitPrice'],
        properties: {
          sku: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
            pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
          },
          name: { type: 'string', minLength: 1, maxLength: 160 },
          description: { type: 'string', maxLength: 4000 },
          category: { type: 'string', minLength: 1, maxLength: 80 },
          unitPrice: priceSchema,
          currency: currencySchema,
          isActive: { type: 'boolean' },
        },
      }),
      responses: {
        '201': dataResponse('Товар створено', { $ref: '#/components/schemas/Product' }),
        ...securedErrors,
        '409': errorRef('Conflict'),
      },
    },
  },
  '/api/v1/products/{id}': {
    get: {
      ...securedOperation,
      tags: ['Products'],
      summary: 'Отримати товар',
      description: 'Потребує дозволу `products:read`. Помилки: 404 `PRODUCT_NOT_FOUND`.',
      parameters: [idParameter],
      responses: {
        '200': dataResponse('Товар', { $ref: '#/components/schemas/Product' }),
        ...securedErrors,
        '404': errorRef('NotFound'),
      },
    },
    patch: {
      ...securedOperation,
      tags: ['Products'],
      summary: 'Оновити товар',
      description:
        'Потребує дозволу `products:write`. `version` обовʼязковий: якщо він не збігається з ' +
        'поточним, повертається 409 `PRODUCT_CONCURRENT_MODIFICATION`. SKU незмінний і не ' +
        'приймається. Помилки: 404 `PRODUCT_NOT_FOUND`, 409 `PRODUCT_SKU_TAKEN`, ' +
        '400 `INVALID_PRODUCT_PRICE`.',
      parameters: [idParameter],
      requestBody: jsonBody({
        type: 'object',
        required: ['version'],
        minProperties: 2,
        properties: {
          version: versionSchema,
          name: { type: 'string', minLength: 1, maxLength: 160 },
          description: { type: 'string', maxLength: 4000, nullable: true },
          category: { type: 'string', minLength: 1, maxLength: 80, nullable: true },
          unitPrice: priceSchema,
          currency: currencySchema,
          isActive: { type: 'boolean' },
        },
      }),
      responses: {
        '200': dataResponse('Товар оновлено', { $ref: '#/components/schemas/Product' }),
        ...securedErrors,
        '404': errorRef('NotFound'),
        '409': errorRef('Conflict'),
      },
    },
    delete: {
      ...securedOperation,
      tags: ['Products'],
      summary: 'Видалити товар',
      description:
        'Потребує дозволу `products:delete`. Мʼяке видалення. `version` обовʼязковий: ' +
        'розбіжність версій дає 409 `PRODUCT_CONCURRENT_MODIFICATION`.',
      parameters: [
        idParameter,
        { name: 'version', in: 'query', required: true, schema: versionSchema },
      ],
      responses: {
        '204': noContentResponse('Товар видалено'),
        ...securedErrors,
        '404': errorRef('NotFound'),
        '409': errorRef('Conflict'),
      },
    },
  },
} as const;
