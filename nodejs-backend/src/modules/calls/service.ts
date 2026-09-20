import { AppError } from '../../common/errors/index.js';
import { filter } from '../../common/query/filter-builder.js';
import { createListReader } from '../../common/query/list-reader.js';
import {
  noopDomainEventPublisher,
  type DomainEventNotification,
  type DomainEventPublisher,
} from '../../common/types/domain-event-publisher.js';
import type { Prisma, PrismaDatabase, PrismaTransaction } from '../../db/prisma.js';
import type { AuditService } from '../audit/service.js';
import { DEFAULT_CALL_SYNC_BATCH_SIZE } from './provider-factory.js';
import type { CallProvider, CallProviderRecord } from './provider.js';
import type {
  CallAccess,
  CallDto,
  CallListQuery,
  CallListResult,
  CallRecordingDto,
  CallSyncResult,
  LinkCallData,
  UpdateCallData,
} from './types.js';

interface CallRecord extends CallDto {
  readonly deletedAt: Date | null;
}

type CallsTransaction = Pick<PrismaTransaction, 'auditLog' | 'call' | 'contact' | 'deal'>;
export type CallsDatabase = Pick<PrismaDatabase, '$transaction' | 'call'>;

export interface CallsService {
  list(access: CallAccess, query: CallListQuery): Promise<CallListResult>;
  getById(access: CallAccess, id: string): Promise<CallDto>;
  sync(access: CallAccess): Promise<CallSyncResult>;
  update(access: CallAccess, id: string, data: UpdateCallData): Promise<CallDto>;
  link(access: CallAccess, id: string, data: LinkCallData): Promise<CallDto>;
  getRecording(access: CallAccess, id: string): Promise<CallRecordingDto>;
  delete(access: CallAccess, id: string, version: number): Promise<void>;
}

const callSelection = {
  id: true,
  externalId: true,
  direction: true,
  disposition: true,
  fromNumber: true,
  toNumber: true,
  startedAt: true,
  durationSeconds: true,
  contactId: true,
  dealId: true,
  ownerId: true,
  recordingUrl: true,
  notes: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
};

const toDto = ({ deletedAt: _deletedAt, ...call }: CallRecord): CallDto => call;

const toDate = (value: string): Date => new Date(value);

/**
 * How long the link handed out for a recording is presented as valid. The
 * provider's own link is stored as it arrived; this window is what the caller
 * is told to plan for, so the UI can decide when to ask again instead of
 * holding a URL forever.
 */
export const CALL_RECORDING_URL_TTL_SECONDS = 15 * 60;

const isRecordNotFoundError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2025';

const isUniqueConstraintError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';

const concurrentModification = (): AppError =>
  new AppError('Call was modified by another request', 409, 'CALL_CONCURRENT_MODIFICATION');

const assertCurrentVersion = (actual: number, expected: number): void => {
  if (actual !== expected) throw concurrentModification();
};

/**
 * A call with no owner is nobody's, and nobody's is not mine: under the
 * narrowed scope such a call is neither visible nor claimable, exactly as a
 * colleague's call is not. The same rule decides handovers — under `OWN` the
 * owner after the write must still be the actor, so both giving a call to
 * someone else and dropping it to nobody are refused.
 *
 * The alternative reading — "`OWN` also sees the unowned" — was rejected on
 * purpose: it would make every freshly imported call public to every narrowed
 * account, which is the opposite of what narrowing is for.
 */
const ensureOwnerAccess = (access: CallAccess, ownerId: string | null): void => {
  if (access.scope === 'OWN' && ownerId !== access.actorId) {
    throw new AppError('Forbidden', 403, 'FORBIDDEN');
  }
};

const findActive = async (
  store: CallsTransaction['call'],
  access: CallAccess,
  id: string,
): Promise<CallRecord> => {
  const call = await store.findFirst({
    where: { id, deletedAt: null, ...(access.scope === 'OWN' ? { ownerId: access.actorId } : {}) },
    select: callSelection,
  });
  if (!call) throw new AppError('Call not found', 404, 'CALL_NOT_FOUND');
  return call;
};

const assertContactAccess = async (
  transaction: CallsTransaction,
  access: CallAccess,
  contactId: string | null | undefined,
): Promise<void> => {
  if (!contactId) return;
  const contact = await transaction.contact.findFirst({
    where: {
      id: contactId,
      deletedAt: null,
      ...(access.scope === 'OWN' ? { ownerId: access.actorId } : {}),
    },
    select: { id: true },
  });
  if (!contact) throw new AppError('Contact not found', 404, 'CALL_CONTACT_NOT_FOUND');
};

const assertDealAccess = async (
  transaction: CallsTransaction,
  access: CallAccess,
  dealId: string | null | undefined,
): Promise<void> => {
  if (!dealId) return;
  const deal = await transaction.deal.findFirst({
    where: {
      id: dealId,
      deletedAt: null,
      ...(access.scope === 'OWN' ? { ownerId: access.actorId } : {}),
    },
    select: { id: true },
  });
  if (!deal) throw new AppError('Deal not found', 404, 'CALL_DEAL_NOT_FOUND');
};

export interface CallsServiceOptions {
  /** Upper bound on how many records one sync run may take. */
  readonly syncBatchSize?: number | undefined;
  /** Injectable clock keeps recording expiry deterministic in tests. */
  readonly now?: (() => number) | undefined;
}

export const createCallsService = (
  db: CallsDatabase,
  audit: AuditService,
  provider: CallProvider,
  // Secondary consumers (event stream, realtime channel) are notified only once
  // the transaction has committed, so they can never affect its outcome.
  events: DomainEventPublisher = noopDomainEventPublisher,
  { syncBatchSize = DEFAULT_CALL_SYNC_BATCH_SIZE, now = Date.now }: CallsServiceOptions = {},
): CallsService => {
  /**
   * The publisher contract forbids throwing, but the primary path is guarded
   * anyway: a change that is already committed must be reported as a success
   * even if a secondary consumer is misbehaving. Diagnostics are the
   * publisher's responsibility, which is why nothing is logged here.
   */
  const announce = (event: DomainEventNotification): void => {
    try {
      events.publish(event);
    } catch {
      // Intentionally ignored; see above.
    }
  };

  const readPage = createListReader({ model: db.call, select: callSelection, toDto });

  /**
   * Imports one fetched record, or reports that it was already known.
   *
   * Each record gets its own transaction on purpose. A unique violation aborts
   * the surrounding Postgres transaction, so a batch imported inside a single
   * transaction could not both skip a duplicate and keep the records around
   * it — one call that arrived in an earlier run would undo the whole import.
   * The unique index on `externalId` is what makes a repeated sync harmless,
   * and this is the shape that lets it do its job.
   */
  const importRecord = async (
    access: CallAccess,
    record: CallProviderRecord,
  ): Promise<CallDto | null> => {
    try {
      return await db.$transaction(async (transaction) => {
        const call = await transaction.call.create({
          data: {
            externalId: record.externalId,
            direction: record.direction,
            disposition: record.disposition,
            fromNumber: record.fromNumber,
            toNumber: record.toNumber,
            startedAt: new Date(record.startedAt),
            durationSeconds: record.durationSeconds,
            // An imported call belongs to nobody: the switchboard knows the
            // number, not who in the company the conversation was for. An owner
            // appears when a person claims the call, not before.
            ownerId: null,
            contactId: null,
            dealId: null,
            recordingUrl: record.recordingUrl ?? null,
            notes: null,
          },
          select: callSelection,
        });
        const dto = toDto(call);
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'call.created',
          entityType: 'call',
          entityId: call.id,
          changes: { after: dto },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
        return dto;
      });
    } catch (error) {
      // The only unique column on a call is its external id, so a uniqueness
      // violation means precisely "already imported" — which is the normal
      // outcome of a second sync, not a failure.
      if (isUniqueConstraintError(error)) return null;
      throw error;
    }
  };

  return {
    async list(access, query) {
      const ownerId = access.scope === 'OWN' ? access.actorId : query.ownerId;
      const where = filter<Prisma.CallWhereInput>({ deletedAt: null })
        .equals('ownerId', ownerId)
        .equals('contactId', query.contactId)
        .equals('dealId', query.dealId)
        .equals('direction', query.direction)
        .equals('disposition', query.disposition)
        // Numbers are matched literally: a phone number has no case, and an
        // insensitive comparison would only cost an index lookup.
        .search(query.search, [
          { field: 'fromNumber', insensitive: false },
          { field: 'toNumber', insensitive: false },
          'notes',
        ])
        .range('startedAt', query.startedFrom, query.startedTo, toDate)
        .extend(
          query.hasContact === undefined
            ? {}
            : { contactId: query.hasContact ? { not: null } : null },
        )
        .build();
      return readPage({
        where,
        page: query.page,
        pageSize: query.pageSize,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
      });
    },

    async getById(access, id) {
      return toDto(await findActive(db.call, access, id));
    },

    async sync(access) {
      // Anything the provider throws is already one of this module's errors;
      // it reaches the caller as 502 and touches nothing that is stored.
      const fetched = await provider.fetchCalls({ limit: syncBatchSize });

      const created: CallDto[] = [];
      let skipped = 0;
      for (const record of fetched) {
        const call = await importRecord(access, record);
        if (call === null) skipped += 1;
        else created.push(call);
      }

      for (const call of created) {
        announce({
          eventType: 'call.created',
          entityType: 'call',
          entityId: call.id,
          actorId: access.actorId,
          payload: { after: call },
        });
      }

      return { fetched: fetched.length, created: created.length, skipped };
    },

    async update(access, id, data) {
      const result = await db.$transaction(async (transaction) => {
        const existing = await findActive(transaction.call, access, id);
        assertCurrentVersion(existing.version, data.version);
        const ownerId = data.ownerId === undefined ? existing.ownerId : data.ownerId;
        ensureOwnerAccess(access, ownerId);
        await assertContactAccess(transaction, access, data.contactId);
        await assertDealAccess(transaction, access, data.dealId);
        const updateData: Prisma.CallUncheckedUpdateInput = {
          ...(data.ownerId !== undefined ? { ownerId: data.ownerId } : {}),
          ...(data.contactId !== undefined ? { contactId: data.contactId } : {}),
          ...(data.dealId !== undefined ? { dealId: data.dealId } : {}),
          ...(data.notes !== undefined ? { notes: data.notes } : {}),
          version: { increment: 1 },
        };
        let updated: CallRecord;
        try {
          updated = await transaction.call.update({
            // The previously read version is part of the predicate, so a racing
            // write that already moved the call wins and this one is rejected
            // instead of overwriting it.
            where: {
              id,
              version: data.version,
              deletedAt: null,
              ...(access.scope === 'OWN' ? { ownerId: access.actorId } : {}),
            },
            data: updateData,
            select: callSelection,
          });
        } catch (error) {
          if (isRecordNotFoundError(error)) throw concurrentModification();
          throw error;
        }
        const before = toDto(existing);
        const after = toDto(updated);
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'call.updated',
          entityType: 'call',
          entityId: id,
          changes: { before, after },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
        return { before, after };
      });

      announce({
        eventType: 'call.updated',
        entityType: 'call',
        entityId: id,
        actorId: access.actorId,
        payload: result,
      });

      return result.after;
    },

    async link(access, id, data) {
      const result = await db.$transaction(async (transaction) => {
        const existing = await findActive(transaction.call, access, id);
        assertCurrentVersion(existing.version, data.version);
        await assertContactAccess(transaction, access, data.contactId);
        await assertDealAccess(transaction, access, data.dealId);
        let linked: CallRecord;
        try {
          linked = await transaction.call.update({
            where: {
              id,
              version: data.version,
              deletedAt: null,
              ...(access.scope === 'OWN' ? { ownerId: access.actorId } : {}),
            },
            data: {
              ...(data.contactId !== undefined ? { contactId: data.contactId } : {}),
              ...(data.dealId !== undefined ? { dealId: data.dealId } : {}),
              version: { increment: 1 },
            },
            select: callSelection,
          });
        } catch (error) {
          if (isRecordNotFoundError(error)) throw concurrentModification();
          throw error;
        }
        const before = toDto(existing);
        const after = toDto(linked);
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'call.linked',
          entityType: 'call',
          entityId: id,
          changes: { before, after },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
        return { before, after };
      });

      announce({
        eventType: 'call.linked',
        entityType: 'call',
        entityId: id,
        actorId: access.actorId,
        payload: result,
      });

      return result.after;
    },

    async getRecording(access, id) {
      const call = await findActive(db.call, access, id);
      // Most calls have no recording — an unanswered one never had anything to
      // record — so the absence is an ordinary answer, not a fault.
      if (call.recordingUrl === null) {
        throw new AppError('This call has no recording', 404, 'CALL_RECORDING_UNAVAILABLE');
      }
      return {
        url: call.recordingUrl,
        expiresAt: new Date(now() + CALL_RECORDING_URL_TTL_SECONDS * 1_000),
      };
    },

    async delete(access, id, version) {
      await db.$transaction(async (transaction) => {
        const existing = await findActive(transaction.call, access, id);
        assertCurrentVersion(existing.version, version);
        const deletedAt = new Date();
        try {
          await transaction.call.update({
            where: {
              id,
              version,
              deletedAt: null,
              ...(access.scope === 'OWN' ? { ownerId: access.actorId } : {}),
            },
            data: { deletedAt, version: { increment: 1 } },
            select: callSelection,
          });
        } catch (error) {
          if (isRecordNotFoundError(error)) throw concurrentModification();
          throw error;
        }
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'call.deleted',
          entityType: 'call',
          entityId: id,
          changes: { before: toDto(existing), after: { deletedAt, version: version + 1 } },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
      });

      announce({
        eventType: 'call.deleted',
        entityType: 'call',
        entityId: id,
        actorId: access.actorId,
        payload: { id },
      });
    },
  };
};
