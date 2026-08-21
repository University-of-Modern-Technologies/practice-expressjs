import { dataResponse, errorRef, jsonBody, securedErrors, securedOperation } from './helpers.js';

/** The assistant is a remote dependency, so it fails like one. */
const providerErrors = {
  '502': errorRef('BadGateway'),
  '503': errorRef('ServiceUnavailable'),
  '504': errorRef('GatewayTimeout'),
} as const;

const providerErrorNote =
  'Помилки провайдера: 502 `AI_INVALID_RESPONSE`, 503 `AI_UNAVAILABLE`, 504 `AI_TIMEOUT`. ' +
  'Текст, довший за ліміт (за замовчуванням 4000 символів), відхиляється з ' +
  '400 `AI_INPUT_TOO_LARGE`.';

export const aiPaths = {
  '/api/v1/ai/summaries/deal': {
    post: {
      ...securedOperation,
      tags: ['AI'],
      summary: 'Скласти стислий опис угоди',
      description:
        'Потребує дозволу `ai:use`. Провайдеру передаються лише перелічені поля; усе інше ' +
        `відкидається під час валідації. Відповідь кешується. ${providerErrorNote}`,
      requestBody: jsonBody({
        type: 'object',
        required: ['id', 'title', 'stage'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          title: { type: 'string', minLength: 1, maxLength: 200 },
          stage: { type: 'string', minLength: 1, maxLength: 40 },
          amount: { type: 'string', pattern: '^\\d{1,12}(?:\\.\\d{1,2})?$' },
          currency: { type: 'string', pattern: '^[A-Za-z]{3}$' },
          probability: { type: 'integer', minimum: 0, maximum: 100 },
          expectedCloseDate: { type: 'string', format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          notes: { type: 'string', minLength: 1, maxLength: 4000 },
        },
      }),
      responses: {
        '200': dataResponse('Стислий опис угоди', { $ref: '#/components/schemas/AiDealSummary' }),
        ...securedErrors,
        ...providerErrors,
      },
    },
  },
  '/api/v1/ai/classify/inquiry': {
    post: {
      ...securedOperation,
      tags: ['AI'],
      summary: 'Класифікувати звернення',
      description:
        'Потребує дозволу `ai:use`. Категорія обмежена закритим списком; відповідь поза ' +
        `списком перетворюється на \`unknown\`. Відповідь кешується. ${providerErrorNote}`,
      requestBody: jsonBody({
        type: 'object',
        required: ['text'],
        properties: { text: { type: 'string', minLength: 1, maxLength: 4000 } },
      }),
      responses: {
        '200': dataResponse('Класифікація звернення', {
          $ref: '#/components/schemas/AiInquiryClassification',
        }),
        ...securedErrors,
        ...providerErrors,
      },
    },
  },
} as const;
