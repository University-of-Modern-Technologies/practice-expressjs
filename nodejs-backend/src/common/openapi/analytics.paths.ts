import { dataResponse, securedErrors, securedOperation } from './helpers.js';

const instantSchema = {
  type: 'string',
  format: 'date-time',
  description: 'Дата або мітка часу ISO 8601; нормалізується до UTC.',
};

// Missing bounds use the shared reporting default; the window may not exceed
// 366 days and `from` must be earlier than `to`.
const rangeParameters = [
  { name: 'from', in: 'query', schema: instantSchema },
  { name: 'to', in: 'query', schema: instantSchema },
];

const limitParameter = {
  name: 'limit',
  in: 'query',
  description: 'Значення понад 100 обрізаються до 100, а не відхиляються.',
  schema: { type: 'integer', minimum: 1, default: 10 },
};

const rangeNote =
  'Проміжок за замовчуванням — січень 2026; `from` має бути раніше за `to`, ' +
  'а вікно не може перевищувати 366 днів.';

const report = (
  summary: string,
  description: string,
  parameters: readonly object[],
  schemaName: string,
  responseDescription: string,
): Record<string, unknown> => ({
  ...securedOperation,
  tags: ['Analytics'],
  summary,
  description: `Потребує дозволу \`analytics:read\`. ${description}`,
  parameters: [...parameters],
  responses: {
    '200': dataResponse(responseDescription, { $ref: `#/components/schemas/${schemaName}` }),
    ...securedErrors,
  },
});

export const analyticsPaths = {
  '/api/v1/analytics/sales-summary': {
    get: report(
      'Звіт про продажі за періодами',
      `Виторг і кількість замовлень, згруповані по днях, тижнях або місяцях. ${rangeNote}`,
      [
        ...rangeParameters,
        {
          name: 'period',
          in: 'query',
          schema: { type: 'string', enum: ['day', 'week', 'month'], default: 'day' },
        },
        { name: 'ownerId', in: 'query', schema: { type: 'string', format: 'uuid' } },
      ],
      'SalesSummaryReport',
      'Звіт про продажі',
    ),
  },
  '/api/v1/analytics/deal-funnel': {
    get: report(
      'Воронка угод',
      `Кількість і сума угод за stage та конверсії між сусідніми stage. ${rangeNote}`,
      [
        ...rangeParameters,
        { name: 'ownerId', in: 'query', schema: { type: 'string', format: 'uuid' } },
      ],
      'DealFunnelReport',
      'Звіт по воронці угод',
    ),
  },
  '/api/v1/analytics/top-products': {
    get: report(
      'Найпродаваніші товари',
      `Товари з найбільшим виторгом за проміжок. ${rangeNote}`,
      [...rangeParameters, limitParameter],
      'TopProductsReport',
      'Звіт по товарах',
    ),
  },
  '/api/v1/analytics/owner-performance': {
    get: report(
      'Результати відповідальних',
      `Угоди, виграші та виторг у розрізі відповідальних. ${rangeNote}`,
      [...rangeParameters, limitParameter],
      'OwnerPerformanceReport',
      'Звіт по відповідальних',
    ),
  },
  '/api/v1/analytics/stock-health': {
    get: report(
      'Стан запасів',
      'Позиції, доступний залишок яких не перевищує поріг. Значення `threshold` понад ' +
        '1 000 000 обрізається. Проміжок дат не застосовується.',
      [
        {
          name: 'threshold',
          in: 'query',
          schema: { type: 'integer', minimum: 0, default: 5 },
        },
        limitParameter,
        { name: 'warehouseId', in: 'query', schema: { type: 'string', format: 'uuid' } },
      ],
      'StockHealthReport',
      'Звіт про стан запасів',
    ),
  },
  '/api/v1/analytics/{report}/export': {
    get: {
      ...securedOperation,
      tags: ['Analytics'],
      summary: 'Вивантаження звіту у CSV або JSON',
      description:
        'Потребує дозволу `analytics:read`. Приймає ті самі параметри, що й відповідний звіт, ' +
        'плюс `format`. `format=csv` (за замовчуванням) повертає `text/csv` з ' +
        '`Content-Disposition: attachment`; `format=json` повертає той самий набір рядків як масив.',
      parameters: [
        {
          name: 'report',
          in: 'path',
          required: true,
          schema: {
            type: 'string',
            enum: [
              'sales-summary',
              'deal-funnel',
              'top-products',
              'owner-performance',
              'stock-health',
            ],
          },
        },
        {
          name: 'format',
          in: 'query',
          schema: { type: 'string', enum: ['csv', 'json'], default: 'csv' },
        },
        ...rangeParameters,
        {
          name: 'period',
          in: 'query',
          description: 'Застосовується лише до sales-summary.',
          schema: { type: 'string', enum: ['day', 'week', 'month'], default: 'day' },
        },
        limitParameter,
        {
          name: 'threshold',
          in: 'query',
          description: 'Застосовується лише до stock-health.',
          schema: { type: 'integer', minimum: 0, default: 5 },
        },
        {
          name: 'ownerId',
          in: 'query',
          description: 'Застосовується до sales-summary та deal-funnel.',
          schema: { type: 'string', format: 'uuid' },
        },
        {
          name: 'warehouseId',
          in: 'query',
          description: 'Застосовується лише до stock-health.',
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Рядки звіту у форматі CSV або JSON',
          content: {
            'text/csv': { schema: { type: 'string' } },
            'application/json': {
              schema: {
                type: 'object',
                required: ['data'],
                properties: { data: { type: 'array', items: {} } },
              },
            },
          },
        },
        ...securedErrors,
      },
    },
  },
} as const;
