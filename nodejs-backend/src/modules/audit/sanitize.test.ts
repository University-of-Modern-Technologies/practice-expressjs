import { describe, expect, it } from '@jest/globals';

import { isSensitiveAuditField, sanitizeAuditValue } from './sanitize.js';

describe('audit sanitization', () => {
  it('redacts sensitive fields recursively without changing ordinary fields', () => {
    const sanitized = sanitizeAuditValue({
      email: 'person@example.com',
      password: 'plain-text',
      profile: {
        access_token: 'access',
        displayName: 'Ada',
        nested: [{ tokenHash: 'hash', value: 42 }],
      },
    });

    expect(sanitized).toEqual({
      email: 'person@example.com',
      password: '[REDACTED]',
      profile: {
        access_token: '[REDACTED]',
        displayName: 'Ada',
        nested: [{ tokenHash: '[REDACTED]', value: 42 }],
      },
    });
  });

  it('normalizes common sensitive key spellings', () => {
    expect(isSensitiveAuditField('refresh-token')).toBe(true);
    expect(isSensitiveAuditField('API_KEY')).toBe(true);
    expect(isSensitiveAuditField('company')).toBe(false);
  });

  it('serializes dates, bigint and circular references safely', () => {
    const source: Record<string, unknown> = {
      at: new Date('2026-08-05T12:00:00.000Z'),
      count: 7n,
    };
    source.self = source;

    expect(sanitizeAuditValue(source)).toEqual({
      at: '2026-08-05T12:00:00.000Z',
      count: '7',
      self: '[CIRCULAR]',
    });
  });
});
