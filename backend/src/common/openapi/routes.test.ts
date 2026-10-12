import { describe, expect, it } from '@jest/globals';
import express, { Router, type RequestHandler } from 'express';
import request from 'supertest';
import { z } from 'zod';

import { validate } from '../middleware/validate.js';
import { ok, type ApiOperation } from './operations.js';
import { refusals } from './refusals.js';
import { declaredTags, describedOperations, describeRoutes } from './routes.js';

const operation: ApiOperation = {
  summary: 'Read a widget',
  response: ok('The widget', z.object({ id: z.string() })),
  refusals: refusals(404),
};

const widgetSchema = z.object({ params: z.object({ id: z.string().min(3) }) });

describe('describeRoutes', () => {
  it('serves the handler chain in the order it was given', async () => {
    const router = Router();
    const calls: string[] = [];
    const step =
      (name: string): RequestHandler =>
      (_request, _response, next) => {
        calls.push(name);
        next();
      };

    describeRoutes(router, [{ name: 'Widgets', description: 'Widgets' }]).get(
      '/:id',
      operation,
      step('first'),
      step('second'),
      (request, response) => {
        response.status(200).json({ data: { id: request.params.id } });
      },
    );
    const response = await request(express().use('/widgets', router)).get('/widgets/abc');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { id: 'abc' } });
    expect(calls).toEqual(['first', 'second']);
  });

  it('describes a route with the schema its validate() middleware enforces', () => {
    const router = Router();
    describeRoutes(router, [{ name: 'Widgets', description: 'Widgets' }]).get(
      '/:id',
      operation,
      validate(widgetSchema),
      (_request, response) => response.end(),
    );

    const [described] = describedOperations([{ path: '/api/v1/widgets', router }]);

    expect(described).toMatchObject({
      method: 'get',
      path: '/api/v1/widgets/{id}',
      defaultTag: 'Widgets',
      operation,
    });
    expect(described?.request).toBe(widgetSchema);
  });

  it('leaves a route registered on the plain router out of the description', () => {
    const router = Router();
    describeRoutes(router, [{ name: 'Widgets', description: 'Widgets' }]).get(
      '/',
      operation,
      (_request, response) => response.end(),
    );
    router.get('/plain', (_request, response) => response.end());

    expect(
      describedOperations([{ path: '/api/v1/widgets', router }]).map(({ path }) => path),
    ).toEqual(['/api/v1/widgets']);
  });

  it('keeps the tags of every router in mount order', () => {
    const first = Router();
    const second = Router();
    describeRoutes(first, [{ name: 'A', description: 'A' }]);
    describeRoutes(second, [{ name: 'B', description: 'B' }]);

    expect(
      declaredTags([
        { path: '/b', router: second },
        { path: '/a', router: first },
      ]).map(({ name }) => name),
    ).toEqual(['B', 'A']);
  });

  it('refuses a request schema declared beside a validate() middleware', () => {
    const routes = describeRoutes(Router(), [{ name: 'Widgets', description: 'Widgets' }]);

    expect(() => {
      routes.get('/:id', { ...operation, request: widgetSchema }, validate(widgetSchema));
    }).toThrow('declares a request schema and also validates one');
  });

  it('refuses to describe the same router twice', () => {
    const router = Router();
    describeRoutes(router, [{ name: 'Widgets', description: 'Widgets' }]);

    expect(() => describeRoutes(router, [])).toThrow('already described');
  });
});
