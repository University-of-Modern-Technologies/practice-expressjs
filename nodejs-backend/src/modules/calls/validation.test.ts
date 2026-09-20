import { describe, expect, it } from '@jest/globals';

import {
  deleteCallSchema,
  linkCallSchema,
  listCallsSchema,
  syncCallsSchema,
  updateCallSchema,
} from './validation.js';

const id = '5ff875e1-4c1d-4e45-9c8a-fceb5fb5d836';
const contactId = 'd2d0a3a1-0f9a-4c8e-8f0a-1f7f8ba2c111';

describe('call list validation', () => {
  it('sorts by the start of the call unless told otherwise', () => {
    const parsed = listCallsSchema.safeParse({ query: {} });
    expect(parsed.success && parsed.data.query).toMatchObject({
      page: 1,
      pageSize: 20,
      sortBy: 'startedAt',
      sortOrder: 'desc',
    });
  });

  it('accepts only the documented sort fields', () => {
    for (const sortBy of ['startedAt', 'createdAt', 'durationSeconds']) {
      expect(listCallsSchema.safeParse({ query: { sortBy } }).success).toBe(true);
    }
    expect(listCallsSchema.safeParse({ query: { sortBy: 'fromNumber' } }).success).toBe(false);
  });

  it('reads hasContact from the query string in both spellings', () => {
    const asText = listCallsSchema.safeParse({ query: { hasContact: 'false' } });
    expect(asText.success && asText.data.query.hasContact).toBe(false);
    const asBoolean = listCallsSchema.safeParse({ query: { hasContact: true } });
    expect(asBoolean.success && asBoolean.data.query.hasContact).toBe(true);
    expect(listCallsSchema.safeParse({ query: { hasContact: 'maybe' } }).success).toBe(false);
  });

  it('rejects a started range that runs backwards', () => {
    expect(
      listCallsSchema.safeParse({
        query: { startedFrom: '2026-03-02T00:00:00Z', startedTo: '2026-03-01T00:00:00Z' },
      }).success,
    ).toBe(false);
    expect(
      listCallsSchema.safeParse({
        query: { startedFrom: '2026-03-01T00:00:00Z', startedTo: '2026-03-02T00:00:00Z' },
      }).success,
    ).toBe(true);
  });
});

describe('call sync validation', () => {
  it('takes no parameters and drops anything a caller sends', () => {
    const parsed = syncCallsSchema.safeParse({ body: { limit: 5_000 } });
    expect(parsed.success && parsed.data.body).toEqual({});
    expect(syncCallsSchema.safeParse({ body: undefined }).success).toBe(true);
  });
});

describe('call mutation validation', () => {
  it('requires a positive version and an actual field for updates', () => {
    expect(
      updateCallSchema.safeParse({ params: { id }, body: { version: 1, notes: 'x' } }).success,
    ).toBe(true);
    expect(updateCallSchema.safeParse({ params: { id }, body: { notes: 'x' } }).success).toBe(
      false,
    );
    expect(updateCallSchema.safeParse({ params: { id }, body: { version: 1 } }).success).toBe(
      false,
    );
  });

  it('keeps what the provider reported out of the update body', () => {
    const parsed = updateCallSchema.safeParse({
      params: { id },
      body: {
        version: 1,
        notes: 'Called back',
        direction: 'OUTBOUND',
        disposition: 'ANSWERED',
        fromNumber: '+14155550100',
        durationSeconds: 999,
        externalId: 'forged',
      },
    });
    expect(parsed.success && parsed.data.body).toEqual({ version: 1, notes: 'Called back' });
  });

  it('lets an update detach a link or hand the call over', () => {
    const parsed = updateCallSchema.safeParse({
      params: { id },
      body: { version: 2, contactId: null, dealId: null, ownerId: null },
    });
    expect(parsed.success).toBe(true);
  });

  it('caps the notes at two thousand characters', () => {
    const withNotes = (notes: string) => ({ params: { id }, body: { version: 1, notes } });
    expect(updateCallSchema.safeParse(withNotes('a'.repeat(2_000))).success).toBe(true);
    expect(updateCallSchema.safeParse(withNotes('a'.repeat(2_001))).success).toBe(false);
  });

  it('requires a target for linking and refuses null as one', () => {
    expect(
      linkCallSchema.safeParse({ params: { id }, body: { version: 1, contactId } }).success,
    ).toBe(true);
    expect(linkCallSchema.safeParse({ params: { id }, body: { version: 1 } }).success).toBe(false);
    expect(
      linkCallSchema.safeParse({ params: { id }, body: { version: 1, contactId: null } }).success,
    ).toBe(false);
  });

  it('requires a version query parameter for deletion', () => {
    expect(deleteCallSchema.safeParse({ params: { id }, query: { version: '1' } }).success).toBe(
      true,
    );
    expect(deleteCallSchema.safeParse({ params: { id }, query: {} }).success).toBe(false);
  });
});
