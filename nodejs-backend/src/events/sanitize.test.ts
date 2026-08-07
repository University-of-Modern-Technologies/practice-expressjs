import { describe, expect, it } from '@jest/globals';

import { isSensitiveEventField, sanitizeEventPayload } from './sanitize.js';

describe('event payload sanitization', () => {
  it('redacts secrets in nested objects and arrays', () => {
    const sanitized = sanitizeEventPayload({
      email: 'person@example.com',
      password: 'plain-text',
      session: {
        accessToken: 'access',
        refresh_token: 'refresh',
        Authorization: 'Bearer abc',
        cookie: 'sid=1',
        displayName: 'Ada',
      },
      history: [
        { tokenHash: 'hash', amount: 10 },
        { SECRET: 'shh', nested: [{ passwordHash: 'hash', label: 'ok' }] },
      ],
    });

    expect(sanitized).toEqual({
      email: 'person@example.com',
      password: '[REDACTED]',
      session: {
        accessToken: '[REDACTED]',
        refresh_token: '[REDACTED]',
        Authorization: '[REDACTED]',
        cookie: '[REDACTED]',
        displayName: 'Ada',
      },
      history: [
        { tokenHash: '[REDACTED]', amount: 10 },
        { SECRET: '[REDACTED]', nested: [{ passwordHash: '[REDACTED]', label: 'ok' }] },
      ],
    });
  });

  it('normalizes sensitive key spellings and leaves ordinary keys alone', () => {
    expect(isSensitiveEventField('refresh-token')).toBe(true);
    expect(isSensitiveEventField('TOKEN_HASH')).toBe(true);
    expect(isSensitiveEventField('Secret')).toBe(true);
    expect(isSensitiveEventField('company')).toBe(false);
  });

  it('serializes dates, bigint, undefined and circular references safely', () => {
    const source: Record<string, unknown> = {
      at: new Date('2026-08-05T12:00:00.000Z'),
      count: 7n,
      missing: undefined,
    };
    source.self = source;

    expect(sanitizeEventPayload(source)).toEqual({
      at: '2026-08-05T12:00:00.000Z',
      count: '7',
      missing: null,
      self: '[CIRCULAR]',
    });
  });
});
