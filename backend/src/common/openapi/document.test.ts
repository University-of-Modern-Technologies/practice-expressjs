import { describe, expect, it } from '@jest/globals';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import { validate } from '../middleware/validate.js';
import { buildOpenApiDocument } from './document.js';
import { ok, okWith } from './operations.js';
import { refusals, RESPONSE_DESCRIPTIONS } from './refusals.js';
import { describeRoutes } from './routes.js';

interface Schema {
  readonly type?: string;
  readonly format?: string;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly default?: unknown;
  readonly additionalProperties?: unknown;
  readonly properties?: Record<string, Schema>;
}

const recordSchema = z
  .object({
    id: z.uuid(),
    count: z.int().min(0),
    createdAt: z.date(),
  })
  .meta({ id: 'Record' });

const handler: RequestHandler = (_request, response) => {
  response.end();
};

const recordsRouter = Router();
describeRoutes(recordsRouter, [{ name: 'Records', description: 'Records' }]).post(
  '/:id',
  {
    summary: 'Update a record',
    response: ok('The record', recordSchema),
    refusals: refusals(401, 404),
  },
  validate(
    z.object({
      params: z.object({ id: z.uuid() }),
      query: z.object({
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .transform((value) => Math.min(value, 100))
          .default(10),
      }),
      body: z.strictObject({ count: z.int().min(0) }),
    }),
  ),
  handler,
);
// Served, but not described.
recordsRouter.get('/plain', handler);

const probesRouter = Router();
describeRoutes(probesRouter, [{ name: 'Probes', description: 'Probes' }]).get(
  '/live',
  {
    summary: 'Probe',
    access: 'public',
    response: okWith({ description: 'Up' }),
    refusals: {},
  },
  handler,
);

const document = buildOpenApiDocument([
  { path: '/api/probe', router: probesRouter },
  { path: '/api/v1/records', router: recordsRouter },
]) as unknown as {
  openapi: string;
  tags: { name: string }[];
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: { schemas: Record<string, Schema>; responses?: unknown };
};

const operation = document.paths['/api/v1/records/{id}']?.post as {
  operationId: string;
  parameters: { name: string; schema: Schema }[];
  requestBody: { content: { 'application/json': { schema: Schema } } };
  responses: Record<string, unknown>;
};

const parameter = (name: string): Schema | undefined =>
  operation.parameters.find((entry) => entry.name === name)?.schema;

describe('buildOpenApiDocument', () => {
  it('describes what the mounted routers registered, and their tags, in one 3.1 document', () => {
    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.paths).sort()).toEqual(['/api/probe/live', '/api/v1/records/{id}']);
    expect(document.tags.map(({ name }) => name)).toEqual(['Probes', 'Records']);
  });

  it('identifies every operation by its method and path', () => {
    expect(operation.operationId).toBe('post_api_v1_records_id');
    expect(document.paths['/api/probe/live']?.get?.operationId).toBe('get_api_probe_live');
  });

  it('publishes the shared error envelope and no shared responses', () => {
    expect(document.components.schemas.ErrorResponse).toBeDefined();
    expect(document.components.responses).toBeUndefined();
    expect(operation.responses['404']).toEqual({
      description: RESPONSE_DESCRIPTIONS[404],
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
    });
  });

  it('publishes a date as the ISO 8601 string it is sent as', () => {
    expect(document.components.schemas.Record?.properties?.createdAt).toEqual({
      type: 'string',
      format: 'date-time',
    });
  });

  it('drops what Zod adds that is not a rule of the API', () => {
    const record = document.components.schemas.Record;

    expect(record?.properties?.id).toEqual({ type: 'string', format: 'uuid' });
    expect(record?.properties?.count).toEqual({ type: 'integer', minimum: 0 });
    expect(parameter('id')).toEqual({ type: 'string', format: 'uuid' });
  });

  it('states a default that follows a transform', () => {
    expect(parameter('limit')).toMatchObject({ type: 'integer', minimum: 1, default: 10 });
  });

  it('keeps a request closed when the schema rejects unknown fields, and responses open', () => {
    expect(operation.requestBody.content['application/json'].schema.additionalProperties).toBe(
      false,
    );
    expect(document.components.schemas.Record?.additionalProperties).toBeUndefined();
  });
});
