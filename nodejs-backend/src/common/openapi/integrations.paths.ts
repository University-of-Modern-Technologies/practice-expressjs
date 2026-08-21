import { dataResponse, errorRef, jsonBody, securedErrors, securedOperation } from './helpers.js';

const addressRef = { $ref: '#/components/schemas/DeliveryAddress' };
const parcelRef = { $ref: '#/components/schemas/DeliveryParcel' };
const moneySchema = { type: 'string', pattern: '^\\d{1,12}(?:\\.\\d{1,2})?$' };

/** Every call to the carrier can fail in one of four documented ways. */
const upstreamErrors = {
  '422': errorRef('UnprocessableEntity'),
  '502': errorRef('BadGateway'),
  '503': errorRef('ServiceUnavailable'),
  '504': errorRef('GatewayTimeout'),
} as const;

const upstreamErrorNote =
  'Помилки зовнішньої служби: 422 `DELIVERY_REJECTED`, 502 `DELIVERY_INVALID_RESPONSE`, ' +
  '503 `DELIVERY_UNAVAILABLE` (зокрема коли розімкнено запобіжник), 504 `DELIVERY_TIMEOUT`.';

export const integrationsPaths = {
  '/api/v1/integrations/health': {
    get: {
      ...securedOperation,
      tags: ['Integrations'],
      summary: 'Стан інтеграції доставки',
      description:
        'Потребує дозволу `integrations:read`. Повертає транспорт і стан запобіжника без ' +
        'жодних даних про зовнішню службу.',
      responses: {
        '200': dataResponse('Стан інтеграції', { $ref: '#/components/schemas/DeliveryHealth' }),
        ...securedErrors,
      },
    },
  },
  '/api/v1/integrations/delivery/quotes': {
    post: {
      ...securedOperation,
      tags: ['Delivery'],
      summary: 'Запитати вартість доставки',
      description: `Потребує дозволу \`integrations:read\`. Результат кешується. ${upstreamErrorNote}`,
      requestBody: jsonBody({
        type: 'object',
        required: ['orderId', 'origin', 'destination', 'parcel'],
        properties: {
          orderId: { type: 'string', minLength: 1, maxLength: 64 },
          origin: addressRef,
          destination: addressRef,
          parcel: parcelRef,
          declaredValue: moneySchema,
        },
      }),
      responses: {
        '200': dataResponse('Пропозиція доставки', { $ref: '#/components/schemas/DeliveryQuote' }),
        ...securedErrors,
        ...upstreamErrors,
      },
    },
  },
  '/api/v1/integrations/delivery/shipments': {
    post: {
      ...securedOperation,
      tags: ['Delivery'],
      summary: 'Створити відправлення',
      description: `Потребує дозволу \`integrations:write\`. Не кешується. ${upstreamErrorNote}`,
      requestBody: jsonBody({
        type: 'object',
        required: ['quoteId', 'orderId', 'destination', 'parcel'],
        properties: {
          quoteId: { type: 'string', minLength: 1, maxLength: 128 },
          orderId: { type: 'string', minLength: 1, maxLength: 64 },
          destination: addressRef,
          parcel: parcelRef,
          reference: { type: 'string', minLength: 1, maxLength: 120 },
        },
      }),
      responses: {
        '201': dataResponse('Відправлення створено', { $ref: '#/components/schemas/Shipment' }),
        ...securedErrors,
        ...upstreamErrors,
      },
    },
  },
  '/api/v1/integrations/delivery/shipments/{id}': {
    get: {
      ...securedOperation,
      tags: ['Delivery'],
      summary: 'Отримати стан відправлення',
      description:
        'Потребує дозволу `integrations:read`. Не кешується. Якщо зовнішня служба не знає ' +
        `такого відправлення, повертається 404 \`DELIVERY_REJECTED\`. ${upstreamErrorNote}`,
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', minLength: 1, maxLength: 128 },
        },
      ],
      responses: {
        '200': dataResponse('Відправлення', { $ref: '#/components/schemas/Shipment' }),
        ...securedErrors,
        '404': errorRef('NotFound'),
        ...upstreamErrors,
      },
    },
  },
} as const;
