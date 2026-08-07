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

const contactProperties = {
  ownerId: { type: 'string', format: 'uuid' },
  firstName: { type: 'string', minLength: 1, maxLength: 80 },
  lastName: { type: 'string', minLength: 1, maxLength: 80 },
  email: { type: 'string', format: 'email', maxLength: 320, nullable: true },
  phone: { type: 'string', minLength: 1, maxLength: 32, nullable: true },
  company: { type: 'string', minLength: 1, maxLength: 160, nullable: true },
  notes: { type: 'string', minLength: 1, nullable: true },
};

const contactQueryParameters = [
  ...pageParameters20,
  { name: 'search', in: 'query', schema: { type: 'string', minLength: 1, maxLength: 160 } },
  { name: 'ownerId', in: 'query', schema: { type: 'string', format: 'uuid' } },
  {
    name: 'sortBy',
    in: 'query',
    schema: {
      type: 'string',
      enum: ['createdAt', 'updatedAt', 'firstName', 'lastName', 'company'],
      default: 'createdAt',
    },
  },
  {
    name: 'sortOrder',
    in: 'query',
    schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
  },
];

export const contactsPaths = {
  '/api/v1/contacts': {
    get: {
      ...securedOperation,
      tags: ['Contacts'],
      summary: 'Переглянути контакти',
      parameters: contactQueryParameters,
      responses: {
        '200': dataResponse('Сторінка контактів', {
          type: 'object',
          required: ['items', 'page', 'pageSize', 'total'],
          properties: {
            items: { type: 'array', items: { $ref: '#/components/schemas/Contact' } },
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
      tags: ['Contacts'],
      summary: 'Створити контакт',
      description: 'Потрібно передати принаймні email або phone.',
      requestBody: jsonBody({
        type: 'object',
        required: ['firstName', 'lastName'],
        properties: {
          ...contactProperties,
          email: { type: 'string', format: 'email', maxLength: 320 },
          phone: { type: 'string', minLength: 1, maxLength: 32 },
          company: { type: 'string', minLength: 1, maxLength: 160 },
          notes: { type: 'string', minLength: 1 },
        },
      }),
      responses: {
        '201': dataResponse('Контакт створено', { $ref: '#/components/schemas/Contact' }),
        ...securedErrors,
        '409': errorRef('Conflict'),
      },
    },
  },
  '/api/v1/contacts/{id}': {
    get: {
      ...securedOperation,
      tags: ['Contacts'],
      summary: 'Отримати контакт',
      parameters: [idParameter],
      responses: {
        '200': dataResponse('Контакт', { $ref: '#/components/schemas/Contact' }),
        ...securedErrors,
        '404': errorRef('NotFound'),
      },
    },
    patch: {
      ...securedOperation,
      tags: ['Contacts'],
      summary: 'Оновити контакт',
      parameters: [idParameter],
      requestBody: jsonBody({ type: 'object', minProperties: 1, properties: contactProperties }),
      responses: {
        '200': dataResponse('Контакт оновлено', { $ref: '#/components/schemas/Contact' }),
        ...securedErrors,
        '404': errorRef('NotFound'),
        '409': errorRef('Conflict'),
      },
    },
    delete: {
      ...securedOperation,
      tags: ['Contacts'],
      summary: 'Видалити контакт',
      parameters: [idParameter],
      responses: {
        '204': noContentResponse('Контакт видалено'),
        ...securedErrors,
        '404': errorRef('NotFound'),
      },
    },
  },
} as const;
