import { describe, expect, it, jest } from '@jest/globals';
import bcrypt from 'bcryptjs';
import { createAuthService, type AuthDatabase } from './service.js';
import type { AuthConfig } from './types.js';

const config: AuthConfig = {
  accessTokenSecret: 'test-secret-with-enough-entropy',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 3600,
  refreshCookieName: 'refresh_token',
  refreshCookiePath: '/api/auth',
  secureCookies: false,
};

const user = {
  id: 'user-1',
  email: 'user@example.com',
  name: 'User',
  passwordHash: '',
  isActive: true,
  userRoles: [],
};

describe('auth service', () => {
  it('stores a hash instead of the refresh secret on login', async () => {
    const passwordHash = await bcrypt.hash('correct-password', 4);
    let storedHash = '';
    const db = {
      user: { findUnique: jest.fn(async () => ({ ...user, passwordHash })) },
      session: {
        create: jest.fn(async (args: { data: { tokenHash: string } }) => {
          storedHash = args.data.tokenHash;
          return {
            id: 'session-1',
            userId: user.id,
            expiresAt: new Date(),
            revokedAt: null,
            ...args.data,
          };
        }),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    } as unknown as AuthDatabase;

    const result = await createAuthService(db, config).login({
      email: user.email,
      password: 'correct-password',
    });
    const secret = result.refreshToken.split('.')[1] ?? '';

    expect(storedHash).not.toBe(secret);
    await expect(bcrypt.compare(secret, storedHash)).resolves.toBe(true);
  });

  it('rotates the refresh secret in the same session', async () => {
    const oldSecret = 'old-refresh-secret';
    const oldHash = await bcrypt.hash(oldSecret, 4);
    let replacementHash = '';
    const db = {
      user: { findUnique: jest.fn() },
      session: {
        create: jest.fn(),
        findUnique: jest.fn(async () => ({
          id: 'session-1',
          userId: user.id,
          tokenHash: oldHash,
          expiresAt: new Date(Date.now() + 60_000),
          revokedAt: null,
          user,
        })),
        update: jest.fn(async (args: { data: { tokenHash: string } }) => {
          replacementHash = args.data.tokenHash;
          return {
            id: 'session-1',
            userId: user.id,
            expiresAt: new Date(),
            revokedAt: null,
            ...args.data,
          };
        }),
        updateMany: jest.fn(),
      },
    } as unknown as AuthDatabase;

    const result = await createAuthService(db, config).refresh(`session-1.${oldSecret}`);
    const replacementSecret = result.refreshToken.split('.')[1] ?? '';

    expect(result.refreshToken.startsWith('session-1.')).toBe(true);
    expect(replacementSecret).not.toBe(oldSecret);
    await expect(bcrypt.compare(replacementSecret, replacementHash)).resolves.toBe(true);
  });

  it('revokes the matching session on logout', async () => {
    const updateMany = jest.fn(async (_args: unknown) => ({ count: 1 }));
    const db = {
      user: { findUnique: jest.fn() },
      session: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany },
    } as unknown as AuthDatabase;

    await createAuthService(db, config).logout('session-1.secret');

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'session-1', revokedAt: null } }),
    );
  });
});
