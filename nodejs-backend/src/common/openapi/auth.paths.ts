import {
  dataResponse,
  errorRef,
  jsonBody,
  noContentResponse,
  securedOperation,
} from './helpers.js';

const authResponse = dataResponse('Access token і поточний користувач', {
  $ref: '#/components/schemas/AuthPayload',
});

export const authPaths = {
  '/api/v1/auth/login': {
    post: {
      tags: ['Auth'],
      summary: 'Увійти до системи',
      requestBody: jsonBody({
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 8, maxLength: 128, format: 'password' },
        },
      }),
      responses: {
        '200': authResponse,
        '400': errorRef('BadRequest'),
        '401': errorRef('Unauthorized'),
        '500': errorRef('InternalServerError'),
      },
    },
  },
  '/api/v1/auth/refresh': {
    post: {
      tags: ['Auth'],
      summary: 'Оновити пару токенів',
      security: [{ refreshCookie: [] }],
      responses: {
        '200': authResponse,
        '401': errorRef('Unauthorized'),
        '500': errorRef('InternalServerError'),
      },
    },
  },
  '/api/v1/auth/logout': {
    post: {
      tags: ['Auth'],
      summary: 'Завершити refresh-сесію',
      security: [{ refreshCookie: [] }],
      responses: {
        '204': noContentResponse('Сесію завершено, refresh cookie очищено'),
        '500': errorRef('InternalServerError'),
      },
    },
  },
  '/api/v1/auth/me': {
    get: {
      ...securedOperation,
      tags: ['Auth'],
      summary: 'Отримати поточного користувача',
      responses: {
        '200': dataResponse('Поточний користувач', {
          $ref: '#/components/schemas/AuthenticatedUser',
        }),
        '401': errorRef('Unauthorized'),
        '500': errorRef('InternalServerError'),
      },
    },
  },
} as const;
