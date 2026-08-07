import type { RequestHandler } from 'express';
import { z } from 'zod';

import { AppError } from '../errors/app-error.js';

interface RequestInput {
  readonly body: unknown;
  readonly params: unknown;
  readonly query: unknown;
}

export const validate =
  (schema: z.ZodType<Partial<RequestInput>>): RequestHandler =>
  (request, _response, next) => {
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
          z.flattenError(result.error),
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
