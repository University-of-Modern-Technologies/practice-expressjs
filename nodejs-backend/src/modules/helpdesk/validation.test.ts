import { describe, expect, it } from '@jest/globals';

import {
  createTicketSchema,
  deleteTicketSchema,
  listTicketsSchema,
  transitionTicketSchema,
  updateTicketSchema,
} from './validation.js';

const id = '5ff875e1-4c1d-4e45-9c8a-fceb5fb5d836';
const validTicket = {
  subject: 'Printer is jammed',
  body: 'The device reports a paper jam that is not there.',
  channel: 'EMAIL',
};

describe('create ticket validation', () => {
  it('accepts the minimal ticket and keeps status out of the request body', () => {
    const parsed = createTicketSchema.safeParse({ body: validTicket });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'status' in parsed.data.body).toBe(false);
  });

  it('requires a channel from the vocabulary', () => {
    expect(createTicketSchema.safeParse({ body: { ...validTicket, channel: 'FAX' } }).success).toBe(
      false,
    );
    expect(createTicketSchema.safeParse({ body: { subject: 'x', body: 'y' } }).success).toBe(false);
  });

  it('holds the subject and body to their documented lengths', () => {
    expect(
      createTicketSchema.safeParse({ body: { ...validTicket, subject: 'a'.repeat(200) } }).success,
    ).toBe(true);
    expect(
      createTicketSchema.safeParse({ body: { ...validTicket, subject: 'a'.repeat(201) } }).success,
    ).toBe(false);
    expect(
      createTicketSchema.safeParse({ body: { ...validTicket, body: 'a'.repeat(5000) } }).success,
    ).toBe(true);
    expect(
      createTicketSchema.safeParse({ body: { ...validTicket, body: 'a'.repeat(5001) } }).success,
    ).toBe(false);
  });
});

describe('ticket mutation validation', () => {
  it('requires a positive version and an actual field for regular updates', () => {
    expect(
      updateTicketSchema.safeParse({ params: { id }, body: { version: 1, priority: 'HIGH' } })
        .success,
    ).toBe(true);
    expect(
      updateTicketSchema.safeParse({ params: { id }, body: { priority: 'HIGH' } }).success,
    ).toBe(false);
    expect(updateTicketSchema.safeParse({ params: { id }, body: { version: 1 } }).success).toBe(
      false,
    );
  });

  it('keeps the status out of the regular update body', () => {
    const parsed = updateTicketSchema.safeParse({
      params: { id },
      body: { version: 1, status: 'CLOSED' },
    });
    expect(parsed.success && 'status' in parsed.data.body).toBe(false);
  });

  it('requires a version and a target status for transitions', () => {
    expect(
      transitionTicketSchema.safeParse({ params: { id }, body: { version: 1, toStatus: 'OPEN' } })
        .success,
    ).toBe(true);
    expect(
      transitionTicketSchema.safeParse({ params: { id }, body: { toStatus: 'OPEN' } }).success,
    ).toBe(false);
    expect(transitionTicketSchema.safeParse({ params: { id }, body: { version: 1 } }).success).toBe(
      false,
    );
  });

  it('caps the transition note at five hundred characters', () => {
    const withNote = (note: string) => ({
      params: { id },
      body: { version: 1, toStatus: 'OPEN', note },
    });
    expect(transitionTicketSchema.safeParse(withNote('a'.repeat(500))).success).toBe(true);
    expect(transitionTicketSchema.safeParse(withNote('a'.repeat(501))).success).toBe(false);
  });

  it('requires a version query parameter for deletion', () => {
    expect(deleteTicketSchema.safeParse({ params: { id }, query: { version: '1' } }).success).toBe(
      true,
    );
    expect(deleteTicketSchema.safeParse({ params: { id }, query: {} }).success).toBe(false);
  });
});

describe('ticket list validation', () => {
  it('applies the shared pagination and sorting defaults', () => {
    const parsed = listTicketsSchema.safeParse({ query: {} });
    expect(parsed.success && parsed.data.query).toMatchObject({
      page: 1,
      pageSize: 20,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });
  });

  it('rejects an opened range that runs backwards', () => {
    expect(
      listTicketsSchema.safeParse({
        query: { openedFrom: '2026-03-02T00:00:00Z', openedTo: '2026-03-01T00:00:00Z' },
      }).success,
    ).toBe(false);
    expect(
      listTicketsSchema.safeParse({
        query: { openedFrom: '2026-03-01T00:00:00Z', openedTo: '2026-03-02T00:00:00Z' },
      }).success,
    ).toBe(true);
  });

  it('accepts only the documented sort fields', () => {
    for (const sortBy of ['createdAt', 'updatedAt', 'openedAt', 'priority', 'status']) {
      expect(listTicketsSchema.safeParse({ query: { sortBy } }).success).toBe(true);
    }
    expect(listTicketsSchema.safeParse({ query: { sortBy: 'subject' } }).success).toBe(false);
  });
});
