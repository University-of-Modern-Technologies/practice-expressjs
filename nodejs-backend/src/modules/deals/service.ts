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
import { assertDealProbability, assertDealStageTransition } from './transition.js';
import type {
  CreateDealData,
  DealAccess,
  DealDto,
  DealListQuery,
  DealListResult,
  DealStage,
  TransitionDealData,
  UpdateDealData,
} from './types.js';

interface DealRecord extends Omit<DealDto, 'amount'> {
  readonly amount: { toString(): string } | string | number;
  readonly deletedAt: Date | null;
}

type DealsTransaction = Pick<PrismaTransaction, 'auditLog' | 'contact' | 'deal'>;
export type DealsDatabase = Pick<PrismaDatabase, '$transaction' | 'deal'>;

export interface DealsService {
  list(access: DealAccess, query: DealListQuery): Promise<DealListResult>;
  getById(access: DealAccess, id: string): Promise<DealDto>;
  create(access: DealAccess, data: CreateDealData): Promise<DealDto>;
  update(access: DealAccess, id: string, data: UpdateDealData): Promise<DealDto>;
  transition(access: DealAccess, id: string, data: TransitionDealData): Promise<DealDto>;
  delete(access: DealAccess, id: string, version: number): Promise<void>;
}

const dealSelection = {
  id: true,
  ownerId: true,
  contactId: true,
  title: true,
  stage: true,
  amount: true,
  currency: true,
  probability: true,
  version: true,
  expectedCloseDate: true,
  closedAt: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
};

const toDto = ({ amount, deletedAt: _deletedAt, ...deal }: DealRecord): DealDto => ({
  ...deal,
  amount: amount.toString(),
});

const toDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

const defaultProbability: Readonly<Record<DealStage, number>> = {
  LEAD: 10,
  QUALIFIED: 25,
  PROPOSAL: 50,
  WON: 100,
  LOST: 0,
};

const assertAmount = (amount: string): void => {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new AppError('Amount must be non-negative', 400, 'INVALID_DEAL_AMOUNT');
  }
};

const assertInitialStage = (stage: DealStage | undefined): void => {
  if (stage !== undefined && stage !== 'LEAD') {
    throw new AppError(
      'Deals must be created in the LEAD stage',
      400,
      'INVALID_INITIAL_DEAL_STAGE',
    );
  }
};

const isRecordNotFoundError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2025';

const concurrentModification = (): AppError =>
  new AppError('Deal was modified by another request', 409, 'DEAL_CONCURRENT_MODIFICATION');

const assertCurrentVersion = (actual: number, expected: number): void => {
  if (actual !== expected) throw concurrentModification();
};

const ensureOwnerAccess = (access: DealAccess, ownerId: string): void => {
  if (access.scope === 'OWN' && ownerId !== access.actorId) {
    throw new AppError('Forbidden', 403, 'FORBIDDEN');
  }
};

const findActive = async (
  store: DealsTransaction['deal'],
  access: DealAccess,
  id: string,
): Promise<DealRecord> => {
  const deal = await store.findFirst({
    where: { id, deletedAt: null, ...(access.scope === 'OWN' ? { ownerId: access.actorId } : {}) },
    select: dealSelection,
  });
  if (!deal) throw new AppError('Deal not found', 404, 'DEAL_NOT_FOUND');
  return deal;
};

const assertContactAccess = async (
  transaction: DealsTransaction,
  access: DealAccess,
  contactId: string | null | undefined,
): Promise<void> => {
  if (!contactId) return;
  const contact = await transaction.contact.findFirst({
    where: {
      id: contactId,
      deletedAt: null,
      ...(access.scope === 'OWN' ? { ownerId: access.actorId } : {}),
    },
    select: { id: true, ownerId: true },
  });
  if (!contact) throw new AppError('Contact not found', 404, 'CONTACT_NOT_FOUND');
};

export const createDealsService = (
  db: DealsDatabase,
  audit: AuditService,
  // Secondary consumers (event stream, realtime channel) are notified only once
  // the transaction has committed, so they can never affect its outcome.
  events: DomainEventPublisher = noopDomainEventPublisher,
): DealsService => {
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

  const readPage = createListReader({ model: db.deal, select: dealSelection, toDto });

  return {
    async list(access, query) {
      const ownerId = access.scope === 'OWN' ? access.actorId : query.ownerId;
      const where = filter<Prisma.DealWhereInput>({ deletedAt: null })
        .equals('ownerId', ownerId)
        .equals('contactId', query.contactId)
        .equals('stage', query.stage)
        .search(query.search, ['title'])
        .range('amount', query.minAmount, query.maxAmount)
        .range('probability', query.minProbability, query.maxProbability)
        .range('expectedCloseDate', query.expectedCloseFrom, query.expectedCloseTo, toDate)
        .build();
      return readPage({
        where,
        page: query.page,
        pageSize: query.pageSize,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
      });
    },

    async getById(access, id) {
      return toDto(await findActive(db.deal, access, id));
    },

    async create(access, data) {
      assertAmount(data.amount);
      assertInitialStage(data.stage);
      const ownerId = data.ownerId ?? access.actorId;
      ensureOwnerAccess(access, ownerId);
      const stage = 'LEAD';
      const probability = data.probability ?? defaultProbability[stage];
      assertDealProbability(stage, probability);
      const created = await db.$transaction(async (transaction) => {
        await assertContactAccess(transaction, access, data.contactId);
        const deal = await transaction.deal.create({
          data: {
            ownerId,
            contactId: data.contactId ?? null,
            title: data.title,
            stage,
            amount: data.amount,
            currency: data.currency ?? 'USD',
            probability,
            expectedCloseDate: data.expectedCloseDate ? toDate(data.expectedCloseDate) : null,
            closedAt: null,
          },
          select: dealSelection,
        });
        const dto = toDto(deal);
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'deal.created',
          entityType: 'deal',
          entityId: deal.id,
          changes: { after: dto },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
        return dto;
      });

      announce({
        eventType: 'deal.created',
        entityType: 'deal',
        entityId: created.id,
        actorId: access.actorId,
        payload: { after: created },
      });

      return created;
    },

    async update(access, id, data) {
      if (data.amount !== undefined) assertAmount(data.amount);
      const result = await db.$transaction(async (transaction) => {
        const existing = await findActive(transaction.deal, access, id);
        assertCurrentVersion(existing.version, data.version);
        const ownerId = data.ownerId ?? existing.ownerId;
        ensureOwnerAccess(access, ownerId);
        await assertContactAccess(transaction, access, data.contactId);
        const probability = data.probability ?? existing.probability;
        assertDealProbability(existing.stage, probability);
        const updateData: Prisma.DealUncheckedUpdateInput = {
          ...(data.ownerId !== undefined ? { ownerId: data.ownerId } : {}),
          ...(data.contactId !== undefined ? { contactId: data.contactId } : {}),
          ...(data.title !== undefined ? { title: data.title } : {}),
          ...(data.amount !== undefined ? { amount: data.amount } : {}),
          ...(data.currency !== undefined ? { currency: data.currency } : {}),
          ...(data.probability !== undefined ? { probability: data.probability } : {}),
          ...(data.expectedCloseDate !== undefined
            ? {
                expectedCloseDate: data.expectedCloseDate ? toDate(data.expectedCloseDate) : null,
              }
            : {}),
          version: { increment: 1 },
        };
        let updated: DealRecord;
        try {
          updated = await transaction.deal.update({
            where: {
              id,
              version: data.version,
              stage: existing.stage,
              deletedAt: null,
              ...(access.scope === 'OWN' ? { ownerId: access.actorId } : {}),
            },
            data: updateData,
            select: dealSelection,
          });
        } catch (error) {
          if (isRecordNotFoundError(error)) throw concurrentModification();
          throw error;
        }
        const before = toDto(existing);
        const after = toDto(updated);
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'deal.updated',
          entityType: 'deal',
          entityId: id,
          changes: { before, after },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
        return { before, after };
      });

      announce({
        eventType: 'deal.updated',
        entityType: 'deal',
        entityId: id,
        actorId: access.actorId,
        payload: result,
      });

      return result.after;
    },

    async transition(access, id, data) {
      const result = await db.$transaction(async (transaction) => {
        const existing = await findActive(transaction.deal, access, id);
        assertCurrentVersion(existing.version, data.version);
        assertDealStageTransition(existing.stage, data.stage);
        const probability =
          data.probability ??
          (data.stage === 'WON' ? 100 : data.stage === 'LOST' ? 0 : existing.probability);
        assertDealProbability(data.stage, probability);
        let transitioned: DealRecord;
        try {
          transitioned = await transaction.deal.update({
            where: {
              id,
              version: data.version,
              stage: existing.stage,
              deletedAt: null,
              ...(access.scope === 'OWN' ? { ownerId: access.actorId } : {}),
            },
            data: {
              stage: data.stage,
              probability,
              closedAt: data.stage === 'WON' || data.stage === 'LOST' ? new Date() : null,
              version: { increment: 1 },
            },
            select: dealSelection,
          });
        } catch (error) {
          if (isRecordNotFoundError(error)) throw concurrentModification();
          throw error;
        }
        const before = toDto(existing);
        const after = toDto(transitioned);
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'deal.stage_transitioned',
          entityType: 'deal',
          entityId: id,
          changes: { before, after },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
        return { before, after };
      });

      announce({
        eventType: 'deal.stage_transitioned',
        entityType: 'deal',
        entityId: id,
        actorId: access.actorId,
        payload: { from: result.before.stage, to: result.after.stage, after: result.after },
      });

      return result.after;
    },

    async delete(access, id, version) {
      await db.$transaction(async (transaction) => {
        const existing = await findActive(transaction.deal, access, id);
        assertCurrentVersion(existing.version, version);
        const deletedAt = new Date();
        try {
          await transaction.deal.update({
            where: {
              id,
              version,
              deletedAt: null,
              ...(access.scope === 'OWN' ? { ownerId: access.actorId } : {}),
            },
            data: { deletedAt, version: { increment: 1 } },
            select: dealSelection,
          });
        } catch (error) {
          if (isRecordNotFoundError(error)) throw concurrentModification();
          throw error;
        }
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'deal.deleted',
          entityType: 'deal',
          entityId: id,
          changes: { before: toDto(existing), after: { deletedAt, version: version + 1 } },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
      });

      announce({
        eventType: 'deal.deleted',
        entityType: 'deal',
        entityId: id,
        actorId: access.actorId,
        payload: { id },
      });
    },
  };
};
