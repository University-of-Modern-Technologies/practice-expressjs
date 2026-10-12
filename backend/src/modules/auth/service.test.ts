import { afterEach, describe, expect, it, jest } from '@jest/globals';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { AppError } from '../../common/errors/app-error.js';
import { normalizeIpAddress, sessionClientOf } from './client.js';
import {
  createAuthService,
  DUMMY_PASSWORD_HASH,
  splitRefreshToken,
  type AuthDatabase,
} from './service.js';
import type { AuthConfig } from './types.js';
import { loginSchema } from './validation.js';

const config: AuthConfig = {
  accessTokenSecret: 'test-secret-with-enough-entropy',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 3600,
  refreshCookieName: 'refresh_token',
  refreshCookiePath: '/api/auth',
  secureCookies: false,
};

const userId = '10000000-0000-4000-8000-000000000001';
const sessionId = '11000000-0000-4000-8000-000000000001';

const user = {
  id: userId,
  email: 'user@example.com',
  name: 'User',
  passwordHash: '',
  isActive: true,
  userRoles: [],
};

const liveSession = (tokenHash: string) => ({
  id: sessionId,
  userId,
  tokenHash,
  expiresAt: new Date(Date.now() + 60_000),
  revokedAt: null,
  user,
});

const accessToken = (claims: Record<string, unknown> = {}): string =>
  jwt.sign({ type: 'access', sessionId, ...claims }, config.accessTokenSecret, {
    subject: userId,
    expiresIn: 60,
  });

afterEach(() => {
  jest.restoreAllMocks();
});

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
            id: sessionId,
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
        findUnique: jest.fn(async () => liveSession(oldHash)),
        updateMany: jest.fn(async (args: { data: { tokenHash: string } }) => {
          replacementHash = args.data.tokenHash;
          return { count: 1 };
        }),
      },
    } as unknown as AuthDatabase;

    const result = await createAuthService(db, config).refresh(`${sessionId}.${oldSecret}`);
    const replacementSecret = result.refreshToken.split('.')[1] ?? '';

    expect(result.refreshToken.startsWith(`${sessionId}.`)).toBe(true);
    expect(replacementSecret).not.toBe(oldSecret);
    await expect(bcrypt.compare(replacementSecret, replacementHash)).resolves.toBe(true);
  });

  it('revokes the matching session on logout', async () => {
    const updateMany = jest.fn(async (_args: unknown) => ({ count: 1 }));
    const db = {
      user: { findUnique: jest.fn() },
      session: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany },
    } as unknown as AuthDatabase;

    await createAuthService(db, config).logout(`${sessionId}.secret`);

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: sessionId, revokedAt: null } }),
    );
  });
});

// Bcrypt reads 72 bytes; a longer password is refused, never truncated.
describe('password length in bytes', () => {
  const login = (password: string) =>
    loginSchema.safeParse({ body: { email: 'user@example.com', password } });

  it('refuses a password over 72 bytes even when it is under the character limit', () => {
    expect(login('a'.repeat(73)).success).toBe(false);
    expect(login('ї'.repeat(37)).success).toBe(false);
  });

  it('accepts a password of exactly 72 bytes', () => {
    expect(login('a'.repeat(72)).success).toBe(true);
  });
});

// A refresh cookie whose session half is not an identifier is a 401.
describe('refresh token parsing', () => {
  it.each([
    'not-a-uuid.secret',
    '11000000000040008000000000000001.secret',
    `{${sessionId}}.secret`,
    `urn:uuid:${sessionId}.secret`,
    `${sessionId}.`,
    '.secret',
  ])('rejects %s without touching the database', async (token) => {
    const findUnique = jest.fn();
    const updateMany = jest.fn();
    const db = {
      user: { findUnique: jest.fn() },
      session: { create: jest.fn(), findUnique, updateMany },
    } as unknown as AuthDatabase;
    const service = createAuthService(db, config);

    await expect(service.refresh(token)).rejects.toMatchObject({
      statusCode: 401,
      code: 'INVALID_REFRESH_TOKEN',
    });
    await expect(service.logout(token)).resolves.toBeUndefined();
    expect(findUnique).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('accepts the identifier in the form it is issued in', () => {
    expect(splitRefreshToken(`${sessionId.toUpperCase()}.a.b`)).toEqual({
      sessionId,
      secret: 'a.b',
    });
  });
});

// A refresh must never bring a revoked session back.
describe('refresh against a concurrent revocation', () => {
  const rotatingDatabase = (count: number) => {
    const updateMany = jest.fn(async (_args: unknown) => ({ count }));
    const db = {
      user: { findUnique: jest.fn() },
      session: {
        create: jest.fn(),
        findUnique: jest.fn(async () => liveSession(bcrypt.hashSync('s', 4))),
        updateMany,
      },
    } as unknown as AuthDatabase;
    return { db, updateMany };
  };

  it('writes the new secret only while the row is still live, and never clears a revocation', async () => {
    const { db, updateMany } = rotatingDatabase(1);

    await createAuthService(db, config).refresh(`${sessionId}.s`);

    const [args] = updateMany.mock.calls[0] as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ];
    expect(args.where).toEqual({ id: sessionId, revokedAt: null });
    expect(args.data).not.toHaveProperty('revokedAt');
  });

  it('answers 401 when the session was revoked between the read and the write', async () => {
    const { db } = rotatingDatabase(0);

    await expect(createAuthService(db, config).refresh(`${sessionId}.s`)).rejects.toMatchObject({
      statusCode: 401,
      code: 'INVALID_REFRESH_TOKEN',
    });
  });
});

// An unreadable store is an outage, not "you are not signed in".
describe('authentication against a failing store', () => {
  it('lets a database failure propagate instead of answering 401', async () => {
    const outage = new Error('connection refused');
    const db = {
      user: { findUnique: jest.fn() },
      session: {
        findUnique: jest.fn(async () => {
          throw outage;
        }),
      },
    } as unknown as AuthDatabase;

    const failure = await createAuthService(db, config)
      .authenticate(accessToken())
      .catch((error: unknown) => error);

    expect(failure).toBe(outage);
    expect(failure).not.toBeInstanceOf(AppError);
  });

  it('still answers 401 for a token that fails verification', async () => {
    const findUnique = jest.fn();
    const db = {
      user: { findUnique: jest.fn() },
      session: { findUnique },
    } as unknown as AuthDatabase;

    await expect(createAuthService(db, config).authenticate('not-a-token')).rejects.toMatchObject({
      statusCode: 401,
      code: 'UNAUTHORIZED',
    });
    await expect(
      createAuthService(db, config).authenticate(accessToken({ sessionId: 'not-a-uuid' })),
    ).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('answers 401 for a disabled account', async () => {
    const db = {
      user: { findUnique: jest.fn(async () => ({ isActive: false })) },
      session: { findUnique: jest.fn(async () => liveSession('hash')) },
    } as unknown as AuthDatabase;

    await expect(createAuthService(db, config).authenticate(accessToken())).rejects.toMatchObject({
      statusCode: 401,
      code: 'UNAUTHORIZED',
    });
  });
});

// An unknown address costs a password check like any other failure.
describe('login timing', () => {
  const recordCompare = () => {
    const checked: string[] = [];
    jest.spyOn(bcrypt, 'compare').mockImplementation((async (_password: string, hash: string) => {
      checked.push(hash);
      return false;
    }) as unknown as typeof bcrypt.compare);
    return checked;
  };

  it('checks an unknown address against a dummy digest', async () => {
    const checked = recordCompare();
    const db = {
      user: { findUnique: jest.fn(async () => null) },
      session: { create: jest.fn() },
    } as unknown as AuthDatabase;

    await expect(
      createAuthService(db, config).login({ email: 'nobody@example.com', password: 'whatever1' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(checked).toEqual([DUMMY_PASSWORD_HASH]);
  });

  it('checks the password of a disabled account too', async () => {
    const checked = recordCompare();
    const db = {
      user: { findUnique: jest.fn(async () => ({ ...user, isActive: false, passwordHash: 'h' })) },
      session: { create: jest.fn() },
    } as unknown as AuthDatabase;

    await expect(
      createAuthService(db, config).login({ email: user.email, password: 'whatever1' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(checked).toEqual(['h']);
  });

  it('uses a dummy digest of the same work factor as a real one', () => {
    expect(bcrypt.getRounds(DUMMY_PASSWORD_HASH)).toBe(12);
  });
});

// The session records where it was opened and last renewed from.
describe('session client', () => {
  const client = sessionClientOf('::ffff:203.0.113.7', 'probe/1.0');

  it('records the address and user agent on login', async () => {
    const passwordHash = await bcrypt.hash('correct-password', 4);
    const create = jest.fn(async (args: { data: Record<string, unknown> }) => ({
      id: sessionId,
      ...args.data,
    }));
    const db = {
      user: { findUnique: jest.fn(async () => ({ ...user, passwordHash })) },
      session: { create },
    } as unknown as AuthDatabase;

    await createAuthService(db, config).login(
      { email: user.email, password: 'correct-password' },
      client,
    );

    expect(create.mock.calls[0]?.[0].data).toMatchObject({
      ipAddress: '203.0.113.7',
      userAgent: 'probe/1.0',
    });
  });

  it('records them again on refresh', async () => {
    const updateMany = jest.fn(async (_args: { data: Record<string, unknown> }) => ({ count: 1 }));
    const db = {
      user: { findUnique: jest.fn() },
      session: {
        findUnique: jest.fn(async () => liveSession(bcrypt.hashSync('s', 4))),
        updateMany,
      },
    } as unknown as AuthDatabase;

    await createAuthService(db, config).refresh(`${sessionId}.s`, client);

    expect(updateMany.mock.calls[0]?.[0].data).toMatchObject({
      ipAddress: '203.0.113.7',
      userAgent: 'probe/1.0',
    });
  });

  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8::1', '2001:db8::1'],
    ['testclient', null],
    [undefined, null],
  ])('stores %s as %s', (input, expected) => {
    expect(normalizeIpAddress(input)).toBe(expected);
  });

  it('cuts a long user agent to the column width', () => {
    expect(sessionClientOf(undefined, 'x'.repeat(600)).userAgent).toBe('x'.repeat(512));
    expect(sessionClientOf(undefined, '').userAgent).toBeNull();
  });
});
