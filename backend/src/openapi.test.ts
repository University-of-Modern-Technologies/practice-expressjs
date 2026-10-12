import { beforeAll, describe, expect, it } from '@jest/globals';

import { RESPONSE_DESCRIPTIONS } from './common/openapi/index.js';
import { contactSortFields } from './modules/contacts/types.js';
import { createOpenApiDocument } from './openapi.js';

interface Operation {
  operationId?: string;
  tags?: string[];
  security?: readonly Record<string, readonly string[]>[];
  parameters?: readonly { name: string; in: string; schema?: unknown }[];
  responses?: Record<string, unknown>;
}
type PathItem = Record<string, Operation>;

interface Document {
  openapi?: string;
  tags?: { name: string }[];
  paths?: Record<string, PathItem>;
  components?: {
    securitySchemes?: Record<string, unknown>;
    responses?: Record<string, unknown>;
    schemas?: Record<string, { required?: string[]; properties?: Record<string, unknown> }> & {
      Deal?: { required?: string[]; properties?: Record<string, unknown> };
      DealStage?: { enum?: string[] };
    };
  };
}

let document: Document;
let paths: Record<string, PathItem>;

beforeAll(async () => {
  document = (await createOpenApiDocument()) as unknown as Document;
  paths = document.paths ?? {};
});

const httpMethods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'];

const operations = (): { path: string; method: string; operation: Operation }[] =>
  Object.entries(paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => httpMethods.includes(method))
      .map(([method, operation]) => ({ path, method, operation })),
  );

const errorResponse = (status: keyof typeof RESPONSE_DESCRIPTIONS): unknown => ({
  description: RESPONSE_DESCRIPTIONS[status],
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
});

const conflict = errorResponse(409);

/** Collects every `$ref` string anywhere in the document. */
const collectRefs = (value: unknown, found: string[] = []): string[] => {
  if (Array.isArray(value)) {
    for (const entry of value) collectRefs(entry, found);
    return found;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === '$ref' && typeof entry === 'string') found.push(entry);
      else collectRefs(entry, found);
    }
  }
  return found;
};

const resolveRef = (ref: string): unknown => {
  const segments = ref.replace(/^#\//, '').split('/');
  let current: unknown = document;
  for (const segment of segments) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

describe('createOpenApiDocument', () => {
  it('is an OpenAPI 3.1 document', () => {
    expect(document.openapi).toBe('3.1.0');
  });

  it('takes the request parameters from the schema that validates the request', () => {
    const sortBy = paths['/api/v1/contacts']?.get?.parameters?.find(
      (parameter) => parameter.name === 'sortBy',
    );

    expect(sortBy).toMatchObject({
      in: 'query',
      schema: { type: 'string', enum: [...contactSortFields], default: 'createdAt' },
    });
  });

  it('publishes dates the way they travel: as ISO 8601 strings', () => {
    expect(document.components?.schemas?.Contact?.properties).toMatchObject({
      createdAt: { type: 'string', format: 'date-time' },
    });
  });

  it('keeps no component schema that nothing refers to', () => {
    const referenced = new Set(collectRefs(document));
    const orphans = Object.keys(document.components?.schemas ?? {}).filter(
      (name) => !referenced.has(`#/components/schemas/${name}`),
    );

    expect(orphans).toEqual([]);
  });

  it('documents both verbs mounted on a single warehouse', () => {
    const item = paths['/api/v1/warehouse/warehouses/{id}'];

    expect(Object.keys(item ?? {}).sort()).toEqual(['get', 'patch']);
    expect(item?.get?.security).toEqual([{ bearerAuth: [] }]);
    expect(item?.get?.responses?.['404']).toEqual(errorResponse(404));
  });

  it('registers a tag for every tag used by an operation', () => {
    const declared = new Set((document.tags ?? []).map((tag) => tag.name));
    const used = new Set(operations().flatMap(({ operation }) => operation.tags ?? []));

    expect([...used].filter((tag) => !declared.has(tag))).toEqual([]);
  });

  it('defines bearer and refresh-cookie authentication', () => {
    expect(document.components?.securitySchemes).toMatchObject({
      bearerAuth: { type: 'http', scheme: 'bearer' },
      refreshCookie: { type: 'apiKey', in: 'cookie', name: 'refresh_token' },
    });
  });

  it('documents the canonical deal stages and optimistic concurrency version', () => {
    expect(document.components?.schemas?.DealStage?.enum).toEqual([
      'LEAD',
      'QUALIFIED',
      'PROPOSAL',
      'WON',
      'LOST',
    ]);
    expect(document.components?.schemas?.Deal?.required).toContain('version');
    expect(document.components?.schemas?.Deal?.properties).toMatchObject({
      version: { type: 'integer', minimum: 1 },
    });
  });

  it('keeps monetary fields as decimal strings', () => {
    expect(document.components?.schemas?.Order?.properties).toMatchObject({
      total: { type: 'string' },
    });
    expect(document.components?.schemas?.Product?.properties).toMatchObject({
      unitPrice: { type: 'string' },
    });
  });

  it('documents the order transition operation with its guard rails', () => {
    const operation = paths['/api/v1/orders/{id}/transitions']?.post;

    expect(operation?.security).toEqual([{ bearerAuth: [] }]);
    expect(Object.keys(operation?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '400', '401', '403', '404', '409', '500']),
    );
    expect(operation?.responses?.['409']).toEqual(conflict);
  });

  it('documents the stock reservation operation with its conflict responses', () => {
    const operation = paths['/api/v1/warehouse/stock/reserve']?.post;

    expect(operation?.security).toEqual([{ bearerAuth: [] }]);
    // The stock operations update a level in place, so they answer 200.
    expect(operation?.responses?.['200']).toBeDefined();
    expect(operation?.responses?.['201']).toBeUndefined();
    expect(operation?.responses?.['401']).toEqual(errorResponse(401));
    expect(operation?.responses?.['403']).toEqual(errorResponse(403));
    expect(operation?.responses?.['409']).toEqual(conflict);
  });

  it('documents the assistant operations with their upstream failure modes', () => {
    const operation = paths['/api/v1/ai/classify/inquiry']?.post;

    expect(operation?.security).toEqual([{ bearerAuth: [] }]);
    expect(Object.keys(operation?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '400', '401', '403', '500', '502', '503', '504']),
    );
  });

  it('gives every path item at least one operation with at least one response', () => {
    for (const item of Object.values(paths)) {
      const methods = Object.keys(item).filter((key) => httpMethods.includes(key));
      expect(methods.length).toBeGreaterThan(0);
      for (const method of methods) {
        expect(Object.keys(item[method]?.responses ?? {}).length).toBeGreaterThan(0);
      }
    }
    expect.hasAssertions();
  });

  it('resolves every $ref against the document', () => {
    const unresolved = [...new Set(collectRefs(document))].filter(
      (ref) => resolveRef(ref) === undefined,
    );

    expect(unresolved).toEqual([]);
  });

  it('identifies every operation, and never two with the same operationId', () => {
    const ids = operations().map(({ operation }) => operation.operationId);

    expect(ids.filter((id) => typeof id !== 'string')).toEqual([]);
    expect(ids).toHaveLength(new Set(ids).size);
    expect(paths['/api/v1/products/{id}']?.get?.operationId).toBe('get_api_v1_products_id');
    expect(paths['/api/v1/auth/login']?.post?.operationId).toBe('post_api_v1_auth_login');
  });

  it('declares every response inline, without shared response components', () => {
    const shared = collectRefs(document).filter((ref) => ref.startsWith('#/components/responses/'));

    expect(document.components?.responses).toBeUndefined();
    expect(shared).toEqual([]);
  });

  it('describes the refresh cookie the session operations read', () => {
    for (const path of ['/api/v1/auth/refresh', '/api/v1/auth/logout']) {
      expect(paths[path]?.post?.parameters).toEqual([
        { in: 'cookie', name: 'refresh_token', schema: { type: 'string' } },
      ]);
    }
  });
});
