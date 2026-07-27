import {
  dataResponse,
  errorRef,
  idParameter,
  jsonBody,
  securedErrors,
  securedOperation,
} from './helpers.js';

const permissionsBody = {
  type: 'object',
  required: ['permissions'],
  properties: {
    permissions: {
      type: 'array',
      maxItems: 100,
      items: { $ref: '#/components/schemas/Permission' },
    },
  },
};

export const rbacPaths = {
  '/api/v1/rbac/check/{resource}/{action}': {
    get: {
      ...securedOperation,
      tags: ['RBAC'],
      summary: 'Перевірити дозвіл поточного користувача',
      parameters: [
        {
          name: 'resource',
          in: 'path',
          required: true,
          schema: { type: 'string', pattern: '^[a-z][a-z0-9_-]*$', maxLength: 64 },
        },
        {
          name: 'action',
          in: 'path',
          required: true,
          schema: { type: 'string', pattern: '^[a-z][a-z0-9_-]*$', maxLength: 64 },
        },
      ],
      responses: {
        '200': dataResponse('Результат перевірки', {
          type: 'object',
          required: ['allowed', 'scope'],
          properties: {
            allowed: { type: 'boolean' },
            scope: { type: 'string', enum: ['ALL', 'OWN'], nullable: true },
          },
        }),
        '400': errorRef('BadRequest'),
        '401': errorRef('Unauthorized'),
        '500': errorRef('InternalServerError'),
      },
    },
  },
  '/api/v1/rbac/roles': {
    get: {
      ...securedOperation,
      tags: ['Roles'],
      summary: 'Переглянути ролі',
      responses: {
        '200': dataResponse('Ролі', {
          type: 'array',
          items: { $ref: '#/components/schemas/Role' },
        }),
        ...securedErrors,
      },
    },
    post: {
      ...securedOperation,
      tags: ['Roles'],
      summary: 'Створити роль',
      requestBody: jsonBody({
        ...permissionsBody,
        required: ['name', 'permissions'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 64 },
          description: { type: 'string', minLength: 1, maxLength: 255, nullable: true },
          ...permissionsBody.properties,
        },
      }),
      responses: {
        '201': dataResponse('Роль створено', { $ref: '#/components/schemas/Role' }),
        ...securedErrors,
        '409': errorRef('Conflict'),
      },
    },
  },
  '/api/v1/rbac/roles/{id}/permissions': {
    put: {
      ...securedOperation,
      tags: ['Roles'],
      summary: 'Замінити дозволи ролі',
      parameters: [idParameter],
      requestBody: jsonBody(permissionsBody),
      responses: {
        '200': dataResponse('Дозволи ролі замінено', { $ref: '#/components/schemas/Role' }),
        ...securedErrors,
        '404': errorRef('NotFound'),
      },
    },
  },
} as const;
