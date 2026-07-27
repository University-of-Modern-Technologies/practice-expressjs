import {
  dataResponse,
  errorRef,
  idParameter,
  jsonBody,
  noContentResponse,
  pageParameters20,
  securedErrors,
  securedOperation,
} from './helpers.js';

const amountSchema = { type: 'string', pattern: '^\\d{1,12}(?:\\.\\d{1,2})?$' };
const probabilitySchema = { type: 'integer', minimum: 0, maximum: 100 };
const versionSchema = { type: 'integer', minimum: 1 };
const dateOnlySchema = { type: 'string', format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const currencySchema = { type: 'string', pattern: '^[A-Za-z]{3}$' };
const dealWriteProperties = {
  ownerId: { type: 'string', format: 'uuid' },
  contactId: { type: 'string', format: 'uuid', nullable: true },
  title: { type: 'string', minLength: 1, maxLength: 160 },
  amount: amountSchema,
  currency: currencySchema,
  probability: probabilitySchema,
  expectedCloseDate: { ...dateOnlySchema, nullable: true },
};

const dealQueryParameters = [
  ...pageParameters20,
  { name: 'search', in: 'query', schema: { type: 'string', minLength: 1, maxLength: 160 } },
  { name: 'ownerId', in: 'query', schema: { type: 'string', format: 'uuid' } },
  { name: 'contactId', in: 'query', schema: { type: 'string', format: 'uuid' } },
  { name: 'stage', in: 'query', schema: { $ref: '#/components/schemas/DealStage' } },
  { name: 'minAmount', in: 'query', schema: amountSchema },
  { name: 'maxAmount', in: 'query', schema: amountSchema },
  { name: 'minProbability', in: 'query', schema: probabilitySchema },
  { name: 'maxProbability', in: 'query', schema: probabilitySchema },
  { name: 'expectedCloseFrom', in: 'query', schema: dateOnlySchema },
  { name: 'expectedCloseTo', in: 'query', schema: dateOnlySchema },
  {
    name: 'sortBy',
    in: 'query',
    schema: {
      type: 'string',
      enum: ['createdAt', 'updatedAt', 'title', 'amount', 'probability', 'expectedCloseDate'],
      default: 'createdAt',
    },
  },
  {
    name: 'sortOrder',
    in: 'query',
    schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
  },
];

export const dealsPaths = {
  '/api/v1/deals': {
    get: {
      ...securedOperation,
      tags: ['Deals'],
      summary: 'Переглянути угоди',
      parameters: dealQueryParameters,
      responses: {
        '200': dataResponse('Сторінка угод', {
          type: 'object',
          required: ['items', 'page', 'pageSize', 'total'],
          properties: {
            items: { type: 'array', items: { $ref: '#/components/schemas/Deal' } },
            page: { type: 'integer' },
            pageSize: { type: 'integer' },
            total: { type: 'integer' },
          },
        }),
        ...securedErrors,
      },
    },
    post: {
      ...securedOperation,
      tags: ['Deals'],
      summary: 'Створити угоду',
      requestBody: jsonBody({
        type: 'object',
        required: ['title', 'amount'],
        properties: {
          ...dealWriteProperties,
          contactId: { type: 'string', format: 'uuid' },
          expectedCloseDate: dateOnlySchema,
          stage: { type: 'string', enum: ['LEAD'] },
        },
      }),
      responses: {
        '201': dataResponse('Угоду створено', { $ref: '#/components/schemas/Deal' }),
        ...securedErrors,
        '404': errorRef('NotFound'),
      },
    },
  },
  '/api/v1/deals/{id}': {
    get: {
      ...securedOperation,
      tags: ['Deals'],
      summary: 'Отримати угоду',
      parameters: [idParameter],
      responses: {
        '200': dataResponse('Угода', { $ref: '#/components/schemas/Deal' }),
        ...securedErrors,
        '404': errorRef('NotFound'),
      },
    },
    patch: {
      ...securedOperation,
      tags: ['Deals'],
      summary: 'Оновити угоду без зміни stage',
      parameters: [idParameter],
      requestBody: jsonBody({
        type: 'object',
        required: ['version'],
        minProperties: 2,
        properties: { version: versionSchema, ...dealWriteProperties },
      }),
      responses: {
        '200': dataResponse('Угоду оновлено', { $ref: '#/components/schemas/Deal' }),
        ...securedErrors,
        '404': errorRef('NotFound'),
        '409': errorRef('Conflict'),
      },
    },
    delete: {
      ...securedOperation,
      tags: ['Deals'],
      summary: 'Видалити угоду',
      parameters: [
        idParameter,
        { name: 'version', in: 'query', required: true, schema: versionSchema },
      ],
      responses: {
        '204': noContentResponse('Угоду видалено'),
        ...securedErrors,
        '404': errorRef('NotFound'),
        '409': errorRef('Conflict'),
      },
    },
  },
  '/api/v1/deals/{id}/transitions': {
    post: {
      ...securedOperation,
      tags: ['Deal transitions'],
      summary: 'Перевести угоду на інший stage',
      description:
        'Дозволені переходи: LEAD → QUALIFIED, QUALIFIED → PROPOSAL, PROPOSAL → WON/LOST.',
      parameters: [idParameter],
      requestBody: jsonBody({
        type: 'object',
        required: ['version', 'stage'],
        properties: {
          version: versionSchema,
          stage: { $ref: '#/components/schemas/DealStage' },
          probability: probabilitySchema,
        },
      }),
      responses: {
        '200': dataResponse('Stage угоди змінено', { $ref: '#/components/schemas/Deal' }),
        ...securedErrors,
        '404': errorRef('NotFound'),
        '409': errorRef('Conflict'),
      },
    },
  },
} as const;
