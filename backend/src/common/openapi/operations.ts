import { z } from 'zod';
import type {
  ZodOpenApiContentObject,
  ZodOpenApiOperationObject,
  ZodOpenApiParameters,
  ZodOpenApiResponseObject,
} from 'zod-openapi';

import { UNIVERSAL_RESPONSES, type Refusals } from './refusals.js';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/**
 * The schema a route hands to `validate()`: an object with any of `params`,
 * `query` and `body`. A route that reads a cookie may also name `cookies`.
 * Describing an operation with the very same schema is what keeps the published
 * parameters and fields from drifting away from the checks.
 */
export type RequestSchema = z.ZodObject;

export interface SuccessResponse {
  readonly status: '200' | '201' | '204';
  readonly response: ZodOpenApiResponseObject;
}

/** Who may call an operation, in the terms of the declared security schemes. */
export type Access = 'bearer' | 'refreshCookie' | 'optionalRefreshCookie' | 'public';

/** What a route registration says about the operation it serves. */
export interface ApiOperation {
  readonly summary: string;
  readonly description?: string;
  /** Defaults to the first tag the router declared. */
  readonly tags?: readonly string[];
  /** Defaults to `bearer`. */
  readonly access?: Access;
  /**
   * Only for a route that validates inside its handler. Otherwise the request
   * schema is read from the `validate()` middleware in the route's chain.
   */
  readonly request?: RequestSchema;
  readonly response: SuccessResponse;
  /** Declared by hand: see `refusals()`. */
  readonly refusals: Refusals;
}

export interface ApiTag {
  readonly name: string;
  readonly description: string;
}

const dataEnvelope = (data: z.ZodType): z.ZodObject => z.object({ data });

const jsonContent = (schema: z.ZodType): ZodOpenApiContentObject => ({
  'application/json': { schema },
});

/** 200 with `{ data }`. */
export const ok = (description: string, data: z.ZodType): SuccessResponse => ({
  status: '200',
  response: { description, content: jsonContent(dataEnvelope(data)) },
});

/** 201 with `{ data }`. */
export const created = (description: string, data: z.ZodType): SuccessResponse => ({
  status: '201',
  response: { description, content: jsonContent(dataEnvelope(data)) },
});

/** 204 without a body. */
export const noContent = (description: string): SuccessResponse => ({
  status: '204',
  response: { description },
});

/** 200 whose body is not the `{ data }` envelope, such as a file download. */
export const okWith = (response: ZodOpenApiResponseObject): SuccessResponse => ({
  status: '200',
  response,
});

const SECURITY: Record<Access, ZodOpenApiOperationObject['security']> = {
  bearer: [{ bearerAuth: [] }],
  refreshCookie: [{ refreshCookie: [] }],
  // The cookie is read when present, and the call succeeds without it too.
  optionalRefreshCookie: [{ refreshCookie: [] }, {}],
  public: undefined,
};

/** Only the business API runs its input through validation. */
const VALIDATED_PATH_PREFIX = '/api/v1/';

const shapeOf = (request: RequestSchema | undefined): Record<string, z.ZodType | undefined> =>
  (request?.shape ?? {}) as Record<string, z.ZodType | undefined>;

const requestParams = (request: RequestSchema | undefined): ZodOpenApiParameters | undefined => {
  const { params, query, cookies } = shapeOf(request);
  if (!params && !query && !cookies) return undefined;
  return {
    ...(params ? { path: params as z.ZodObject } : {}),
    ...(query ? { query: query as z.ZodObject } : {}),
    ...(cookies ? { cookie: cookies as z.ZodObject } : {}),
  };
};

/** The object a body schema checks, seen through `.optional()`. */
const bodyObject = (body: z.ZodType): z.ZodObject | undefined => {
  const inner = body instanceof z.ZodOptional ? body.unwrap() : body;
  return inner instanceof z.ZodObject ? inner : undefined;
};

const requestBody = (
  request: RequestSchema | undefined,
): ZodOpenApiOperationObject['requestBody'] => {
  const { body } = shapeOf(request);
  if (!body) return undefined;

  const optional = body.safeParse(undefined).success;
  // A body that may be left out and names no field is accepted and ignored:
  // there is nothing in it a client could send on purpose.
  const object = bodyObject(body);
  if (optional && object && Object.keys(object.shape).length === 0) return undefined;

  return {
    required: !optional,
    content: { 'application/json': { schema: body } },
  };
};

/** `/:id` as Express writes it is `/{id}` as the description writes it. */
export const toPathTemplate = (path: string): string => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

/**
 * One rule for every operation, shared with the sibling implementation of this
 * API so both publish the same identifiers: the method and the full path, every
 * run of other characters turned into `_`, lower case. `GET /api/v1/products/{id}`
 * is `get_api_v1_products_id`.
 */
export const operationIdFor = (method: HttpMethod, pathTemplate: string): string =>
  `${method}_${pathTemplate}`
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();

export interface DescribedOperation {
  readonly method: HttpMethod;
  /** The full path in description syntax: `/api/v1/products/{id}`. */
  readonly path: string;
  readonly operation: ApiOperation;
  /** The request schema, whether declared or read from `validate()`. */
  readonly request: RequestSchema | undefined;
  readonly defaultTag: string | undefined;
}

export const toOperationObject = ({
  method,
  path,
  operation,
  request,
  defaultTag,
}: DescribedOperation): ZodOpenApiOperationObject => {
  const security = SECURITY[operation.access ?? 'bearer'];
  const parameters = requestParams(request);
  const body = requestBody(request);
  const tags = operation.tags ?? (defaultTag ? [defaultTag] : undefined);

  return {
    operationId: operationIdFor(method, path),
    ...(tags ? { tags: [...tags] } : {}),
    summary: operation.summary,
    ...(operation.description ? { description: operation.description } : {}),
    ...(security ? { security } : {}),
    ...(parameters ? { requestParams: parameters } : {}),
    ...(body ? { requestBody: body } : {}),
    responses: {
      [operation.response.status]: operation.response.response,
      ...operation.refusals,
      ...(path.startsWith(VALIDATED_PATH_PREFIX) ? { '400': UNIVERSAL_RESPONSES.badRequest } : {}),
      '500': UNIVERSAL_RESPONSES.internalServerError,
    },
  };
};
