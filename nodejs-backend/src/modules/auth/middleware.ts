import type { RequestHandler } from 'express';
import { AppError } from '../../common/errors/app-error.js';
import type { AuthService } from './service.js';

export const createAuthenticate =
  (authService: AuthService): RequestHandler =>
  async (request, _response, next) => {
    const authorization = request.header('authorization');
    if (!authorization?.startsWith('Bearer ')) {
      throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
    }
    request.auth = await authService.authenticate(authorization.slice(7));
    next();
  };
