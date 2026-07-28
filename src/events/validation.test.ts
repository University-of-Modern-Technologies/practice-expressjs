import { describe, expect, it } from '@jest/globals';

import { domainEventSchema, searchEventsSchema } from './validation.js';

describe('domain event validation', () => {
  it('accepts a minimal event and keeps optional fields absent', () => {
    const parsed = domainEventSchema.safeParse({
      eventType: 'contact.created',
      entityType: 'contacts',
      entityId: '5ff875e1-4c1d-4e45-9c8a-fceb5fb5d836',
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.actorId).toBeUndefined();
  });

  it('rejects events without a type or an entity reference', () => {
    expect(domainEventSchema.safeParse({ entityType: 'contacts', entityId: 'id-1' }).success).toBe(
      false,
    );
    expect(
      domainEventSchema.safeParse({ eventType: 'contact.created', entityType: 'contacts' }).success,
    ).toBe(false);
    expect(
      domainEventSchema.safeParse({
        eventType: '   ',
        entityType: 'contacts',
        entityId: 'id-1',
      }).success,
    ).toBe(false);
  });

  it('rejects wrongly typed fields', () => {
    const parsed = domainEventSchema.safeParse({
      eventType: 'contact.created',
      entityType: 'contacts',
      entityId: 42,
      occurredAt: '2026-08-05T12:00:00.000Z',
    });

    expect(parsed.success).toBe(false);
  });

  it('applies pagination defaults and coerces search filters', () => {
    const parsed = searchEventsSchema.parse({
      query: { eventType: 'contact.updated', from: '2026-08-01T00:00:00.000Z' },
    });

    expect(parsed.query.page).toBe(1);
    expect(parsed.query.pageSize).toBe(25);
    expect(parsed.query.from).toEqual(new Date('2026-08-01T00:00:00.000Z'));
  });
});
