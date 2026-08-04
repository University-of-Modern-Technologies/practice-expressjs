import { describe, expect, it, jest } from '@jest/globals';

import { AppError } from '../../common/errors/index.js';
import type { DomainEventNotification, DomainEventPublisher } from '../../common/types/index.js';
import type { AuditService } from '../audit/service.js';
import { createDealsService, type DealsDatabase } from './service.js';
import type { CreateDealData, DealAccess } from './types.js';

const access: DealAccess = { actorId: 'actor-1', scope: 'OWN' };
const activeDeal = {
  id: 'deal-1',
  ownerId: access.actorId,
  contactId: null,
  title: 'Opportunity',
  stage: 'LEAD' as const,
  amount: '1000.00',
  currency: 'USD',
  probability: 10,
  version: 1,
  expectedCloseDate: null,
  closedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  deletedAt: null,
};
const updatedDeal = {
  ...activeDeal,
  probability: 25,
  version: 2,
  updatedAt: new Date('2026-01-02T00:00:00Z'),
};
const transitionedDeal = {
  ...updatedDeal,
  stage: 'QUALIFIED' as const,
};

const createHarness = (update: (args: unknown) => Promise<unknown>) => {
  const findFirst = jest.fn(async (_args: unknown) => activeDeal);
  const updateDeal = jest.fn(update);
  const transaction = {
    deal: { findFirst, update: updateDeal },
    contact: { findFirst: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const db = {
    deal: { findFirst: jest.fn() },
    $transaction: jest.fn(async (callback: (value: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
    ),
  } as unknown as DealsDatabase;
  const record = jest.fn(async () => undefined);
  const audit = { record } as unknown as AuditService;
  const publish = jest.fn((_event: DomainEventNotification): void => undefined);
  const events: DomainEventPublisher = { publish };

  return {
    service: createDealsService(db, audit, events),
    db,
    findFirst,
    updateDeal,
    record,
    publish,
  };
};

describe('deals service correctness', () => {
  it('rejects a non-LEAD initial stage even if validation is bypassed', async () => {
    const harness = createHarness(async () => transitionedDeal);
    const data = {
      title: 'Closed opportunity',
      stage: 'WON',
      amount: '1000.00',
    } as unknown as CreateDealData;

    await expect(harness.service.create(access, data)).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_INITIAL_DEAL_STAGE',
    });
    expect(harness.db.$transaction).not.toHaveBeenCalled();
  });

  it('guards regular updates by version and stage and increments the version', async () => {
    const harness = createHarness(async () => updatedDeal);

    const result = await harness.service.update(access, activeDeal.id, {
      version: 1,
      probability: 25,
    });

    expect(result).toMatchObject({ probability: 25, version: 2 });
    expect(harness.updateDeal).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: activeDeal.id,
          version: 1,
          stage: 'LEAD',
          deletedAt: null,
          ownerId: access.actorId,
        },
        data: expect.objectContaining({
          probability: 25,
          version: { increment: 1 },
        }),
      }),
    );
  });

  it('rejects an already stale regular update before writing', async () => {
    const harness = createHarness(async () => updatedDeal);

    await expect(
      harness.service.update(access, activeDeal.id, { version: 2, probability: 25 }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'DEAL_CONCURRENT_MODIFICATION',
    } satisfies Partial<AppError>);
    expect(harness.updateDeal).not.toHaveBeenCalled();
    expect(harness.record).not.toHaveBeenCalled();
  });

  it('atomically checks the version, previously read stage and access guards', async () => {
    const harness = createHarness(async () => transitionedDeal);

    const result = await harness.service.transition(access, activeDeal.id, {
      version: 1,
      stage: 'QUALIFIED',
      probability: 25,
    });

    expect(result.stage).toBe('QUALIFIED');
    expect(harness.updateDeal).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: activeDeal.id,
          version: 1,
          stage: 'LEAD',
          deletedAt: null,
          ownerId: access.actorId,
        },
        data: expect.objectContaining({ version: { increment: 1 } }),
      }),
    );
    expect(harness.record).toHaveBeenCalledTimes(1);
  });

  it('returns a conflict and skips audit when a concurrent transition wins first', async () => {
    const harness = createHarness(async () => {
      throw { code: 'P2025' };
    });

    await expect(
      harness.service.transition(access, activeDeal.id, { version: 1, stage: 'QUALIFIED' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'DEAL_CONCURRENT_MODIFICATION',
    } satisfies Partial<AppError>);
    expect(harness.record).not.toHaveBeenCalled();
  });
});

describe('deals service domain event fan-out', () => {
  it('announces a committed transition once the transaction has succeeded', async () => {
    const harness = createHarness(async () => transitionedDeal);

    await harness.service.transition(access, activeDeal.id, { version: 1, stage: 'QUALIFIED' });

    expect(harness.publish).toHaveBeenCalledTimes(1);
    expect(harness.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'deal.stage_transitioned',
        entityType: 'deal',
        entityId: activeDeal.id,
        actorId: access.actorId,
        payload: expect.objectContaining({ from: 'LEAD', to: 'QUALIFIED' }),
      }),
    );
  });

  it('stays silent when the transaction is rejected', async () => {
    const harness = createHarness(async () => {
      throw { code: 'P2025' };
    });

    await expect(
      harness.service.transition(access, activeDeal.id, { version: 1, stage: 'QUALIFIED' }),
    ).rejects.toBeInstanceOf(AppError);
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('keeps the business result when the secondary consumers fail', async () => {
    const harness = createHarness(async () => transitionedDeal);
    harness.publish.mockImplementation(() => {
      throw new Error('event stream unreachable');
    });

    // The publisher owns its own failures; a broken stream must never turn a
    // committed transition into a failed request.
    await expect(
      harness.service.transition(access, activeDeal.id, { version: 1, stage: 'QUALIFIED' }),
    ).resolves.toMatchObject({ id: activeDeal.id, stage: 'QUALIFIED' });
  });
});
