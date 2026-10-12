import { beforeAll, describe, expect, it } from '@jest/globals';

import { createOpenApiDocument } from './openapi.js';

/**
 * The description derives the routes and the request and response shapes from
 * the code, but it cannot see an error thrown in a service below the handler.
 * Those refusals are declared by hand, so they can be forgotten; these rules
 * catch the forgetting that has a mechanical signature.
 */

interface Schema {
  readonly $ref?: string;
  readonly properties?: Record<string, unknown>;
}

interface Operation {
  readonly security?: readonly Record<string, readonly string[]>[];
  readonly parameters?: readonly { readonly name?: string; readonly $ref?: string }[];
  readonly requestBody?: { readonly content?: Record<string, { readonly schema?: Schema }> };
  readonly responses: Record<string, unknown>;
}

interface Document {
  readonly paths: Record<string, Record<string, Operation>>;
  readonly components: {
    readonly schemas: Record<string, Schema>;
    readonly parameters?: Record<string, { readonly name: string }>;
  };
}

let document: Document;

beforeAll(async () => {
  document = (await createOpenApiDocument()) as unknown as Document;
});

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

const operations = (): [string, Operation][] =>
  Object.entries(document.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => HTTP_METHODS.includes(method))
      .map(([method, operation]): [string, Operation] => [
        `${method.toUpperCase()} ${path}`,
        operation,
      ]),
  );

const resolve = <T>(node: T | { $ref: string }): T => {
  if (node && typeof node === 'object' && '$ref' in node && typeof node.$ref === 'string') {
    const segments = node.$ref.replace(/^#\//, '').split('/');
    let current: unknown = document;
    for (const segment of segments) current = (current as Record<string, unknown>)[segment];
    return current as T;
  }
  return node as T;
};

const bodySchema = (operation: Operation): Schema =>
  resolve(operation.requestBody?.content?.['application/json']?.schema ?? {});

const carriesAVersion = (operation: Operation): boolean => {
  const inQuery = (operation.parameters ?? []).some(
    (parameter) => resolve<{ name?: string }>(parameter).name === 'version',
  );
  const inBody = 'version' in (bodySchema(operation).properties ?? {});
  return inQuery || inBody;
};

/** An operation the caller cannot reach at all without a credential. */
const requiresCredentials = (operation: Operation): boolean =>
  (operation.security ?? []).length > 0 &&
  (operation.security ?? []).every((requirement) => Object.keys(requirement).length > 0);

describe('refusals in the API description', () => {
  it('documents the conflict on every operation that takes a version', () => {
    // A version is sent only so a stale one can be refused with 409.
    const versioned = operations().filter(([, operation]) => carriesAVersion(operation));
    const undocumented = versioned
      .filter(([, operation]) => !('409' in operation.responses))
      .map(([name]) => name);

    // Not vacuous: optimistic locking is spread across the whole API.
    expect(versioned.length).toBeGreaterThanOrEqual(10);
    expect(undocumented).toEqual([]);
  });

  it('documents the missing token on every secured operation', () => {
    const undocumented = operations()
      .filter(([, operation]) => requiresCredentials(operation))
      .filter(([, operation]) => !('401' in operation.responses))
      .map(([name]) => name);

    expect(undocumented).toEqual([]);
  });

  it('answers the versioned product update conflict with the error envelope', () => {
    // The case that showed the gap: a stale version answers 409.
    const conflict = resolve<{ content: Record<string, { schema: unknown }> }>(
      document.paths['/api/v1/products/{id}']?.patch?.responses['409'] as {
        content: Record<string, { schema: unknown }>;
      },
    );

    expect(conflict.content['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/ErrorResponse',
    });
  });

  it('keeps the refusal an upstream rejection is declared with', () => {
    const match = document.paths['/api/v1/finance/transactions/{id}/match']?.post?.responses;

    expect(Object.keys(match ?? {})).toContain('422');
  });

  it('describes 400 and 500 on every operation', () => {
    const incomplete = operations()
      .filter(([name]) => name.includes(' /api/v1/'))
      .filter(([, operation]) => !('400' in operation.responses && '500' in operation.responses))
      .map(([name]) => name);

    expect(incomplete).toEqual([]);
  });
});
