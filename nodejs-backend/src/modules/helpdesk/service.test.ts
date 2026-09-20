import { describe, expect, it, jest } from '@jest/globals';

import { AppError } from '../../common/errors/index.js';
import type { DomainEventNotification, DomainEventPublisher } from '../../common/types/index.js';
import type { AuditService } from '../audit/service.js';
import { createHelpdeskService, type HelpdeskDatabase } from './service.js';
import type { CreateTicketData, TicketAccess, TicketDto } from './types.js';

/** A stored row: the DTO plus the soft-deletion column the DTO drops. */
type TicketRow = TicketDto & { readonly deletedAt: Date | null };

const access: TicketAccess = { actorId: 'actor-1', scope: 'OWN' };
const wideAccess: TicketAccess = { actorId: 'actor-1', scope: 'ALL' };
const activeTicket: TicketRow = {
  id: 'ticket-1',
  number: 'TKT-00000001',
  subject: 'Printer is jammed',
  body: 'The device reports a paper jam that is not there.',
  channel: 'EMAIL',
  status: 'OPEN',
  priority: 'NORMAL',
  ownerId: access.actorId,
  contactId: null,
  assigneeId: null,
  version: 1,
  openedAt: new Date('2026-01-01T00:00:00Z'),
  resolvedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  deletedAt: null,
};
const updatedTicket: TicketRow = {
  ...activeTicket,
  priority: 'HIGH',
  version: 2,
  updatedAt: new Date('2026-01-02T00:00:00Z'),
};
const resolvedTicket: TicketRow = {
  ...updatedTicket,
  status: 'RESOLVED',
  resolvedAt: new Date('2026-01-02T00:00:00Z'),
};

const validTicket: CreateTicketData = {
  subject: activeTicket.subject,
  body: activeTicket.body,
  channel: 'EMAIL',
};

interface HarnessOptions {
  readonly existing?: TicketRow;
  readonly update?: (args: unknown) => Promise<unknown>;
  readonly create?: (args: unknown) => Promise<unknown>;
  readonly contact?: { id: string } | null;
  readonly assignee?: { id: string } | null;
}

const createHarness = (options: HarnessOptions = {}) => {
  const findFirst = jest.fn(
    async (_args: unknown): Promise<TicketRow> => options.existing ?? activeTicket,
  );
  const updateTicket = jest.fn(options.update ?? (async (_args: unknown) => updatedTicket));
  const createTicket = jest.fn(options.create ?? (async (_args: unknown) => activeTicket));
  const createLog = jest.fn(async (_args: unknown) => ({ id: 'log-1' }));
  const findContact = jest.fn(async (_args: unknown) => options.contact ?? null);
  const findUser = jest.fn(async (_args: unknown) => options.assignee ?? null);
  const findMany = jest.fn(async (_args: unknown) => [activeTicket]);
  const count = jest.fn(async (_args: unknown) => 1);
  const transaction = {
    ticket: { findFirst, update: updateTicket, create: createTicket },
    ticketStatusLog: { create: createLog },
    contact: { findFirst: findContact },
    user: { findFirst: findUser },
    auditLog: { create: jest.fn() },
  };
  const readTicket = jest.fn(
    async (_args: unknown): Promise<TicketRow | null> => options.existing ?? activeTicket,
  );
  const db = {
    ticket: { findFirst: readTicket, findMany, count },
    $transaction: jest.fn(async (callback: (value: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
    ),
  } as unknown as HelpdeskDatabase;
  const record = jest.fn(async () => undefined);
  const audit = { record } as unknown as AuditService;
  const publish = jest.fn((_event: DomainEventNotification): void => undefined);
  const events: DomainEventPublisher = { publish };

  return {
    service: createHelpdeskService(db, audit, events),
    db,
    findFirst,
    readTicket,
    updateTicket,
    createTicket,
    createLog,
    findContact,
    findUser,
    findMany,
    record,
    publish,
  };
};

const listQuery = {
  page: 1,
  pageSize: 20,
  sortBy: 'createdAt' as const,
  sortOrder: 'desc' as const,
};

/**
 * The `resolvedAt` a transition actually wrote. An absent property and a
 * `null` one mean opposite things here, so the raw value is returned rather
 * than normalised.
 */
const writtenResolvedAt = (updateTicket: {
  mock: { calls: readonly unknown[] };
}): Date | null | undefined =>
  (updateTicket.mock.calls[0] as [{ data: { resolvedAt?: Date | null } }])[0].data.resolvedAt;

describe('helpdesk service scope narrowing', () => {
  it('narrows the listing itself to the actor, ignoring a requested owner', async () => {
    const harness = createHarness();

    await harness.service.list(access, { ...listQuery, ownerId: 'someone-else' });

    expect(harness.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deletedAt: null, ownerId: access.actorId }),
      }),
    );
  });

  it('honours a requested owner filter when the scope is not narrowed', async () => {
    const harness = createHarness();

    await harness.service.list(wideAccess, { ...listQuery, ownerId: 'someone-else' });

    expect(harness.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ ownerId: 'someone-else' }) }),
    );
  });

  it('narrows a single read to the actor as well', async () => {
    const harness = createHarness();

    await harness.service.getById(access, activeTicket.id);

    expect(harness.readTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: activeTicket.id, deletedAt: null, ownerId: access.actorId },
      }),
    );
  });

  it('refuses to hand a ticket to another owner', async () => {
    const harness = createHarness();

    await expect(
      harness.service.create(access, { ...validTicket, ownerId: 'someone-else' }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect(harness.db.$transaction).not.toHaveBeenCalled();
  });
});

describe('helpdesk service creation', () => {
  it('opens the ticket as NEW under a generated number and logs the opening entry', async () => {
    const harness = createHarness();

    await harness.service.create(access, validTicket);

    expect(harness.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          number: expect.stringMatching(/^TKT-\d{8}$/) as unknown as string,
          status: 'NEW',
          priority: 'NORMAL',
          ownerId: access.actorId,
          resolvedAt: null,
        }),
      }),
    );
    expect(harness.createLog).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fromStatus: null,
          toStatus: activeTicket.status,
          changedById: access.actorId,
        }),
      }),
    );
    expect(harness.record).toHaveBeenCalledTimes(1);
  });

  it('redraws the number when the unique index rejects the first one', async () => {
    let attempts = 0;
    const harness = createHarness({
      create: async () => {
        attempts += 1;
        if (attempts === 1) throw { code: 'P2002', meta: { target: ['number'] } };
        return activeTicket;
      },
    });

    await expect(harness.service.create(access, validTicket)).resolves.toMatchObject({
      id: activeTicket.id,
    });
    expect(harness.createTicket).toHaveBeenCalledTimes(2);
    const [first, second] = harness.createTicket.mock.calls as unknown as [
      [{ data: { number: string } }],
      [{ data: { number: string } }],
    ];
    expect(first[0].data.number).not.toBe(second[0].data.number);
  });

  it('reports a duplicate number once the redraws are exhausted', async () => {
    const harness = createHarness({
      create: async () => {
        throw { code: 'P2002', meta: { target: ['number'] } };
      },
    });

    await expect(harness.service.create(access, validTicket)).rejects.toMatchObject({
      statusCode: 409,
      code: 'TICKET_DUPLICATE_NUMBER',
    } satisfies Partial<AppError>);
    expect(harness.createTicket).toHaveBeenCalledTimes(5);
  });

  it('rejects an unreachable contact before writing anything', async () => {
    const harness = createHarness({ contact: null });

    await expect(
      harness.service.create(access, { ...validTicket, contactId: 'contact-1' }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'TICKET_CONTACT_NOT_FOUND' });
    expect(harness.createTicket).not.toHaveBeenCalled();
  });

  it('rejects an assignee that is not an active account', async () => {
    const harness = createHarness({ contact: { id: 'contact-1' }, assignee: null });

    await expect(
      harness.service.create(access, { ...validTicket, assigneeId: 'user-2' }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'TICKET_ASSIGNEE_NOT_FOUND' });
    expect(harness.createTicket).not.toHaveBeenCalled();
  });
});

describe('helpdesk service correctness', () => {
  it('guards regular updates by version and status and increments the version', async () => {
    const harness = createHarness();

    const result = await harness.service.update(access, activeTicket.id, {
      version: 1,
      priority: 'HIGH',
    });

    expect(result).toMatchObject({ priority: 'HIGH', version: 2 });
    expect(harness.updateTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: activeTicket.id,
          version: 1,
          status: 'OPEN',
          deletedAt: null,
          ownerId: access.actorId,
        },
        data: expect.objectContaining({ priority: 'HIGH', version: { increment: 1 } }),
      }),
    );
  });

  it('rejects an already stale regular update before writing', async () => {
    const harness = createHarness();

    await expect(
      harness.service.update(access, activeTicket.id, { version: 2, priority: 'HIGH' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'TICKET_CONCURRENT_MODIFICATION',
    } satisfies Partial<AppError>);
    expect(harness.updateTicket).not.toHaveBeenCalled();
    expect(harness.record).not.toHaveBeenCalled();
  });

  it('refuses a transition the lifecycle does not list', async () => {
    const harness = createHarness({ existing: { ...activeTicket, status: 'NEW' as const } });

    await expect(
      harness.service.transition(access, activeTicket.id, { version: 1, toStatus: 'RESOLVED' }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'TICKET_TRANSITION_NOT_ALLOWED',
    } satisfies Partial<AppError>);
    expect(harness.updateTicket).not.toHaveBeenCalled();
    expect(harness.createLog).not.toHaveBeenCalled();
    expect(harness.record).not.toHaveBeenCalled();
  });

  it('atomically checks the version, previously read status and access guards', async () => {
    const harness = createHarness({ update: async () => resolvedTicket });

    const result = await harness.service.transition(access, activeTicket.id, {
      version: 1,
      toStatus: 'RESOLVED',
      note: 'Cleaned the feed roller',
    });

    expect(result.status).toBe('RESOLVED');
    expect(harness.updateTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: activeTicket.id,
          version: 1,
          status: 'OPEN',
          deletedAt: null,
          ownerId: access.actorId,
        },
        data: expect.objectContaining({ status: 'RESOLVED', version: { increment: 1 } }),
      }),
    );
    expect(harness.record).toHaveBeenCalledTimes(1);
  });

  it('stamps the resolution when the ticket is resolved', async () => {
    const harness = createHarness({ update: async () => resolvedTicket });

    await harness.service.transition(access, activeTicket.id, { version: 1, toStatus: 'RESOLVED' });

    expect(writtenResolvedAt(harness.updateTicket)).toBeInstanceOf(Date);
  });

  it('clears the resolution when the ticket goes back into progress', async () => {
    const harness = createHarness({
      existing: resolvedTicket,
      update: async () => ({ ...resolvedTicket, status: 'OPEN' as const, resolvedAt: null }),
    });

    await harness.service.transition(access, activeTicket.id, {
      version: resolvedTicket.version,
      toStatus: 'OPEN',
    });

    expect(writtenResolvedAt(harness.updateTicket)).toBeNull();
  });

  it('leaves the resolution alone when the ticket is closed', async () => {
    // Closing a resolved ticket must not erase the time it was resolved, and
    // closing an unresolved one must not invent a time it never had — so the
    // column is simply not part of the write.
    for (const existing of [resolvedTicket, activeTicket]) {
      const harness = createHarness({
        existing,
        update: async () => ({ ...existing, status: 'CLOSED' as const }),
      });

      await harness.service.transition(access, activeTicket.id, {
        version: existing.version,
        toStatus: 'CLOSED',
      });

      expect(writtenResolvedAt(harness.updateTicket)).toBeUndefined();
    }
  });

  it('journals the transition inside the same transaction as the status change', async () => {
    const harness = createHarness({ update: async () => resolvedTicket });

    await harness.service.transition(access, activeTicket.id, {
      version: 1,
      toStatus: 'RESOLVED',
      note: 'Cleaned the feed roller',
    });

    expect(harness.createLog).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          ticketId: activeTicket.id,
          fromStatus: 'OPEN',
          toStatus: 'RESOLVED',
          changedById: access.actorId,
          note: 'Cleaned the feed roller',
        },
      }),
    );
    // One transaction carried the ticket row, the journal entry and the audit
    // record, so none of them can survive without the others.
    expect(harness.db.$transaction).toHaveBeenCalledTimes(1);
  });

  it('returns a conflict and skips the journal when a concurrent transition wins first', async () => {
    const harness = createHarness({
      update: async () => {
        throw { code: 'P2025' };
      },
    });

    await expect(
      harness.service.transition(access, activeTicket.id, { version: 1, toStatus: 'RESOLVED' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'TICKET_CONCURRENT_MODIFICATION',
    } satisfies Partial<AppError>);
    expect(harness.createLog).not.toHaveBeenCalled();
    expect(harness.record).not.toHaveBeenCalled();
  });

  it('reports a missing ticket rather than the absence of access', async () => {
    const harness = createHarness();
    harness.readTicket.mockImplementation(async () => null);

    await expect(harness.service.getById(access, 'ticket-404')).rejects.toMatchObject({
      statusCode: 404,
      code: 'TICKET_NOT_FOUND',
    } satisfies Partial<AppError>);
  });

  it('soft-deletes under the version guard instead of removing the row', async () => {
    const harness = createHarness({ update: async () => ({ ...activeTicket, version: 2 }) });

    await harness.service.delete(access, activeTicket.id, 1);

    expect(harness.updateTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: activeTicket.id,
          version: 1,
          deletedAt: null,
          ownerId: access.actorId,
        },
        data: expect.objectContaining({ version: { increment: 1 } }),
      }),
    );
    expect(harness.record).toHaveBeenCalledTimes(1);
  });
});

describe('helpdesk service domain event fan-out', () => {
  it('announces a committed transition once the transaction has succeeded', async () => {
    const harness = createHarness({ update: async () => resolvedTicket });

    await harness.service.transition(access, activeTicket.id, { version: 1, toStatus: 'RESOLVED' });

    expect(harness.publish).toHaveBeenCalledTimes(1);
    expect(harness.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ticket.status_transitioned',
        entityType: 'ticket',
        entityId: activeTicket.id,
        actorId: access.actorId,
        payload: expect.objectContaining({ from: 'OPEN', to: 'RESOLVED' }),
      }),
    );
  });

  it('announces creation and deletion under their own event types', async () => {
    const created = createHarness();
    await created.service.create(access, validTicket);
    expect(created.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ticket.created', entityType: 'ticket' }),
    );

    const deleted = createHarness({ update: async () => ({ ...activeTicket, version: 2 }) });
    await deleted.service.delete(access, activeTicket.id, 1);
    expect(deleted.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ticket.deleted', entityType: 'ticket' }),
    );
  });

  it('stays silent when the transaction is rejected', async () => {
    const harness = createHarness({
      update: async () => {
        throw { code: 'P2025' };
      },
    });

    await expect(
      harness.service.transition(access, activeTicket.id, { version: 1, toStatus: 'RESOLVED' }),
    ).rejects.toBeInstanceOf(AppError);
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('keeps the business result when the secondary consumers fail', async () => {
    const harness = createHarness({ update: async () => resolvedTicket });
    harness.publish.mockImplementation(() => {
      throw new Error('event stream unreachable');
    });

    // The publisher owns its own failures; a broken stream must never turn a
    // committed transition into a failed request.
    await expect(
      harness.service.transition(access, activeTicket.id, { version: 1, toStatus: 'RESOLVED' }),
    ).resolves.toMatchObject({ id: activeTicket.id, status: 'RESOLVED' });
  });
});
