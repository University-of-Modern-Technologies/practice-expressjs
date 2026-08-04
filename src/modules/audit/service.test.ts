import { describe, expect, it, jest } from '@jest/globals';

import { createAuditService, type AuditDatabase } from './service.js';

const resourceId = '5ff875e1-4c1d-4e45-9c8a-fceb5fb5d836';
const createdAt = new Date('2026-08-05T12:00:00.000Z');
const auditRecord = {
  id: '9c5d2de8-f914-4da6-88d6-6073dfee34aa',
  actorId: 'actor-1',
  action: 'update',
  entityType: 'contacts',
  entityId: resourceId,
  changes: null,
  metadata: null,
  ipAddress: null,
  createdAt,
};

const createHarness = () => {
  const findMany = jest.fn(async (_args: unknown) => [auditRecord]);
  const count = jest.fn(async (_args: unknown) => 1);
  const db = {
    auditLog: {
      create: jest.fn(),
      findMany,
      count,
      findFirst: jest.fn(),
    },
  } as unknown as AuditDatabase;

  return { service: createAuditService(db), findMany, count };
};

describe('audit service history', () => {
  it('queries the requested resource with action, date and pagination filters', async () => {
    const { service, findMany, count } = createHarness();
    const createdFrom = new Date('2026-08-01T00:00:00.000Z');
    const createdTo = new Date('2026-08-31T23:59:59.000Z');

    const result = await service.history('actor-1', 'ALL', 'contacts', resourceId, {
      page: 2,
      pageSize: 10,
      action: 'update',
      createdFrom,
      createdTo,
    });

    const where = {
      action: 'update',
      entityType: 'contacts',
      entityId: resourceId,
      createdAt: { gte: createdFrom, lte: createdTo },
    };
    expect(findMany).toHaveBeenCalledWith({
      where,
      skip: 10,
      take: 10,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: expect.any(Object),
    });
    expect(count).toHaveBeenCalledWith({ where });
    expect(result).toEqual({ items: [auditRecord], page: 2, pageSize: 10, total: 1 });
  });

  it('preserves OWN scope by restricting resource history to the requesting actor', async () => {
    const { service, findMany } = createHarness();

    await service.history('actor-1', 'OWN', 'contacts', resourceId, {
      page: 1,
      pageSize: 25,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          actorId: 'actor-1',
          entityType: 'contacts',
          entityId: resourceId,
        },
      }),
    );
  });
});
