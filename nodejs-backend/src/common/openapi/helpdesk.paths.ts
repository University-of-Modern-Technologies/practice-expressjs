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
const channelSchema = { type: 'string', enum: ['EMAIL', 'PHONE', 'CHAT', 'WEB'] };
const statusSchema = { type: 'string', enum: ['NEW', 'OPEN', 'PENDING', 'RESOLVED', 'CLOSED'] };
const prioritySchema = { type: 'string', enum: ['LOW', 'NORMAL', 'HIGH', 'URGENT'] };

const ticketSchema = {
  type: 'object',
  required: [
    'id',
    'number',
    'subject',
    'body',
    'channel',
    'status',
    'priority',
    'ownerId',
    'version',
    'openedAt',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    number: { type: 'string', pattern: '^TKT-\\d{8}$' },
    subject: { type: 'string', minLength: 1, maxLength: 200 },
    body: { type: 'string', minLength: 1, maxLength: 5000 },
    channel: channelSchema,
    status: statusSchema,
    priority: prioritySchema,
    ownerId: { type: 'string', format: 'uuid' },
    contactId: { type: 'string', format: 'uuid', nullable: true },
    assigneeId: { type: 'string', format: 'uuid', nullable: true },
    version: versionSchema,
    openedAt: timestampSchema,
    resolvedAt: { ...timestampSchema, nullable: true },
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  },
};

const ticketWriteProperties = {
  ownerId: { type: 'string', format: 'uuid' },
  contactId: { type: 'string', format: 'uuid', nullable: true },
  assigneeId: { type: 'string', format: 'uuid', nullable: true },
  subject: { type: 'string', minLength: 1, maxLength: 200 },
  body: { type: 'string', minLength: 1, maxLength: 5000 },
  channel: channelSchema,
  priority: prioritySchema,
};

const ticketQueryParameters = [
  ...pageParameters20,
  { name: 'search', in: 'query', schema: { type: 'string', minLength: 1, maxLength: 160 } },
  { name: 'status', in: 'query', schema: statusSchema },
  { name: 'channel', in: 'query', schema: channelSchema },
  { name: 'priority', in: 'query', schema: prioritySchema },
  { name: 'contactId', in: 'query', schema: { type: 'string', format: 'uuid' } },
  { name: 'assigneeId', in: 'query', schema: { type: 'string', format: 'uuid' } },
  { name: 'ownerId', in: 'query', schema: { type: 'string', format: 'uuid' } },
  { name: 'openedFrom', in: 'query', schema: timestampSchema },
  { name: 'openedTo', in: 'query', schema: timestampSchema },
  {
    name: 'sortBy',
    in: 'query',
    schema: {
      type: 'string',
      enum: ['createdAt', 'updatedAt', 'openedAt', 'priority', 'status'],
      default: 'createdAt',
    },
  },
  {
    name: 'sortOrder',
    in: 'query',
    schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
  },
];

export const helpdeskPaths = {
  '/api/v1/helpdesk/tickets': {
    get: {
      ...securedOperation,
      tags: ['Helpdesk'],
      summary: 'Переглянути звернення',
      parameters: ticketQueryParameters,
      responses: {
        '200': pageResponse('Сторінка звернень', ticketSchema),
        ...securedErrors,
      },
    },
    post: {
      ...securedOperation,
      tags: ['Helpdesk'],
      summary: 'Створити звернення',
      description: 'Звернення завжди відкривається у статусі NEW під згенерованим номером.',
      requestBody: jsonBody({
        type: 'object',
        required: ['subject', 'body', 'channel'],
        properties: {
          ...ticketWriteProperties,
          contactId: { type: 'string', format: 'uuid' },
          assigneeId: { type: 'string', format: 'uuid' },
        },
      }),
      responses: {
        '201': dataResponse('Звернення створено', ticketSchema),
        ...securedErrors,
        '404': errorRef('NotFound'),
        '409': errorRef('Conflict'),
      },
    },
  },
  '/api/v1/helpdesk/tickets/{id}': {
    get: {
      ...securedOperation,
      tags: ['Helpdesk'],
      summary: 'Отримати звернення',
      parameters: [idParameter],
      responses: {
        '200': dataResponse('Звернення', ticketSchema),
        ...securedErrors,
        '404': errorRef('NotFound'),
      },
    },
    patch: {
      ...securedOperation,
      tags: ['Helpdesk'],
      summary: 'Оновити звернення без зміни статусу',
      parameters: [idParameter],
      requestBody: jsonBody({
        type: 'object',
        required: ['version'],
        minProperties: 2,
        properties: { version: versionSchema, ...ticketWriteProperties },
      }),
      responses: {
        '200': dataResponse('Звернення оновлено', ticketSchema),
        ...securedErrors,
        '404': errorRef('NotFound'),
        '409': errorRef('Conflict'),
      },
    },
    delete: {
      ...securedOperation,
      tags: ['Helpdesk'],
      summary: 'Видалити звернення',
      parameters: [
        idParameter,
        { name: 'version', in: 'query', required: true, schema: versionSchema },
      ],
      responses: {
        '204': noContentResponse('Звернення видалено'),
        ...securedErrors,
        '404': errorRef('NotFound'),
        '409': errorRef('Conflict'),
      },
    },
  },
  '/api/v1/helpdesk/tickets/{id}/transitions': {
    post: {
      ...securedOperation,
      tags: ['Helpdesk transitions'],
      summary: 'Перевести звернення в інший статус',
      description:
        'Дозволені переходи: NEW → OPEN/CLOSED, OPEN → PENDING/RESOLVED/CLOSED, ' +
        'PENDING → OPEN/RESOLVED/CLOSED, RESOLVED → CLOSED/OPEN. Перехід поза таблицею — ' +
        '422 `TICKET_TRANSITION_NOT_ALLOWED`.',
      parameters: [idParameter],
      requestBody: jsonBody({
        type: 'object',
        required: ['version', 'toStatus'],
        properties: {
          version: versionSchema,
          toStatus: statusSchema,
          note: { type: 'string', minLength: 1, maxLength: 500 },
        },
      }),
      responses: {
        '200': dataResponse('Статус звернення змінено', ticketSchema),
        ...securedErrors,
        '404': errorRef('NotFound'),
        '409': errorRef('Conflict'),
        '422': errorRef('UnprocessableEntity'),
      },
    },
  },
} as const;
