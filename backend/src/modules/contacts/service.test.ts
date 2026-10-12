import { describe, expect, it, jest } from '@jest/globals';

import type { AuditService } from '../audit/service.js';
import { createContactsService, type ContactsDatabase } from './service.js';
import type { ContactAccess } from './types.js';

const everything: ContactAccess = { actorId: 'actor-1', scope: 'ALL' };

const storedContact = {
  id: '5ff875e1-4c1d-4e45-9c8a-fceb5fb5d836',
  ownerId: everything.actorId,
  firstName: 'Ada',
  lastName: 'Byron',
  email: 'ada@example.com',
  phone: null,
  company: null,
  notes: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  deletedAt: null,
};

const createHarness = ({ ownerActive = true } = {}) => {
  const calls: string[] = [];
  const queryRaw = jest.fn(async () => {
    calls.push('lock');
    return [];
  });
  const contactFindFirst = jest.fn(async (args: { select?: { id?: boolean } }) => {
    // The duplicate check selects only the id; the record read selects it all.
    if (args.select && Object.keys(args.select).length === 1) {
      calls.push('duplicate');
      return null;
    }
    calls.push('read');
    return storedContact;
  });
  const contactUpdate = jest.fn(async () => storedContact);
  const contactCreate = jest.fn(async () => storedContact);
  const userFindFirst = jest.fn(async (_args: unknown) => (ownerActive ? { id: 'owner-2' } : null));
  const transaction = {
    $queryRaw: queryRaw,
    contact: { findFirst: contactFindFirst, update: contactUpdate, create: contactCreate },
    user: { findFirst: userFindFirst },
    auditLog: { create: jest.fn() },
  };
  const findMany = jest.fn(async () => []);
  const count = jest.fn(async () => 0);
  const db = {
    contact: { findMany, count },
    $transaction: jest.fn(async (callback: (value: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
    ),
  } as unknown as ContactsDatabase;
  const audit = { record: jest.fn(async () => undefined) } as unknown as AuditService;

  return {
    service: createContactsService(db, audit),
    calls,
    queryRaw,
    contactUpdate,
    contactCreate,
    userFindFirst,
    findMany,
  };
};

describe('contacts service', () => {
  it('locks the row before reading the record it is about to edit', async () => {
    const harness = createHarness();

    await harness.service.update(everything, storedContact.id, {
      email: null,
      phone: '+380671234567',
    });

    expect(harness.calls.slice(0, 2)).toEqual(['lock', 'read']);
    expect(harness.queryRaw).toHaveBeenCalledTimes(1);
  });

  it('refuses an owner who is unknown or no longer active on create', async () => {
    const harness = createHarness({ ownerActive: false });

    await expect(
      harness.service.create(everything, {
        ownerId: 'owner-2',
        firstName: 'Ada',
        lastName: 'Byron',
        email: 'ada@example.com',
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'CONTACT_OWNER_NOT_FOUND' });
    expect(harness.userFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'owner-2', isActive: true } }),
    );
    expect(harness.contactCreate).not.toHaveBeenCalled();
  });

  it('refuses an unknown owner on update instead of failing on the foreign key', async () => {
    const harness = createHarness({ ownerActive: false });

    await expect(
      harness.service.update(everything, storedContact.id, { ownerId: 'owner-2' }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'CONTACT_OWNER_NOT_FOUND' });
    expect(harness.contactUpdate).not.toHaveBeenCalled();
  });

  it('does not look the owner up when the request names none', async () => {
    const harness = createHarness();

    await harness.service.update(everything, storedContact.id, { firstName: 'Augusta' });

    expect(harness.userFindFirst).not.toHaveBeenCalled();
  });

  it('searches for LIKE wildcards literally', async () => {
    const harness = createHarness();

    await harness.service.list(everything, {
      page: 1,
      pageSize: 20,
      search: '100%_off\\',
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });

    const [args] = harness.findMany.mock.calls[0] as unknown as [
      { where: { OR: { firstName?: { contains: string } }[] } },
    ];
    expect(args.where.OR[0]?.firstName?.contains).toBe('100\\%\\_off\\\\');
  });
});
