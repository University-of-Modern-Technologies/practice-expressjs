import {
  dataResponse,
  errorRef,
  idParameter,
  jsonBody,
  pageParameters20,
  pageResponse,
  securedErrors,
  securedOperation,
} from './helpers.js';

const versionSchema = { type: 'integer', minimum: 1 };
const timestampSchema = { type: 'string', format: 'date-time' };
const moneySchema = { type: 'string', pattern: '^\\d{1,12}(?:\\.\\d{2})$', example: '19.99' };
const signedMoneySchema = { type: 'string', pattern: '^-?\\d{1,12}(?:\\.\\d{2})$' };
const currencySchema = { type: 'string', minLength: 3, maxLength: 3, example: 'USD' };
const directionSchema = { type: 'string', enum: ['CREDIT', 'DEBIT'] };
const matchStatusSchema = {
  type: 'string',
  enum: ['UNMATCHED', 'SUGGESTED', 'MATCHED', 'IGNORED'],
};

const statementSchema = {
  type: 'object',
  required: [
    'id',
    'externalId',
    'accountLabel',
    'periodStart',
    'periodEnd',
    'openingBalance',
    'closingBalance',
    'currency',
    'importedAt',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    externalId: { type: 'string', minLength: 1, maxLength: 64 },
    accountLabel: { type: 'string', minLength: 1, maxLength: 64 },
    periodStart: timestampSchema,
    periodEnd: timestampSchema,
    openingBalance: moneySchema,
    closingBalance: moneySchema,
    currency: currencySchema,
    importedById: { type: 'string', format: 'uuid', nullable: true },
    importedAt: timestampSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  },
};

const transactionSchema = {
  type: 'object',
  required: [
    'id',
    'statementId',
    'externalId',
    'bookedAt',
    'amount',
    'currency',
    'direction',
    'counterpartyName',
    'reference',
    'matchStatus',
    'version',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    statementId: { type: 'string', format: 'uuid' },
    externalId: { type: 'string', minLength: 1, maxLength: 64 },
    bookedAt: timestampSchema,
    amount: moneySchema,
    currency: currencySchema,
    direction: directionSchema,
    counterpartyName: { type: 'string', minLength: 1, maxLength: 200 },
    counterpartyAccount: { type: 'string', maxLength: 64, nullable: true },
    reference: { type: 'string', minLength: 1, maxLength: 300 },
    matchStatus: matchStatusSchema,
    matchedOrderId: {
      type: 'string',
      format: 'uuid',
      nullable: true,
      description: 'Заповнене тоді й лише тоді, коли matchStatus = MATCHED.',
    },
    matchedAt: { ...timestampSchema, nullable: true },
    matchedById: { type: 'string', format: 'uuid', nullable: true },
    version: versionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  },
};

const candidateSchema = {
  type: 'object',
  required: ['orderId', 'orderNumber', 'status', 'total', 'currency', 'placedAt'],
  properties: {
    orderId: { type: 'string', format: 'uuid' },
    orderNumber: { type: 'string', maxLength: 32 },
    status: { type: 'string' },
    total: moneySchema,
    currency: currencySchema,
    contactId: { type: 'string', format: 'uuid', nullable: true },
    placedAt: { ...timestampSchema, nullable: true },
  },
};

const transactionDetailSchema = {
  ...transactionSchema,
  required: [...transactionSchema.required, 'candidates'],
  properties: {
    ...transactionSchema.properties,
    candidates: {
      type: 'array',
      items: candidateSchema,
      description: 'Непорожній лише для SUGGESTED: кандидати обчислюються на читанні.',
    },
  },
};

const importResultSchema = {
  type: 'object',
  required: ['statementId', 'imported', 'skipped'],
  properties: {
    statementId: { type: 'string', format: 'uuid' },
    imported: { type: 'integer', minimum: 0 },
    skipped: { type: 'integer', minimum: 0 },
  },
};

const reconcileResultSchema = {
  type: 'object',
  required: ['examined', 'matched', 'suggested', 'unmatched', 'ignored'],
  properties: {
    examined: { type: 'integer', minimum: 0 },
    matched: { type: 'integer', minimum: 0 },
    suggested: { type: 'integer', minimum: 0 },
    unmatched: { type: 'integer', minimum: 0 },
    ignored: { type: 'integer', minimum: 0 },
  },
};

const summarySchema = {
  type: 'object',
  required: ['from', 'to', 'transactionCount', 'inflow', 'outflow', 'net', 'statuses'],
  properties: {
    from: timestampSchema,
    to: timestampSchema,
    transactionCount: { type: 'integer', minimum: 0 },
    inflow: moneySchema,
    outflow: moneySchema,
    net: signedMoneySchema,
    statuses: {
      type: 'array',
      items: {
        type: 'object',
        required: ['status', 'count', 'amount', 'share'],
        properties: {
          status: matchStatusSchema,
          count: { type: 'integer', minimum: 0 },
          amount: moneySchema,
          share: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
};

const statementQueryParameters = [
  ...pageParameters20,
  { name: 'search', in: 'query', schema: { type: 'string', minLength: 1, maxLength: 160 } },
  {
    name: 'sortBy',
    in: 'query',
    schema: {
      type: 'string',
      enum: ['periodStart', 'importedAt', 'createdAt'],
      default: 'periodStart',
    },
  },
  {
    name: 'sortOrder',
    in: 'query',
    schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
  },
];

const transactionQueryParameters = [
  ...pageParameters20,
  { name: 'search', in: 'query', schema: { type: 'string', minLength: 1, maxLength: 160 } },
  { name: 'statementId', in: 'query', schema: { type: 'string', format: 'uuid' } },
  { name: 'matchStatus', in: 'query', schema: matchStatusSchema },
  { name: 'direction', in: 'query', schema: directionSchema },
  { name: 'bookedFrom', in: 'query', schema: timestampSchema },
  { name: 'bookedTo', in: 'query', schema: timestampSchema },
  {
    name: 'minAmount',
    in: 'query',
    description: 'Сума рядком, як і всюди в цьому модулі.',
    schema: { type: 'string', pattern: '^\\d{1,12}(?:\\.\\d{1,2})?$' },
  },
  {
    name: 'maxAmount',
    in: 'query',
    schema: { type: 'string', pattern: '^\\d{1,12}(?:\\.\\d{1,2})?$' },
  },
  {
    name: 'sortBy',
    in: 'query',
    schema: { type: 'string', enum: ['bookedAt', 'amount', 'createdAt'], default: 'bookedAt' },
  },
  {
    name: 'sortOrder',
    in: 'query',
    schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
  },
];

export const financePaths = {
  '/api/v1/finance/statements': {
    get: {
      ...securedOperation,
      tags: ['Finance'],
      summary: 'Переглянути банківські виписки',
      parameters: statementQueryParameters,
      responses: {
        '200': pageResponse('Сторінка виписок', statementSchema),
        ...securedErrors,
      },
    },
  },
  '/api/v1/finance/statements/import': {
    post: {
      ...securedOperation,
      tags: ['Finance'],
      summary: 'Імпортувати банківську виписку',
      description:
        'Імпорт ідемпотентний: ключ — externalId, тож повторний виклик з тією самою випискою ' +
        'нічого не дублює й повертає її рядки у skipped. Недоступний банк — 502 ' +
        '`BANK_PROVIDER_UNAVAILABLE`.',
      responses: {
        '200': dataResponse('Підсумок імпорту', importResultSchema),
        ...securedErrors,
        '409': errorRef('Conflict'),
        '502': errorRef('BadGateway'),
      },
    },
  },
  '/api/v1/finance/reconcile': {
    post: {
      ...securedOperation,
      tags: ['Finance'],
      summary: 'Звести платежі із замовленнями',
      description:
        'Кандидатом є замовлення у статусі CONFIRMED або PAID, чиє призначення платежу або ' +
        'назва контрагента впізнається, сума збігається з допуском ±0.01, а дата проведення ' +
        'лежить у вікні 90 днів від створення замовлення. Один кандидат — MATCHED, кілька — ' +
        'SUGGESTED, жодного — UNMATCHED.',
      responses: {
        '200': dataResponse('Підсумок зведення', reconcileResultSchema),
        ...securedErrors,
      },
    },
  },
  '/api/v1/finance/summary': {
    get: {
      ...securedOperation,
      tags: ['Finance'],
      summary: 'Підсумок надходжень і списань за період',
      parameters: [
        { name: 'from', in: 'query', schema: timestampSchema },
        { name: 'to', in: 'query', schema: timestampSchema },
      ],
      responses: {
        '200': dataResponse('Підсумок за період', summarySchema),
        ...securedErrors,
      },
    },
  },
  '/api/v1/finance/transactions': {
    get: {
      ...securedOperation,
      tags: ['Finance'],
      summary: 'Переглянути банківські транзакції',
      parameters: transactionQueryParameters,
      responses: {
        '200': pageResponse('Сторінка транзакцій', transactionSchema),
        ...securedErrors,
      },
    },
  },
  '/api/v1/finance/transactions/{id}': {
    get: {
      ...securedOperation,
      tags: ['Finance'],
      summary: 'Отримати банківську транзакцію',
      description: 'Для стану SUGGESTED у відповіді є список замовлень-кандидатів.',
      parameters: [idParameter],
      responses: {
        '200': dataResponse('Транзакція', transactionDetailSchema),
        ...securedErrors,
        '404': errorRef('NotFound'),
      },
    },
  },
  '/api/v1/finance/transactions/{id}/match': {
    post: {
      ...securedOperation,
      tags: ['Finance'],
      summary: 'Звести транзакцію із замовленням вручну',
      description:
        'Ручне зведення перекриває підказки, але не арифметику: сума має збігатися з ' +
        'підсумком замовлення з допуском ±0.01, інакше 422 `TRANSACTION_AMOUNT_MISMATCH`.',
      parameters: [idParameter],
      requestBody: jsonBody({
        type: 'object',
        required: ['version', 'orderId'],
        properties: {
          version: versionSchema,
          orderId: { type: 'string', format: 'uuid' },
        },
      }),
      responses: {
        '200': dataResponse('Транзакцію зведено', transactionSchema),
        ...securedErrors,
        '404': errorRef('NotFound'),
        '409': errorRef('Conflict'),
        '422': errorRef('UnprocessableEntity'),
      },
    },
    delete: {
      ...securedOperation,
      tags: ['Finance'],
      summary: 'Зняти зведення транзакції',
      parameters: [
        idParameter,
        { name: 'version', in: 'query', required: true, schema: versionSchema },
      ],
      responses: {
        '200': dataResponse('Зведення знято', transactionSchema),
        ...securedErrors,
        '404': errorRef('NotFound'),
        '409': errorRef('Conflict'),
      },
    },
  },
} as const;
