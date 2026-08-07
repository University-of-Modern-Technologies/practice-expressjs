import { describe, expect, it, jest } from '@jest/globals';
import type { Logger } from 'pino';

import type { AppConfig } from '../config/env.js';
import { createEventStoreService } from './event-store.service.js';
import type { DomainEventModelPort, DomainEventRecord } from './types.js';

const config = {
  mongodbUrl: 'mongodb://127.0.0.1:27017/events-test',
  eventLogRetentionDays: 90,
} as unknown as AppConfig;

const createLogger = () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  return { logger: logger as unknown as Logger, spies: logger };
};

const createQuery = <TResult>(result: TResult) => {
  const query = {
    sort: jest.fn((_spec: Record<string, 1 | -1>) => query),
    skip: jest.fn((_count: number) => query),
    limit: jest.fn((_count: number) => query),
    lean: jest.fn(() => query),
    exec: jest.fn(async () => result),
  };
  return query;
};

const occurredAt = new Date('2026-08-05T12:00:00.000Z');
const record: DomainEventRecord = {
  _id: { toString: () => 'event-1' },
  eventType: 'contact.updated',
  entityType: 'contacts',
  entityId: '5ff875e1-4c1d-4e45-9c8a-fceb5fb5d836',
  actorId: 'actor-1',
  requestId: 'req-1',
  payload: { company: 'Acme' },
  occurredAt,
};

const createHarness = (overrides: Partial<DomainEventModelPort> = {}) => {
  const findQuery = createQuery<readonly DomainEventRecord[]>([record]);
  const countQuery = createQuery(1);
  const create = jest.fn(async (_document: unknown) => undefined);
  const find = jest.fn((_filter: unknown) => findQuery);
  const countDocuments = jest.fn((_filter: unknown) => countQuery);

  const model = {
    create,
    find,
    countDocuments,
    ...overrides,
  } as unknown as DomainEventModelPort;

  const { logger, spies } = createLogger();

  return {
    service: createEventStoreService(logger, config, { model }),
    spies,
    create,
    find,
    countDocuments,
    findQuery,
  };
};

describe('event store append', () => {
  it('persists a sanitized event and fills defaults', async () => {
    const { service, create } = createHarness();

    await service.append({
      eventType: 'contact.updated',
      entityType: 'contacts',
      entityId: 'contact-1',
      payload: { email: 'person@example.com', password: 'plain', nested: [{ token: 'abc' }] },
      occurredAt,
    });

    expect(create).toHaveBeenCalledWith({
      eventType: 'contact.updated',
      entityType: 'contacts',
      entityId: 'contact-1',
      actorId: null,
      requestId: null,
      payload: {
        email: 'person@example.com',
        password: '[REDACTED]',
        nested: [{ token: '[REDACTED]' }],
      },
      occurredAt,
    });
  });

  it('swallows persistence failures so business logic is never broken', async () => {
    const { service, spies } = createHarness({
      create: jest.fn(async () => {
        throw new Error('MongoNetworkError: connection refused');
      }) as unknown as DomainEventModelPort['create'],
    });

    await expect(
      service.append({
        eventType: 'contact.created',
        entityType: 'contacts',
        entityId: 'contact-1',
      }),
    ).resolves.toBeUndefined();

    expect(spies.error).toHaveBeenCalledTimes(1);
  });

  it('drops malformed events without touching the store', async () => {
    const { service, create, spies } = createHarness();

    await service.append({ eventType: '', entityType: 'contacts', entityId: 'contact-1' });

    expect(create).not.toHaveBeenCalled();
    expect(spies.warn).toHaveBeenCalledTimes(1);
  });
});

describe('event store queries', () => {
  it('maps entity history to the shared pagination envelope', async () => {
    const { service, find, countDocuments, findQuery } = createHarness();

    const result = await service.listByEntity({
      entityType: 'contacts',
      entityId: '5ff875e1-4c1d-4e45-9c8a-fceb5fb5d836',
      page: 3,
      pageSize: 10,
    });

    const filter = { entityType: 'contacts', entityId: '5ff875e1-4c1d-4e45-9c8a-fceb5fb5d836' };
    expect(find).toHaveBeenCalledWith(filter);
    expect(countDocuments).toHaveBeenCalledWith(filter);
    expect(findQuery.sort).toHaveBeenCalledWith({ occurredAt: -1, _id: -1 });
    expect(findQuery.skip).toHaveBeenCalledWith(20);
    expect(findQuery.limit).toHaveBeenCalledWith(10);
    expect(result).toEqual({
      items: [
        {
          id: 'event-1',
          eventType: 'contact.updated',
          entityType: 'contacts',
          entityId: '5ff875e1-4c1d-4e45-9c8a-fceb5fb5d836',
          actorId: 'actor-1',
          requestId: 'req-1',
          payload: { company: 'Acme' },
          occurredAt,
        },
      ],
      page: 3,
      pageSize: 10,
      total: 1,
    });
  });

  it('builds search filters from event type, actor and a date range', async () => {
    const { service, find } = createHarness();
    const from = new Date('2026-08-01T00:00:00.000Z');
    const to = new Date('2026-08-31T23:59:59.000Z');

    await service.search({
      eventType: 'contact.updated',
      actorId: 'actor-1',
      from,
      to,
      page: 1,
      pageSize: 25,
    });

    expect(find).toHaveBeenCalledWith({
      eventType: 'contact.updated',
      actorId: 'actor-1',
      occurredAt: { $gte: from, $lte: to },
    });
  });

  it('omits absent search filters', async () => {
    const { service, find } = createHarness();

    await service.search({ page: 1, pageSize: 25 });

    expect(find).toHaveBeenCalledWith({});
  });
});
