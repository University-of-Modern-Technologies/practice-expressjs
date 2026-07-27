import {
  dataResponse,
  errorRef,
  idParameter,
  pageParameters25,
  securedErrors,
  securedOperation,
} from './helpers.js';

const auditFilters = [
  { name: 'action', in: 'query', schema: { type: 'string', minLength: 1, maxLength: 64 } },
  { name: 'createdFrom', in: 'query', schema: { type: 'string', format: 'date-time' } },
  { name: 'createdTo', in: 'query', schema: { type: 'string', format: 'date-time' } },
];

const auditListResponse = dataResponse('Сторінка подій аудиту', {
  type: 'object',
  required: ['items', 'page', 'pageSize', 'total'],
  properties: {
    items: { type: 'array', items: { $ref: '#/components/schemas/AuditRecord' } },
    page: { type: 'integer' },
    pageSize: { type: 'integer' },
    total: { type: 'integer' },
  },
});

export const auditPaths = {
  '/api/v1/audit': {
    get: {
      ...securedOperation,
      tags: ['Audit'],
      summary: 'Переглянути журнал аудиту',
      parameters: [
        ...pageParameters25,
        { name: 'actorId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        ...auditFilters,
        {
          name: 'entityType',
          in: 'query',
          schema: { type: 'string', minLength: 1, maxLength: 64 },
        },
        { name: 'entityId', in: 'query', schema: { type: 'string', format: 'uuid' } },
      ],
      responses: { '200': auditListResponse, ...securedErrors },
    },
  },
  '/api/v1/audit/{resource}/{resourceId}': {
    get: {
      ...securedOperation,
      tags: ['Resource history'],
      summary: 'Переглянути історію конкретного ресурсу',
      parameters: [
        {
          name: 'resource',
          in: 'path',
          required: true,
          schema: { type: 'string', minLength: 1, maxLength: 64 },
        },
        {
          name: 'resourceId',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
        ...pageParameters25,
        ...auditFilters,
      ],
      responses: { '200': auditListResponse, ...securedErrors },
    },
  },
  '/api/v1/audit/{id}': {
    get: {
      ...securedOperation,
      tags: ['Audit'],
      summary: 'Отримати подію аудиту',
      parameters: [idParameter],
      responses: {
        '200': dataResponse('Подія аудиту', { $ref: '#/components/schemas/AuditRecord' }),
        ...securedErrors,
        '404': errorRef('NotFound'),
      },
    },
  },
} as const;
