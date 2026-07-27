import {
  dataResponse,
  errorRef,
  jsonBody,
  noContentResponse,
  securedErrors,
  securedOperation,
} from './helpers.js';

const keyParameter = {
  name: 'key',
  in: 'path',
  required: true,
  description: 'Ключ із закритого реєстру налаштувань.',
  schema: {
    type: 'string',
    minLength: 1,
    maxLength: 100,
    pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*$',
  },
};

const settingResponse = (description: string): Record<string, unknown> =>
  dataResponse(description, { $ref: '#/components/schemas/Setting' });

const unknownKeyNote = 'Ключ поза реєстром дає 400 `UNKNOWN_SETTING_KEY`.';

export const settingsPaths = {
  '/api/v1/settings': {
    get: {
      ...securedOperation,
      tags: ['Settings'],
      summary: 'Переглянути всі налаштування організації',
      description:
        'Потребує дозволу `settings:read`. Повертає значення для кожного оголошеного ключа; ' +
        'якщо рядка ще немає, віддається значення за замовчуванням із `source: "default"`.',
      responses: {
        '200': dataResponse('Перелік налаштувань', {
          type: 'array',
          items: { $ref: '#/components/schemas/Setting' },
        }),
        ...securedErrors,
      },
    },
  },
  '/api/v1/settings/{key}': {
    get: {
      ...securedOperation,
      tags: ['Settings'],
      summary: 'Отримати налаштування за ключем',
      description: `Потребує дозволу \`settings:read\`. ${unknownKeyNote}`,
      parameters: [keyParameter],
      responses: {
        '200': settingResponse('Налаштування'),
        ...securedErrors,
      },
    },
    put: {
      ...securedOperation,
      tags: ['Settings'],
      summary: 'Записати значення налаштування',
      description:
        'Потребує дозволу `settings:write`. Значення перевіряється схемою, оголошеною для ' +
        `цього ключа: невідповідність дає 400 \`INVALID_SETTING_VALUE\`. ${unknownKeyNote}`,
      parameters: [keyParameter],
      requestBody: jsonBody({
        type: 'object',
        required: ['value'],
        properties: {
          value: { description: 'Тип залежить від ключа згідно з реєстром налаштувань.' },
          description: { type: 'string', maxLength: 255, nullable: true },
        },
      }),
      responses: {
        '200': settingResponse('Налаштування збережено'),
        ...securedErrors,
      },
    },
    delete: {
      ...securedOperation,
      tags: ['Settings'],
      summary: 'Скинути налаштування до значення за замовчуванням',
      description:
        'Потребує дозволу `settings:write`. Видаляє рядок, після чого читання повертає ' +
        `значення з реєстру. Помилки: 404 \`SETTING_NOT_FOUND\`. ${unknownKeyNote}`,
      parameters: [keyParameter],
      responses: {
        '204': noContentResponse('Налаштування скинуто'),
        ...securedErrors,
        '404': errorRef('NotFound'),
      },
    },
  },
} as const;
