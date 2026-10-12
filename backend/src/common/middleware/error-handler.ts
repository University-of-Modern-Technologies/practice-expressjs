import type { ErrorRequestHandler } from 'express';

import type { AppConfig } from '../../config/env.js';
import { AppError } from '../errors/app-error.js';

const isMalformedJson = (error: unknown): error is SyntaxError & { status: number } =>
  error instanceof SyntaxError && 'status' in error && error.status === 400;

/**
 * What the body parser throws for a request it refuses to read: an error with
 * a client status and a `type` such as `entity.too.large` or
 * `encoding.unsupported`. It is the client's fault, so it must not read as 500.
 */
interface BodyParserError {
  readonly type: string;
  readonly status: number;
}

const isBodyParserError = (error: unknown): error is BodyParserError =>
  typeof error === 'object' &&
  error !== null &&
  'type' in error &&
  typeof error.type === 'string' &&
  'status' in error &&
  typeof error.status === 'number' &&
  error.status >= 400 &&
  error.status < 500;

// The same codes and wording the sibling backend uses for these refusals.
const BODY_PARSER_REFUSALS: Record<number, { code: string; message: string }> = {
  400: { code: 'BAD_REQUEST', message: 'Malformed request body' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' },
  415: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported request body encoding' },
};

const normalize = (error: unknown): unknown => {
  if (isMalformedJson(error)) {
    return new AppError('Malformed JSON request body', 400, 'INVALID_JSON');
  }
  if (!isBodyParserError(error)) return error;

  const refusal = BODY_PARSER_REFUSALS[error.status] ?? {
    code: `HTTP_${String(error.status)}`,
    message: 'Request body was refused',
  };
  return new AppError(refusal.message, error.status, refusal.code);
};

export const createErrorHandler =
  (config: AppConfig): ErrorRequestHandler =>
  (error: unknown, request, response, _next) => {
    const normalizedError = normalize(error);

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
          config.appEnv === 'production' && normalizedError instanceof Error
            ? 'Internal server error'
            : normalizedError instanceof Error
              ? normalizedError.message
              : 'Internal server error',
      },
      requestId: request.id,
    });
  };
