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

const versionSchema = { type: 'integer', minimum: 1 };
const timestampSchema = { type: 'string', format: 'date-time' };
const directionSchema = { type: 'string', enum: ['INBOUND', 'OUTBOUND'] };
const dispositionSchema = {
  type: 'string',
  enum: ['ANSWERED', 'NO_ANSWER', 'BUSY', 'FAILED', 'VOICEMAIL'],
};

const callSchema = {
  type: 'object',
  required: [
    'id',
    'externalId',
    'direction',
    'disposition',
    'fromNumber',
    'toNumber',
    'startedAt',
    'durationSeconds',
    'version',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    externalId: { type: 'string', minLength: 1, maxLength: 64 },
    direction: directionSchema,
    disposition: dispositionSchema,
    fromNumber: { type: 'string', maxLength: 32, pattern: '^\\+[1-9]\\d{1,14}$' },
    toNumber: { type: 'string', maxLength: 32, pattern: '^\\+[1-9]\\d{1,14}$' },
    startedAt: timestampSchema,
    durationSeconds: { type: 'integer', minimum: 0 },
    ownerId: { type: 'string', format: 'uuid', nullable: true },
    contactId: { type: 'string', format: 'uuid', nullable: true },
    dealId: { type: 'string', format: 'uuid', nullable: true },
    recordingUrl: { type: 'string', maxLength: 512, nullable: true },
    notes: { type: 'string', maxLength: 2000, nullable: true },
    version: versionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  },
};

const syncResultSchema = {
  type: 'object',
  required: ['fetched', 'created', 'skipped'],
  properties: {
    fetched: { type: 'integer', minimum: 0 },
    created: { type: 'integer', minimum: 0 },
    skipped: { type: 'integer', minimum: 0 },
  },
};

const recordingSchema = {
  type: 'object',
  required: ['url', 'expiresAt'],
  properties: {
    url: { type: 'string', maxLength: 512 },
    expiresAt: timestampSchema,
  },
};

const callQueryParameters = [
  ...pageParameters20,
  { name: 'search', in: 'query', schema: { type: 'string', minLength: 1, maxLength: 160 } },
  { name: 'direction', in: 'query', schema: directionSchema },
  { name: 'disposition', in: 'query', schema: dispositionSchema },
  { name: 'contactId', in: 'query', schema: { type: 'string', format: 'uuid' } },
  { name: 'dealId', in: 'query', schema: { type: 'string', format: 'uuid' } },
  { name: 'ownerId', in: 'query', schema: { type: 'string', format: 'uuid' } },
  { name: 'startedFrom', in: 'query', schema: timestampSchema },
  { name: 'startedTo', in: 'query', schema: timestampSchema },
  {
    name: 'hasContact',
    in: 'query',
    description: 'true — лише прив’язані до контакту, false — лише непов’язані.',
    schema: { type: 'boolean' },
  },
  {
    name: 'sortBy',
    in: 'query',
    schema: {
      type: 'string',
      enum: ['startedAt', 'createdAt', 'durationSeconds'],
      default: 'startedAt',
    },
  },
  {
    name: 'sortOrder',
    in: 'query',
    schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
  },
];

export const callsPaths = {
  '/api/v1/calls': {
    get: {
      ...securedOperation,
      tags: ['Calls'],
      summary: 'Переглянути журнал дзвінків',
      parameters: callQueryParameters,
      responses: {
        '200': pageResponse('Сторінка дзвінків', callSchema),
        ...securedErrors,
      },
    },
  },
  '/api/v1/calls/sync': {
    post: {
      ...securedOperation,
      tags: ['Calls'],
      summary: 'Підтягнути дзвінки від провайдера',
      description:
        'Імпорт ідемпотентний: ключ — externalId, тож повторний виклик з тією самою пачкою ' +
        'нічого не дублює й повертає їх у skipped. Недоступний провайдер — 502 ' +
        '`CALL_PROVIDER_UNAVAILABLE`.',
      responses: {
        '200': dataResponse('Підсумок синхронізації', syncResultSchema),
        ...securedErrors,
        '502': errorRef('BadGateway'),
      },
    },
  },
  '/api/v1/calls/{id}': {
    get: {
      ...securedOperation,
      tags: ['Calls'],
      summary: 'Отримати дзвінок',
      parameters: [idParameter],
      responses: {
        '200': dataResponse('Дзвінок', callSchema),
        ...securedErrors,
        '404': errorRef('NotFound'),
      },
    },
    patch: {
      ...securedOperation,
      tags: ['Calls'],
      summary: 'Оновити дзвінок',
      description:
        'Змінюються лише contactId, dealId, ownerId і notes. Решта полів приїжджає від ' +
        'провайдера й руками не правиться.',
      parameters: [idParameter],
      requestBody: jsonBody({
        type: 'object',
        required: ['version'],
        minProperties: 2,
        properties: {
          version: versionSchema,
          ownerId: { type: 'string', format: 'uuid', nullable: true },
          contactId: { type: 'string', format: 'uuid', nullable: true },
          dealId: { type: 'string', format: 'uuid', nullable: true },
          notes: { type: 'string', minLength: 1, maxLength: 2000, nullable: true },
        },
      }),
      responses: {
        '200': dataResponse('Дзвінок оновлено', callSchema),
        ...securedErrors,
        '404': errorRef('NotFound'),
        '409': errorRef('Conflict'),
      },
    },
    delete: {
      ...securedOperation,
      tags: ['Calls'],
      summary: 'Видалити дзвінок',
      parameters: [
        idParameter,
        { name: 'version', in: 'query', required: true, schema: versionSchema },
      ],
      responses: {
        '204': noContentResponse('Дзвінок видалено'),
        ...securedErrors,
        '404': errorRef('NotFound'),
        '409': errorRef('Conflict'),
      },
    },
  },
  '/api/v1/calls/{id}/link': {
    post: {
      ...securedOperation,
      tags: ['Calls'],
      summary: 'Прив’язати дзвінок до контакту або угоди',
      parameters: [idParameter],
      requestBody: jsonBody({
        type: 'object',
        required: ['version'],
        minProperties: 2,
        properties: {
          version: versionSchema,
          contactId: { type: 'string', format: 'uuid' },
          dealId: { type: 'string', format: 'uuid' },
        },
      }),
      responses: {
        '200': dataResponse('Дзвінок прив’язано', callSchema),
        ...securedErrors,
        '404': errorRef('NotFound'),
        '409': errorRef('Conflict'),
      },
    },
  },
  '/api/v1/calls/{id}/recording': {
    get: {
      ...securedOperation,
      tags: ['Calls'],
      summary: 'Отримати посилання на запис дзвінка',
      description: 'Якщо запису немає — 404 `CALL_RECORDING_UNAVAILABLE`.',
      parameters: [idParameter],
      responses: {
        '200': dataResponse('Посилання на запис', recordingSchema),
        ...securedErrors,
        '404': errorRef('NotFound'),
      },
    },
  },
} as const;
