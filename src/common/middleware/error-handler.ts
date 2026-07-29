import type { ErrorRequestHandler } from 'express';

import type { AppConfig } from '../../config/env.js';
import { AppError } from '../errors/app-error.js';

const isMalformedJson = (error: unknown): error is SyntaxError & { status: number } =>
  error instanceof SyntaxError && 'status' in error && error.status === 400;

export const createErrorHandler =
  (config: AppConfig): ErrorRequestHandler =>
  (error: unknown, request, response, _next) => {
    const normalizedError = isMalformedJson(error)
      ? new AppError('Malformed JSON request body', 400, 'INVALID_JSON')
      : error;

    if (normalizedError instanceof AppError) {
      request.log.warn(
        { error: normalizedError, code: normalizedError.code },
        normalizedError.message,
      );
      response.status(normalizedError.statusCode).json({
        error: {
          code: normalizedError.code,
          message: normalizedError.message,
          details: normalizedError.details,
        },
        requestId: request.id,
      });
      return;
    }

    request.log.error({ error: normalizedError }, 'Unhandled request error');
    response.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message:
          config.nodeEnv === 'production' && normalizedError instanceof Error
            ? 'Internal server error'
            : normalizedError instanceof Error
              ? normalizedError.message
              : 'Internal server error',
      },
      requestId: request.id,
    });
  };
