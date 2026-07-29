import request from 'supertest';

import type { CompositionRoot } from '../../src/composition-root.js';
import { getCookiePair, getRefreshCookie, getSetCookies } from './helpers/auth.js';
import { seed } from './helpers/seed-data.js';
import { createIntegrationApp } from './helpers/test-app.js';

let root: CompositionRoot;

beforeAll(() => {
  root = createIntegrationApp();
});

afterAll(async () => {
  await root.close();
});

describe('database-backed authentication flow', () => {
  it('logs in, rotates the refresh secret, and revokes the session on logout', async () => {
    const loginResponse = await request(root.app).post('/api/v1/auth/login').send({
      email: seed.users.manager.email,
      password: seed.password,
    });

    expect(loginResponse.status).toBe(200);
    expect(loginResponse.body.data).toMatchObject({
      user: {
        id: seed.users.manager.id,
        email: seed.users.manager.email,
        name: 'Morgan Manager',
      },
      accessTokenExpiresInSeconds: 900,
    });
    expect(loginResponse.body.data.user.roles).toEqual(expect.arrayContaining(['manager']));
    expect(loginResponse.body.data.user.permissions).toEqual(
      expect.arrayContaining([
        { resource: 'contacts', action: 'write', scope: 'ALL' },
        { resource: 'deals', action: 'write', scope: 'ALL' },
        { resource: 'audit', action: 'read', scope: 'ALL' },
      ]),
    );

    const loginCookie = getRefreshCookie(loginResponse);
    expect(loginCookie).toContain('HttpOnly');
    expect(loginCookie).toContain('SameSite=Lax');
    expect(loginCookie).toContain('Path=/api/v1/auth');
    expect(loginCookie).toContain('Max-Age=604800');
    expect(loginCookie).not.toContain('Secure');

    const firstAccessToken = loginResponse.body.data.accessToken as string;
    const meResponse = await request(root.app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${firstAccessToken}`);
    expect(meResponse.status).toBe(200);
    expect(meResponse.body.data.id).toBe(seed.users.manager.id);

    const firstCookiePair = getCookiePair(loginCookie);
    const firstRefreshToken = firstCookiePair.slice('refresh_token='.length);
    const refreshResponse = await request(root.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', firstCookiePair);

    expect(refreshResponse.status).toBe(200);
    const rotatedCookie = getRefreshCookie(refreshResponse);
    const rotatedCookiePair = getCookiePair(rotatedCookie);
    const rotatedRefreshToken = rotatedCookiePair.slice('refresh_token='.length);
    expect(rotatedRefreshToken.split('.')[0]).toBe(firstRefreshToken.split('.')[0]);
    expect(rotatedRefreshToken).not.toBe(firstRefreshToken);

    const staleRefreshResponse = await request(root.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', firstCookiePair);
    expect(staleRefreshResponse.status).toBe(401);
    expect(staleRefreshResponse.body.error.code).toBe('INVALID_REFRESH_TOKEN');

    const rotatedAccessToken = refreshResponse.body.data.accessToken as string;
    const logoutResponse = await request(root.app)
      .post('/api/v1/auth/logout')
      .set('Cookie', rotatedCookiePair);
    expect(logoutResponse.status).toBe(204);
    expect(getSetCookies(logoutResponse).join(';')).toContain('refresh_token=');
    expect(getSetCookies(logoutResponse).join(';')).toContain('Path=/api/v1/auth');

    const revokedAccessResponse = await request(root.app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${rotatedAccessToken}`);
    expect(revokedAccessResponse.status).toBe(401);
    expect(revokedAccessResponse.body.error.code).toBe('UNAUTHORIZED');

    const revokedRefreshResponse = await request(root.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', rotatedCookiePair);
    expect(revokedRefreshResponse.status).toBe(401);
    expect(revokedRefreshResponse.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('requires a refresh cookie', async () => {
    const response = await request(root.app).post('/api/v1/auth/refresh');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('REFRESH_TOKEN_REQUIRED');
  });
});
