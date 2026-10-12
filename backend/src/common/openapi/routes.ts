/**
 * Registering a route and describing it are one call.
 *
 * `describeRoutes(router, tags)` returns `get`, `post`, `put`, `patch` and
 * `delete` that take the path, what the operation is, and then the handler
 * chain. The chain goes to Express untouched, exactly as `router.get(path,
 * ...handlers)` would register it; the description is kept beside the route,
 * and the document is later built by walking the routers that are mounted.
 *
 * The request schema is not repeated: it is read from the `validate()`
 * middleware in the chain. A route registered with a plain `router.get` is
 * served all the same, but stays out of the description, and a test that
 * compares the mounted routes with the document reports it.
 */
import type { RequestHandler, Router } from 'express';
import { z } from 'zod';

import { validatedSchemaOf } from '../middleware/validate.js';
import {
  toPathTemplate,
  type ApiOperation,
  type ApiTag,
  type DescribedOperation,
  type HttpMethod,
  type RequestSchema,
} from './operations.js';

type RegisterRoute = (path: string, operation: ApiOperation, ...handlers: RequestHandler[]) => void;

export type DescribedRoutes = Readonly<Record<HttpMethod, RegisterRoute>>;

/** A router and the prefix it is mounted at. */
export interface MountedRouter {
  readonly path: string;
  readonly router: Router;
}

interface DescribedRoute {
  readonly operation: ApiOperation;
  readonly request: RequestSchema | undefined;
}

// Keyed by the objects Express itself keeps, so nothing is added to the chain
// a request runs through and nothing outlives the router it describes.
const tagsByRouter = new WeakMap<Router, readonly ApiTag[]>();
const describedByRoute = new WeakMap<object, Map<HttpMethod, DescribedRoute>>();

const HTTP_METHODS: readonly HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];

const requestSchemaOf = (
  path: string,
  operation: ApiOperation,
  handlers: readonly RequestHandler[],
): RequestSchema | undefined => {
  const validated = handlers.flatMap((handler) => validatedSchemaOf(handler) ?? []);
  if (validated.length > 1) {
    throw new Error(`Route ${path} validates its request more than once`);
  }
  if (validated.length === 1 && operation.request) {
    throw new Error(`Route ${path} declares a request schema and also validates one`);
  }
  const [schema] = validated;
  if (schema === undefined) return operation.request;
  if (!(schema instanceof z.ZodObject)) {
    throw new Error(`Route ${path} validates with a schema that is not an object`);
  }
  return schema;
};

export const describeRoutes = (router: Router, tags: readonly ApiTag[]): DescribedRoutes => {
  if (tagsByRouter.has(router)) {
    throw new Error('The routes of this router are already described');
  }
  tagsByRouter.set(router, tags);

  const register =
    (method: HttpMethod): RegisterRoute =>
    (path, operation, ...handlers) => {
      // What `router[method](path, ...handlers)` does, keeping hold of the route.
      const route = router.route(path);
      route[method](...handlers);

      const described = describedByRoute.get(route) ?? new Map<HttpMethod, DescribedRoute>();
      described.set(method, { operation, request: requestSchemaOf(path, operation, handlers) });
      describedByRoute.set(route, described);
    };

  return {
    get: register('get'),
    post: register('post'),
    put: register('put'),
    patch: register('patch'),
    delete: register('delete'),
  };
};

interface RouteLayer {
  readonly route?: { readonly path: string };
}

/** The tags the routers declared, in the order they are mounted. */
export const declaredTags = (mounted: readonly MountedRouter[]): ApiTag[] =>
  mounted.flatMap(({ router }) => tagsByRouter.get(router) ?? []);

/** Every described operation of the mounted routers, in registration order. */
export const describedOperations = (mounted: readonly MountedRouter[]): DescribedOperation[] =>
  mounted.flatMap(({ path: mountPath, router }) => {
    const defaultTag = tagsByRouter.get(router)?.[0]?.name;
    const layers = (router as unknown as { stack: readonly RouteLayer[] }).stack;

    return layers.flatMap(({ route }) => {
      const described = route ? describedByRoute.get(route) : undefined;
      if (!route || !described) return [];
      const path = toPathTemplate(`${mountPath}${route.path === '/' ? '' : route.path}`);

      return HTTP_METHODS.flatMap((method) => {
        const entry = described.get(method);
        return entry ? [{ method, path, defaultTag, ...entry }] : [];
      });
    });
  });
