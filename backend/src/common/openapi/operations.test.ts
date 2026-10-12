import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import type { ZodOpenApiOperationObject } from 'zod-openapi';

import {
  created,
  noContent,
  ok,
  operationIdFor,
  toOperationObject,
  toPathTemplate,
  type ApiOperation,
  type DescribedOperation,
  type RequestSchema,
} from './operations.js';
import { refusals, RESPONSE_DESCRIPTIONS } from './refusals.js';

const itemSchema = z.object({ id: z.uuid(), name: z.string() });

type Overrides = Partial<Omit<DescribedOperation, 'operation'>> & {
  readonly operation?: Partial<ApiOperation>;
};

/** A described `POST /api/v1/widgets`, with whatever a test changes in it. */
const objectOf = ({ operation, ...rest }: Overrides): ZodOpenApiOperationObject =>
  toOperationObject({
    method: 'post',
    path: '/api/v1/widgets',
    request: undefined,
    defaultTag: 'Widgets',
    ...rest,
    operation: {
      summary: 'Create a widget',
      response: created('Created', itemSchema),
      refusals: refusals(401, 403, 409),
      ...operation,
    },
  });

describe('toPathTemplate', () => {
  it('turns Express parameters into description templates', () => {
    expect(toPathTemplate('/api/v1/orders/:id/items/:itemId')).toBe(
      '/api/v1/orders/{id}/items/{itemId}',
    );
  });
});

describe('operationIdFor', () => {
  it('joins the method and the path, every other run of characters becoming one underscore', () => {
    expect(operationIdFor('get', '/api/v1/products/{id}')).toBe('get_api_v1_products_id');
    expect(operationIdFor('post', '/api/v1/auth/login')).toBe('post_api_v1_auth_login');
    expect(operationIdFor('get', '/api/v1/analytics/{report}/export')).toBe(
      'get_api_v1_analytics_report_export',
    );
  });

  it('lowercases the parameter names and the segments', () => {
    expect(operationIdFor('delete', '/api/v1/users/{id}/sessions/{sessionId}')).toBe(
      'delete_api_v1_users_id_sessions_sessionid',
    );
    expect(operationIdFor('get', '/api/v1/analytics/sales-summary')).toBe(
      'get_api_v1_analytics_sales_summary',
    );
  });
});

describe('toOperationObject', () => {
  it('tags an operation with the default tag unless it names its own', () => {
    expect(objectOf({}).tags).toEqual(['Widgets']);
    expect(objectOf({ operation: { tags: ['Widget sessions'] } }).tags).toEqual([
      'Widget sessions',
    ]);
  });

  it('secures operations with the bearer token by default', () => {
    expect(objectOf({}).security).toEqual([{ bearerAuth: [] }]);
    expect(objectOf({ operation: { access: 'public' } }).security).toBeUndefined();
    expect(objectOf({ operation: { access: 'optionalRefreshCookie' } }).security).toEqual([
      { refreshCookie: [] },
      {},
    ]);
  });

  it('adds 400 and 500 to an operation of the business API', () => {
    expect(Object.keys(objectOf({}).responses).sort()).toEqual([
      '201',
      '400',
      '401',
      '403',
      '409',
      '500',
    ]);
  });

  it('adds only 500 outside the business API, where no input is validated', () => {
    const probe = objectOf({
      method: 'get',
      path: '/api/health/live',
      operation: { response: ok('Up', z.object({})), refusals: refusals() },
    });

    expect(Object.keys(probe.responses).sort()).toEqual(['200', '500']);
  });

  it('declares 400 and 500 inline, with the error envelope', () => {
    const { responses } = objectOf({});

    expect(responses['400']).toMatchObject({ description: RESPONSE_DESCRIPTIONS[400] });
    expect(responses['500']).toMatchObject({ description: RESPONSE_DESCRIPTIONS[500] });
    expect(Object.keys((responses['400'] as { content: object }).content)).toEqual([
      'application/json',
    ]);
  });

  it('wraps a success body in the data envelope', () => {
    const response = objectOf({}).responses['201'] as {
      content: Record<string, { schema: z.ZodObject }>;
    };

    expect(Object.keys(response.content['application/json']?.schema.shape ?? {})).toEqual(['data']);
  });

  it('takes path, query and cookie parameters and the body from the request schema', () => {
    const request: RequestSchema = z.object({
      params: z.object({ id: z.uuid() }),
      query: z.object({ page: z.coerce.number().int().default(1) }),
      cookies: z.object({ session: z.string().optional() }),
      body: z.object({ name: z.string() }),
    });
    const operation = objectOf({ request });

    expect(operation.requestParams?.path).toBeDefined();
    expect(operation.requestParams?.query).toBeDefined();
    expect(operation.requestParams?.cookie).toBeDefined();
    expect(operation.requestBody).toMatchObject({ required: true });
  });

  it('marks a body the schema accepts as absent as optional', () => {
    const request = z.object({ body: z.object({ note: z.string() }).optional() });

    expect(objectOf({ request }).requestBody).toMatchObject({ required: false });
  });

  it('leaves out an optional body that names no field', () => {
    const request = z.object({ body: z.object({}).optional() });

    expect(objectOf({ request }).requestBody).toBeUndefined();
    expect(objectOf({ request }).requestParams).toBeUndefined();
  });

  it('describes a 204 without a body', () => {
    const operation = objectOf({ method: 'delete', operation: { response: noContent('Gone') } });

    expect(operation.responses['204']).toEqual({ description: 'Gone' });
  });

  it('identifies the operation by its method and path', () => {
    expect(objectOf({}).operationId).toBe('post_api_v1_widgets');
  });
});
