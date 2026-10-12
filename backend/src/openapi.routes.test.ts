import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { Router } from 'express';

import { createHealthRouter, HEALTH_PATH } from './app/index.js';
import { toPathTemplate } from './common/openapi/index.js';
import { createCompositionRoot } from './composition-root.js';
import { createOpenApiDocument } from './openapi.js';
import { createTestConfig } from './test/config.js';

/**
 * A route registered through `describeRoutes()` is described by construction;
 * one registered with a plain `router.get()` is served but stays out of the
 * description. This test lists both and turns red on the second kind, unless
 * the route is left out on purpose below.
 */

const compositionRoot = createCompositionRoot(createTestConfig());

afterAll(async () => {
  await compositionRoot.close();
});

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

// Served on purpose without a description: probes for the orchestrator and the
// description itself are infrastructure, not part of the API a client builds on.
const UNDESCRIBED = ['GET /api/health/startup', 'GET /api/health/info', 'GET /api/openapi.json'];

interface RouteLayer {
  readonly route?: { readonly path: string; readonly stack: readonly { method: string }[] };
}

const routeLayers = (router: Router | { stack: unknown }): readonly RouteLayer[] =>
  router.stack as readonly RouteLayer[];

const routesOf = (mountPath: string, router: Router | { stack: unknown }): string[] =>
  routeLayers(router).flatMap(({ route }) => {
    if (!route) return [];
    const path = toPathTemplate(`${mountPath}${route.path === '/' ? '' : route.path}`);
    return [...new Set(route.stack.map(({ method }) => method))]
      .filter((method) => HTTP_METHODS.includes(method))
      .map((method) => `${method.toUpperCase()} ${path}`);
  });

const mounted = (): string[] => {
  const app = compositionRoot.app as unknown as { router: { stack: unknown } };
  return [
    ...routesOf('', app.router),
    ...routesOf(HEALTH_PATH, createHealthRouter()),
    ...compositionRoot.routers.flatMap(({ path, router }) => routesOf(path, router)),
  ];
};

let documentPaths: Record<string, Record<string, unknown>>;

beforeAll(async () => {
  const document = (await createOpenApiDocument()) as unknown as {
    paths?: Record<string, Record<string, unknown>>;
  };
  documentPaths = document.paths ?? {};
});

const described = (): string[] =>
  Object.entries(documentPaths).flatMap(([path, item]) =>
    Object.keys(item)
      .filter((method) => HTTP_METHODS.includes(method))
      .map((method) => `${method.toUpperCase()} ${path}`),
  );

describe('API description against the mounted routes', () => {
  it('describes every mounted route', () => {
    const documented = new Set(described());
    const missing = mounted().filter(
      (route) => !documented.has(route) && !UNDESCRIBED.includes(route),
    );

    expect(missing).toEqual([]);
  });

  it('describes only routes that are mounted', () => {
    const served = new Set(mounted());

    expect(described().filter((route) => !served.has(route))).toEqual([]);
  });

  it('leaves out only routes that are still mounted', () => {
    const served = new Set(mounted());

    expect(UNDESCRIBED.filter((route) => !served.has(route))).toEqual([]);
  });

  it('finds the business routes through the composition root', () => {
    // Guards the walk itself: an Express upgrade that renamed the router stack
    // would otherwise leave both lists empty and every assertion above green.
    expect(mounted()).toEqual(
      expect.arrayContaining(['GET /api/v1/contacts', 'PATCH /api/v1/contacts/{id}']),
    );
  });
});
