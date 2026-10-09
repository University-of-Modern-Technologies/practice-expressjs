import { describe, expect, it, jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';

import { bearerToken, createAuthenticate } from './middleware.js';
import type { AuthService } from './service.js';

// The scheme name is case-insensitive, as it is in the sibling backend.
describe('bearer token', () => {
  it.each(['Bearer token-1', 'bearer token-1', 'BEARER token-1', 'Bearer   token-1  '])(
    'reads the token from %j',
    (header) => {
      expect(bearerToken(header)).toBe('token-1');
    },
  );

  it.each([undefined, '', 'Bearer', 'Bearer ', 'Basic token-1', 'Token token-1', 'Bearertoken-1'])(
    'finds no token in %j',
    (header) => {
      expect(bearerToken(header)).toBeNull();
    },
  );

  it('authenticates a lower-case scheme', async () => {
    const authenticate = jest.fn(async (_token: string) => ({
      userId: 'user-1',
      sessionId: 'session-1',
    }));
    const request = {
      header: (name: string) => (name === 'authorization' ? 'bearer token-1' : undefined),
    } as unknown as Request;
    const next = jest.fn() as NextFunction;

    await createAuthenticate({ authenticate } as unknown as AuthService)(
      request,
      {} as Response,
      next,
    );

    expect(authenticate).toHaveBeenCalledWith('token-1');
    expect(request.auth).toEqual({ userId: 'user-1', sessionId: 'session-1' });
    expect(next).toHaveBeenCalledTimes(1);
  });
});
