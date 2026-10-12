import type { RequestHandler } from 'express';
import type { z } from 'zod';

import { AppError } from '../errors/app-error.js';
import { describeValidationIssues } from '../errors/validation-error.js';

interface RequestInput {
  readonly body: unknown;
  readonly params: unknown;
  readonly query: unknown;
}

type RequestInputSchema = z.ZodType<Partial<RequestInput>>;

// Which schema each `validate()` middleware checks against. The API description
// reads it from here, so a route is described with the very schema it enforces.
const schemaByMiddleware = new WeakMap<RequestHandler, RequestInputSchema>();

export const validate = (schema: RequestInputSchema): RequestHandler => {
  const middleware: RequestHandler = (request, _response, next) => {
    const result = schema.safeParse({
      body: request.body as unknown,
      params: request.params,
      query: request.query,
    });

    if (!result.success) {
      next(
        new AppError(
          'Request validation failed',
          400,
          'VALIDATION_ERROR',
          // Not `z.flattenError`: it groups by the first path segment only, so
          // every body message arrived without the name of its field.
          describeValidationIssues(result.error),
        ),
      );
      return;
    }

    if (result.data.body !== undefined) request.body = result.data.body;
    if (result.data.params !== undefined) {
      Object.defineProperty(request, 'params', { configurable: true, value: result.data.params });
    }
    if (result.data.query !== undefined) {
      Object.defineProperty(request, 'query', { configurable: true, value: result.data.query });
    }
    next();
  };

  schemaByMiddleware.set(middleware, schema);
  return middleware;
};

/** The schema a middleware built by `validate()` checks; `undefined` for any other handler. */
export const validatedSchemaOf = (handler: RequestHandler): RequestInputSchema | undefined =>
  schemaByMiddleware.get(handler);
