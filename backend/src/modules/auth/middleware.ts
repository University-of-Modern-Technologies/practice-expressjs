import type { RequestHandler } from 'express';
import { AppError } from '../../common/errors/app-error.js';
import type { AuthService } from './service.js';

/**
 * The credentials of a `Bearer` authorization header, or `null`.
 *
 * The scheme name is case-insensitive (RFC 9110, section 11.1): it is split
 * off at the first space and compared without regard to case, and the rest is
 * the token with surrounding whitespace removed.
 */
export const bearerToken = (authorization: string | undefined): string | null => {
  if (!authorization) return null;
  const separator = authorization.indexOf(' ');
  if (separator < 0) return null;
  const scheme = authorization.slice(0, separator);
  const token = authorization.slice(separator + 1).trim();
  if (scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token;
};

export const createAuthenticate =
  (authService: AuthService): RequestHandler =>
  async (request, _response, next) => {
    const token = bearerToken(request.header('authorization'));
    if (token === null) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
    request.auth = await authService.authenticate(token);
    next();
  };
