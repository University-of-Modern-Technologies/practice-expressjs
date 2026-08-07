import request, { type Response } from 'supertest';

import type { AuthenticatedUser } from '../../../src/modules/auth/index.js';
import { seed } from './seed-data.js';

type TestApp = Parameters<typeof request>[0];

export interface LoginResult {
  readonly accessToken: string;
  readonly user: AuthenticatedUser;
  readonly response: Response;
  readonly refreshCookie: string;
}

export function getSetCookies(response: Response): string[] {
  const value = response.headers['set-cookie'];
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function getRefreshCookie(response: Response): string {
  const cookie = getSetCookies(response).find((value) => value.startsWith('refresh_token='));
  if (!cookie) throw new Error('Expected a refresh_token Set-Cookie header.');
  return cookie;
}

export function getCookiePair(cookie: string): string {
  return cookie.split(';', 1)[0];
}

export async function login(app: TestApp, user: { readonly email: string }): Promise<LoginResult> {
  const response = await request(app).post('/api/v1/auth/login').send({
    email: user.email,
    password: seed.password,
  });

  expect(response.status).toBe(200);
  expect(response.body.data.accessToken).toEqual(expect.any(String));

  return {
    accessToken: response.body.data.accessToken as string,
    user: response.body.data.user as AuthenticatedUser,
    response,
    refreshCookie: getRefreshCookie(response),
  };
}

export const bearer = (accessToken: string): string => `Bearer ${accessToken}`;
