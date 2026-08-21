import type { RequestHandler } from 'express';

import { AppError } from '../errors/app-error.js';

export const notFoundHandler: RequestHandler = (request, _response, next) => {
  next(new AppError(`Route ${request.method} ${request.originalUrl} not found`, 404, 'NOT_FOUND'));
};
