import type { EventJsonValue } from './types.js';

const sensitiveKeys = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'cookie',
  'password',
  'passwordhash',
  'refreshtoken',
  'secret',
  'sessiontoken',
  'token',
  'tokenhash',
]);

const normalizeKey = (key: string): string => key.replaceAll(/[^a-zA-Z0-9]/g, '').toLowerCase();

export const isSensitiveEventField = (key: string): boolean => sensitiveKeys.has(normalizeKey(key));

/**
 * Deep, case-insensitive redaction of secrets before an event reaches MongoDB.
 * Arrays are traversed, cycles are broken and non-JSON values are stringified so
 * the stored payload is always safe to serialise.
 */
export const sanitizeEventPayload = (value: unknown): EventJsonValue => {
  const seen = new WeakSet<object>();

  const sanitize = (candidate: unknown): EventJsonValue => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
      return candidate;
    }
    if (candidate === undefined) return null;
    if (typeof candidate === 'number')
      return Number.isFinite(candidate) ? candidate : String(candidate);
    if (typeof candidate === 'bigint') return candidate.toString();
    if (candidate instanceof Date) return candidate.toISOString();
    if (Array.isArray(candidate)) return candidate.map(sanitize);
    if (typeof candidate !== 'object') return String(candidate);
    if (seen.has(candidate)) return '[CIRCULAR]';
    seen.add(candidate);

    const result: Record<string, EventJsonValue> = {};
    for (const [key, nestedValue] of Object.entries(candidate)) {
      result[key] = isSensitiveEventField(key) ? '[REDACTED]' : sanitize(nestedValue);
    }
    return result;
  };

  return sanitize(value);
};
