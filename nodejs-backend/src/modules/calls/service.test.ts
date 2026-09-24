import { describe, expect, it, jest } from '@jest/globals';

import { AppError } from '../../common/errors/index.js';
import type { DomainEventNotification, DomainEventPublisher } from '../../common/types/index.js';
import type { AuditService } from '../audit/service.js';
import { callProviderUnavailableError, type CallProvider } from './provider.js';
import { createCallsService, type CallsDatabase } from './service.js';
import type { CallAccess, CallDto } from './types.js';

/** A stored row: the DTO plus the soft-deletion column the DTO drops. */
type CallRow = CallDto & { readonly deletedAt: Date | null };

const access: CallAccess = { actorId: 'actor-1', scope: 'OWN' };
const wideAccess: CallAccess = { actorId: 'actor-1', scope: 'ALL' };

const ownedCall: CallRow = {
  id: 'call-1',
  externalId: 'ext-1',
  direction: 'INBOUND',
  disposition: 'ANSWERED',
  fromNumber: '+14155551001',
  toNumber: '+14155550100',
  startedAt: new Date('2026-01-01T09:00:00Z'),
  durationSeconds: 58,
  ownerId: access.actorId,
  contactId: null,
  dealId: null,
  recordingUrl: 'https://recordings.invalid/ext-1.mp3',
  notes: null,
  version: 1,
  createdAt: new Date('2026-01-01T09:01:00Z'),
  updatedAt: new Date('2026-01-01T09:01:00Z'),
  deletedAt: null,
};
const linkedCall: CallRow = {
  ...ownedCall,
  contactId: 'contact-1',
  version: 2,
  updatedAt: new Date('2026-01-02T09:00:00Z'),
};

const batch = [
  {
    externalId: 'ext-1',
    direction: 'INBOUND' as const,
    disposition: 'ANSWERED' as const,
    fromNumber: '+14155551001',
    toNumber: '+14155550100',
    startedAt: '2026-01-01T09:00:00.000Z',
    durationSeconds: 58,
    recordingUrl: 'https://recordings.invalid/ext-1.mp3',
  },
  {
    externalId: 'ext-2',
    direction: 'OUTBOUND' as const,
    disposition: 'NO_ANSWER' as const,
    fromNumber: '+14155550100',
    toNumber: '+14155551002',
    startedAt: '2026-01-01T08:43:00.000Z',
    durationSeconds: 0,
  },
];

/** A provider whose journal is fixed, so two runs see exactly the same batch. */
const stableProvider = (): CallProvider => ({
  name: 'test',
  fetchCalls: () => Promise.resolve(batch),
});

interface HarnessOptions {
  readonly existing?: CallRow;
  readonly update?: (args: unknown) => Promise<unknown>;
  readonly contact?: { id: string } | null;
  readonly deal?: { id: string } | null;
  readonly provider?: CallProvider;
  readonly now?: (() => number) | undefined;
}

const createHarness = (options: HarnessOptions = {}) => {
  // Stands in for the unique index on `external_id`: a second insert of an id
  // already stored fails exactly the way Postgres would.
  const stored = new Set<string>();
  let sequence = 0;
  const createCall = jest.fn(async (args: unknown) => {
    const { data } = args as { data: { externalId: string; recordingUrl: string | null } };
    if (stored.has(data.externalId)) throw { code: 'P2002', meta: { target: ['external_id'] } };
    stored.add(data.externalId);
    sequence += 1;
    return {
      ...ownedCall,
      id: `call-${sequence}`,
      externalId: data.externalId,
      ownerId: null,
      recordingUrl: data.recordingUrl,
    };
  });
  const findFirst = jest.fn(
    async (_args: unknown): Promise<CallRow> => options.existing ?? ownedCall,
  );
  const updateCall = jest.fn(options.update ?? (async (_args: unknown) => linkedCall));
  const findContact = jest.fn(async (_args: unknown) => options.contact ?? null);
  const findDeal = jest.fn(async (_args: unknown) => options.deal ?? null);
  const findMany = jest.fn(async (_args: unknown) => [ownedCall]);
  const count = jest.fn(async (_args: unknown) => 1);
  const transaction = {
    call: { findFirst, update: updateCall, create: createCall },
    contact: { findFirst: findContact },
    deal: { findFirst: findDeal },
    auditLog: { create: jest.fn() },
  };
  const readCall = jest.fn(
    async (_args: unknown): Promise<CallRow | null> => options.existing ?? ownedCall,
  );
  const db = {
    call: { findFirst: readCall, findMany, count },
    $transaction: jest.fn(async (callback: (value: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
    ),
  } as unknown as CallsDatabase;
  const record = jest.fn(async () => undefined);
  const audit = { record } as unknown as AuditService;
  const publish = jest.fn((_event: DomainEventNotification): void => undefined);
  const events: DomainEventPublisher = { publish };
  const provider = options.provider ?? stableProvider();

  return {
    service: createCallsService(db, audit, provider, events, {
      ...(options.now ? { now: options.now } : {}),
    }),
    db,
    provider,
    createCall,
    findFirst,
    readCall,
    updateCall,
    findContact,
    findDeal,
    findMany,
    record,
    publish,
  };
};

const listQuery = {
  page: 1,
  pageSize: 20,
  sortBy: 'startedAt' as const,
  sortOrder: 'desc' as const,
};

describe('calls service scope narrowing', () => {
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

    await harness.service.getById(access, ownedCall.id);

    expect(harness.readCall).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ownedCall.id, deletedAt: null, ownerId: access.actorId },
      }),
    );
  });

  it('refuses to hand a call to another owner or to nobody', async () => {
    // A nobody's call is not the actor's either, so dropping the owner under a
    // narrowed scope is the same refusal as giving the call away.
    for (const ownerId of ['someone-else', null]) {
      const harness = createHarness();

      await expect(
        harness.service.update(access, ownedCall.id, { version: 1, ownerId }),
      ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
      expect(harness.updateCall).not.toHaveBeenCalled();
    }
  });

  it('reports a missing call rather than the absence of access', async () => {
    const harness = createHarness();
    harness.readCall.mockImplementation(async () => null);

    await expect(harness.service.getById(access, 'call-404')).rejects.toMatchObject({
      statusCode: 404,
      code: 'CALL_NOT_FOUND',
    } satisfies Partial<AppError>);
  });
});

describe('calls service listing filters', () => {
  it('turns hasContact into a presence test on the link', async () => {
    const attached = createHarness();
    await attached.service.list(wideAccess, { ...listQuery, hasContact: true });
    expect(attached.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ contactId: { not: null } }) }),
    );

    const loose = createHarness();
    await loose.service.list(wideAccess, { ...listQuery, hasContact: false });
    expect(loose.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ contactId: null }) }),
    );
  });

  it('orders by the requested field with the id as the tie-breaker', async () => {
    const harness = createHarness();

    await harness.service.list(wideAccess, { ...listQuery, sortBy: 'durationSeconds' });

    expect(harness.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ durationSeconds: 'desc' }, { id: 'asc' }] }),
    );
  });
});

describe('calls service import', () => {
  it('stores the batch as nobody’s calls and reports what it did', async () => {
    const harness = createHarness();

    await expect(harness.service.sync(wideAccess)).resolves.toEqual({
      fetched: 2,
      created: 2,
      skipped: 0,
    });
    expect(harness.createCall).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          externalId: 'ext-1',
          ownerId: null,
          contactId: null,
          dealId: null,
          recordingUrl: 'https://recordings.invalid/ext-1.mp3',
        }),
      }),
    );
    expect(harness.record).toHaveBeenCalledTimes(2);
  });

  it('creates no duplicates when the same batch arrives twice', async () => {
    const harness = createHarness();

    const first = await harness.service.sync(wideAccess);
    const second = await harness.service.sync(wideAccess);

    expect(first).toEqual({ fetched: 2, created: 2, skipped: 0 });
    // The external id is the whole idempotency key: the second run reads the
    // same two records, recognises both and writes nothing.
    expect(second).toEqual({ fetched: 2, created: 0, skipped: 2 });
    expect(harness.record).toHaveBeenCalledTimes(2);
  });

  it('keeps importing the rest of a batch around a record it already knows', async () => {
    const harness = createHarness({
      provider: {
        name: 'test',
        fetchCalls: jest
          .fn<CallProvider['fetchCalls']>()
          .mockResolvedValueOnce([batch[0]!])
          .mockResolvedValueOnce(batch),
      },
    });

    await harness.service.sync(wideAccess);

    await expect(harness.service.sync(wideAccess)).resolves.toEqual({
      fetched: 2,
      created: 1,
      skipped: 1,
    });
  });

  it('reports an unreachable provider as a bad gateway and writes nothing', async () => {
    const harness = createHarness({
      provider: {
        name: 'test',
        fetchCalls: () => Promise.reject(callProviderUnavailableError()),
      },
    });

    await expect(harness.service.sync(wideAccess)).rejects.toMatchObject({
      statusCode: 502,
      code: 'CALL_PROVIDER_UNAVAILABLE',
    } satisfies Partial<AppError>);
    expect(harness.createCall).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('announces every imported call once the batch is stored', async () => {
    const harness = createHarness();

    await harness.service.sync(wideAccess);

    expect(harness.publish).toHaveBeenCalledTimes(2);
    expect(harness.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'call.created', entityType: 'call' }),
    );
  });
});

describe('calls service correctness', () => {
  it('guards updates by version and increments it', async () => {
    const harness = createHarness({
      update: async () => ({ ...ownedCall, notes: 'Called back', version: 2 }),
    });

    const result = await harness.service.update(access, ownedCall.id, {
      version: 1,
      notes: 'Called back',
    });

    expect(result).toMatchObject({ notes: 'Called back', version: 2 });
    expect(harness.updateCall).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ownedCall.id, version: 1, deletedAt: null, ownerId: access.actorId },
        data: expect.objectContaining({ notes: 'Called back', version: { increment: 1 } }),
      }),
    );
  });

  it('rejects an already stale update before writing', async () => {
    const harness = createHarness();

    await expect(
      harness.service.update(access, ownedCall.id, { version: 2, notes: 'x' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'CALL_CONCURRENT_MODIFICATION',
    } satisfies Partial<AppError>);
    expect(harness.updateCall).not.toHaveBeenCalled();
    expect(harness.record).not.toHaveBeenCalled();
  });

  it('returns a conflict when a concurrent write wins first', async () => {
    const harness = createHarness({
      contact: { id: 'contact-1' },
      update: async () => {
        throw { code: 'P2025' };
      },
    });

    await expect(
      harness.service.link(access, ownedCall.id, { version: 1, contactId: 'contact-1' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'CALL_CONCURRENT_MODIFICATION',
    } satisfies Partial<AppError>);
    expect(harness.record).not.toHaveBeenCalled();
  });

  it('links the call to a contact and announces it under its own event', async () => {
    const harness = createHarness({ contact: { id: 'contact-1' } });

    const result = await harness.service.link(access, ownedCall.id, {
      version: 1,
      contactId: 'contact-1',
    });

    expect(result.contactId).toBe('contact-1');
    expect(harness.updateCall).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ contactId: 'contact-1', version: { increment: 1 } }),
      }),
    );
    expect(harness.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'call.linked', entityType: 'call' }),
    );
  });

  it('rejects an unreachable contact or deal before writing anything', async () => {
    const withoutContact = createHarness({ contact: null });
    await expect(
      withoutContact.service.link(access, ownedCall.id, { version: 1, contactId: 'contact-1' }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'CALL_CONTACT_NOT_FOUND' });
    expect(withoutContact.updateCall).not.toHaveBeenCalled();

    const withoutDeal = createHarness({ contact: { id: 'contact-1' }, deal: null });
    await expect(
      withoutDeal.service.link(access, ownedCall.id, { version: 1, dealId: 'deal-1' }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'CALL_DEAL_NOT_FOUND' });
    expect(withoutDeal.updateCall).not.toHaveBeenCalled();
  });

  it('soft-deletes under the version guard instead of removing the row', async () => {
    const harness = createHarness({ update: async () => ({ ...ownedCall, version: 2 }) });

    await harness.service.delete(access, ownedCall.id, 1);

    expect(harness.updateCall).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ownedCall.id, version: 1, deletedAt: null, ownerId: access.actorId },
        data: expect.objectContaining({ version: { increment: 1 } }),
      }),
    );
    expect(harness.record).toHaveBeenCalledTimes(1);
    expect(harness.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'call.deleted' }),
    );
  });
});

describe('calls service recordings', () => {
  it('hands out the stored link with a deadline to plan for', async () => {
    const harness = createHarness({ now: () => Date.parse('2026-02-01T10:00:00.000Z') });

    await expect(harness.service.getRecording(access, ownedCall.id)).resolves.toEqual({
      url: ownedCall.recordingUrl,
      expiresAt: new Date('2026-02-01T10:15:00.000Z'),
    });
  });

  it('reports a call nobody recorded as having no recording', async () => {
    const harness = createHarness({ existing: { ...ownedCall, recordingUrl: null } });

    await expect(harness.service.getRecording(access, ownedCall.id)).rejects.toMatchObject({
      statusCode: 404,
      code: 'CALL_RECORDING_UNAVAILABLE',
    } satisfies Partial<AppError>);
  });
});

describe('calls service domain event fan-out', () => {
  it('stays silent when the transaction is rejected', async () => {
    const harness = createHarness({
      update: async () => {
        throw { code: 'P2025' };
      },
    });

    await expect(
      harness.service.update(access, ownedCall.id, { version: 1, notes: 'x' }),
    ).rejects.toBeInstanceOf(AppError);
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('keeps the business result when the secondary consumers fail', async () => {
    const harness = createHarness({ contact: { id: 'contact-1' } });
    harness.publish.mockImplementation(() => {
      throw new Error('event stream unreachable');
    });

    // The publisher owns its own failures; a broken stream must never turn a
    // committed link into a failed request.
    await expect(
      harness.service.link(access, ownedCall.id, { version: 1, contactId: 'contact-1' }),
    ).resolves.toMatchObject({ id: ownedCall.id, contactId: 'contact-1' });
  });
});
