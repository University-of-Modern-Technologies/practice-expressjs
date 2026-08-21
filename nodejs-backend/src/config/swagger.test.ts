import { openApiDocument } from './swagger.js';

interface Operation {
  operationId?: string;
  tags?: string[];
  security?: readonly Record<string, readonly string[]>[];
  responses?: Record<string, unknown>;
}
type PathItem = Record<string, Operation>;

const document = openApiDocument as {
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
};

const httpMethods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'];

const paths = document.paths ?? {};

const operations = (): { path: string; method: string; operation: Operation }[] =>
  Object.entries(paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => httpMethods.includes(method))
      .map(([method, operation]) => ({ path, method, operation })),
  );

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

describe('openApiDocument', () => {
  it('documents every mounted API path', () => {
    expect(Object.keys(paths)).toEqual(
      expect.arrayContaining([
        '/health/live',
        '/health/ready',
        '/api/v1/auth/login',
        '/api/v1/auth/refresh',
        '/api/v1/auth/logout',
        '/api/v1/auth/me',
        '/api/v1/users',
        '/api/v1/users/{id}',
        '/api/v1/users/{id}/sessions',
        '/api/v1/users/{id}/sessions/{sessionId}',
        '/api/v1/users/{id}/disable',
        '/api/v1/rbac/check/{resource}/{action}',
        '/api/v1/rbac/roles',
        '/api/v1/rbac/roles/{id}/permissions',
        '/api/v1/contacts',
        '/api/v1/contacts/{id}',
        '/api/v1/deals',
        '/api/v1/deals/{id}',
        '/api/v1/deals/{id}/transitions',
        '/api/v1/audit',
        '/api/v1/audit/{resource}/{resourceId}',
        '/api/v1/audit/{id}',
        '/api/v1/products',
        '/api/v1/products/{id}',
        '/api/v1/orders',
        '/api/v1/orders/{id}',
        '/api/v1/orders/{id}/duplicate',
        '/api/v1/orders/{id}/items',
        '/api/v1/orders/{id}/items/{itemId}',
        '/api/v1/orders/{id}/transitions',
        '/api/v1/warehouse/warehouses',
        '/api/v1/warehouse/warehouses/{id}',
        '/api/v1/warehouse/stock',
        '/api/v1/warehouse/stock/{warehouseId}/{productId}',
        '/api/v1/warehouse/stock/receive',
        '/api/v1/warehouse/stock/issue',
        '/api/v1/warehouse/stock/reserve',
        '/api/v1/warehouse/stock/release',
        '/api/v1/warehouse/stock/adjust',
        '/api/v1/warehouse/movements',
        '/api/v1/settings',
        '/api/v1/settings/{key}',
        '/api/v1/analytics/sales-summary',
        '/api/v1/analytics/deal-funnel',
        '/api/v1/analytics/top-products',
        '/api/v1/analytics/owner-performance',
        '/api/v1/analytics/stock-health',
        '/api/v1/integrations/health',
        '/api/v1/integrations/delivery/quotes',
        '/api/v1/integrations/delivery/shipments',
        '/api/v1/integrations/delivery/shipments/{id}',
        '/api/v1/ai/summaries/deal',
        '/api/v1/ai/classify/inquiry',
      ]),
    );
  });

  it('documents the expected number of paths and operations', () => {
    expect(Object.keys(paths)).toHaveLength(54);
    expect(operations()).toHaveLength(74);
  });

  it('documents both verbs mounted on a single warehouse', () => {
    const item = paths['/api/v1/warehouse/warehouses/{id}'];

    expect(Object.keys(item ?? {}).sort()).toEqual(['get', 'patch']);
    expect(item?.get?.security).toEqual([{ bearerAuth: [] }]);
    expect(item?.get?.responses?.['404']).toEqual({ $ref: '#/components/responses/NotFound' });
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
    expect(operation?.responses?.['409']).toEqual({ $ref: '#/components/responses/Conflict' });
  });

  it('documents the stock reservation operation with its conflict responses', () => {
    const operation = paths['/api/v1/warehouse/stock/reserve']?.post;

    expect(operation?.security).toEqual([{ bearerAuth: [] }]);
    // The stock operations update a level in place, so they answer 200.
    expect(operation?.responses?.['200']).toBeDefined();
    expect(operation?.responses?.['201']).toBeUndefined();
    expect(operation?.responses?.['401']).toEqual({
      $ref: '#/components/responses/Unauthorized',
    });
    expect(operation?.responses?.['403']).toEqual({ $ref: '#/components/responses/Forbidden' });
    expect(operation?.responses?.['409']).toEqual({ $ref: '#/components/responses/Conflict' });
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

  it('never repeats an operationId', () => {
    const ids = operations()
      .map(({ operation }) => operation.operationId)
      .filter((id): id is string => typeof id === 'string');

    expect(ids).toHaveLength(new Set(ids).size);
  });
});
