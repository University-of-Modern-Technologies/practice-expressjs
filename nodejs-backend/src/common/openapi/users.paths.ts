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

const userWriteBody = {
  type: 'object',
  properties: {
    email: { type: 'string', format: 'email' },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    password: { type: 'string', minLength: 8, maxLength: 128, format: 'password' },
    roleIds: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: { type: 'string', format: 'uuid' },
    },
  },
};

export const usersPaths = {
  '/api/v1/users': {
    get: {
      ...securedOperation,
      tags: ['Users'],
      summary: 'Переглянути користувачів',
      parameters: pageParameters20,
      responses: {
        '200': dataResponse('Сторінка користувачів', {
          type: 'object',
          required: ['items', 'page', 'pageSize', 'total'],
          properties: {
            items: { type: 'array', items: { $ref: '#/components/schemas/User' } },
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
      tags: ['Users'],
      summary: 'Створити користувача',
      requestBody: jsonBody({
        ...userWriteBody,
        required: ['email', 'name', 'password', 'roleIds'],
      }),
      responses: {
        '201': dataResponse('Користувача створено', { $ref: '#/components/schemas/User' }),
        ...securedErrors,
        '404': errorRef('NotFound'),
        '409': errorRef('Conflict'),
      },
    },
  },
  '/api/v1/users/{id}': {
    get: {
      ...securedOperation,
      tags: ['Users'],
      summary: 'Отримати користувача',
      parameters: [idParameter],
      responses: {
        '200': dataResponse('Користувач', { $ref: '#/components/schemas/User' }),
        ...securedErrors,
        '404': errorRef('NotFound'),
      },
    },
    patch: {
      ...securedOperation,
      tags: ['Users'],
      summary: 'Оновити користувача',
      parameters: [idParameter],
      requestBody: jsonBody(userWriteBody),
      responses: {
        '200': dataResponse('Користувача оновлено', { $ref: '#/components/schemas/User' }),
        ...securedErrors,
        '404': errorRef('NotFound'),
        '409': errorRef('Conflict'),
      },
    },
  },
  '/api/v1/users/{id}/sessions': {
    get: {
      ...securedOperation,
      tags: ['Sessions'],
      summary: 'Переглянути сесії користувача',
      parameters: [idParameter],
      responses: {
        '200': dataResponse('Сесії користувача', {
          type: 'array',
          items: { $ref: '#/components/schemas/UserSession' },
        }),
        ...securedErrors,
        '404': errorRef('NotFound'),
      },
    },
  },
  '/api/v1/users/{id}/sessions/{sessionId}': {
    delete: {
      ...securedOperation,
      tags: ['Sessions'],
      summary: 'Відкликати сесію користувача',
      parameters: [
        idParameter,
        {
          name: 'sessionId',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '204': noContentResponse('Сесію відкликано'),
        ...securedErrors,
        '404': errorRef('NotFound'),
      },
    },
  },
  '/api/v1/users/{id}/disable': {
    post: {
      ...securedOperation,
      tags: ['Users'],
      summary: 'Деактивувати користувача',
      parameters: [idParameter],
      responses: {
        '200': dataResponse('Користувача деактивовано', { $ref: '#/components/schemas/User' }),
        ...securedErrors,
        '404': errorRef('NotFound'),
      },
    },
  },
} as const;
