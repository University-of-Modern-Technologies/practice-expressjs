export const jsonBody = (schema: object, required = true): Record<string, unknown> => ({
  required,
  content: { 'application/json': { schema } },
});

export const dataResponse = (description: string, schema: object): Record<string, unknown> => ({
  description,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['data'],
        properties: { data: schema },
      },
    },
  },
});

export const noContentResponse = (description: string): Record<string, unknown> => ({
  description,
});

/** Envelope shared by every paginated list endpoint. */
export const pageResponse = (description: string, items: object): Record<string, unknown> =>
  dataResponse(description, {
    type: 'object',
    required: ['items', 'page', 'pageSize', 'total'],
    properties: {
      items: { type: 'array', items },
      page: { type: 'integer' },
      pageSize: { type: 'integer' },
      total: { type: 'integer' },
    },
  });

export const errorRef = (name: string): { $ref: string } => ({
  $ref: `#/components/responses/${name}`,
});

export const securedErrors = {
  '400': errorRef('BadRequest'),
  '401': errorRef('Unauthorized'),
  '403': errorRef('Forbidden'),
  '500': errorRef('InternalServerError'),
} as const;

export const securedOperation = {
  security: [{ bearerAuth: [] }],
} as const;

export const idParameter = { $ref: '#/components/parameters/IdPath' } as const;
export const pageParameters20 = [
  { $ref: '#/components/parameters/Page' },
  { $ref: '#/components/parameters/PageSize20' },
] as const;
export const pageParameters25 = [
  { $ref: '#/components/parameters/Page' },
  { $ref: '#/components/parameters/PageSize25' },
] as const;
