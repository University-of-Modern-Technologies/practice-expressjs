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
import { assertTicketStatusTransition, resolutionFor } from './transition.js';
import type {
  CreateTicketData,
  TicketAccess,
  TicketDto,
  TicketListQuery,
  TicketListResult,
  TransitionTicketData,
  UpdateTicketData,
} from './types.js';

interface TicketRecord extends TicketDto {
  readonly deletedAt: Date | null;
}

type HelpdeskTransaction = Pick<
  PrismaTransaction,
  'auditLog' | 'contact' | 'ticket' | 'ticketStatusLog' | 'user'
>;
export type HelpdeskDatabase = Pick<PrismaDatabase, '$transaction' | 'ticket'>;

export interface HelpdeskService {
  list(access: TicketAccess, query: TicketListQuery): Promise<TicketListResult>;
  getById(access: TicketAccess, id: string): Promise<TicketDto>;
  create(access: TicketAccess, data: CreateTicketData): Promise<TicketDto>;
  update(access: TicketAccess, id: string, data: UpdateTicketData): Promise<TicketDto>;
  transition(access: TicketAccess, id: string, data: TransitionTicketData): Promise<TicketDto>;
  delete(access: TicketAccess, id: string, version: number): Promise<void>;
}

const ticketSelection = {
  id: true,
  number: true,
  subject: true,
  body: true,
  channel: true,
  status: true,
  priority: true,
  ownerId: true,
  contactId: true,
  assigneeId: true,
  version: true,
  openedAt: true,
  resolvedAt: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
};

const toDto = ({ deletedAt: _deletedAt, ...ticket }: TicketRecord): TicketDto => ticket;

const toDate = (value: string): Date => new Date(value);

/** How many numbers are drawn before a collision is reported to the caller. */
const TICKET_NUMBER_ATTEMPTS = 5;

/**
 * Eight random digits behind a fixed prefix. A running counter would read
 * better but needs a row every writer has to serialize on, and the number is
 * a label people quote on the phone, not an ordering key — so uniqueness is
 * left to the unique index and a collision is simply redrawn.
 */
const generateTicketNumber = (): string => {
  const digits = Math.floor(Math.random() * 100_000_000)
    .toString()
    .padStart(8, '0');
  return `TKT-${digits}`;
};

const isRecordNotFoundError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2025';

const isUniqueConstraintError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';

const conflictingFields = (error: unknown): readonly string[] => {
  const target = (error as { meta?: { target?: unknown } } | null)?.meta?.target;
  if (Array.isArray(target)) return target.map(String);
  return typeof target === 'string' ? [target] : [];
};

/**
 * The generated number is the only unique column on a ticket, so any
 * uniqueness violation here is a collision worth retrying.
 */
const isTicketNumberConflict = (error: unknown): boolean => {
  if (!isUniqueConstraintError(error)) return false;
  const fields = conflictingFields(error);
  return fields.length === 0 || fields.some((field) => /number/i.test(field));
};

const concurrentModification = (): AppError =>
  new AppError('Ticket was modified by another request', 409, 'TICKET_CONCURRENT_MODIFICATION');

const assertCurrentVersion = (actual: number, expected: number): void => {
  if (actual !== expected) throw concurrentModification();
};

const ensureOwnerAccess = (access: TicketAccess, ownerId: string): void => {
  if (access.scope === 'OWN' && ownerId !== access.actorId) {
    throw new AppError('Forbidden', 403, 'FORBIDDEN');
  }
};

const findActive = async (
  store: HelpdeskTransaction['ticket'],
  access: TicketAccess,
  id: string,
): Promise<TicketRecord> => {
  const ticket = await store.findFirst({
    where: { id, deletedAt: null, ...(access.scope === 'OWN' ? { ownerId: access.actorId } : {}) },
    select: ticketSelection,
  });
  if (!ticket) throw new AppError('Ticket not found', 404, 'TICKET_NOT_FOUND');
  return ticket;
};

const assertContactAccess = async (
  transaction: HelpdeskTransaction,
  access: TicketAccess,
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
  if (!contact) throw new AppError('Contact not found', 404, 'TICKET_CONTACT_NOT_FOUND');
};

/**
 * An assignee is a colleague, not a record the caller owns, so the narrowed
 * scope does not apply here — only an active account is required.
 */
const assertAssigneeExists = async (
  transaction: HelpdeskTransaction,
  assigneeId: string | null | undefined,
): Promise<void> => {
  if (!assigneeId) return;
  const assignee = await transaction.user.findFirst({
    where: { id: assigneeId, isActive: true },
    select: { id: true },
  });
  if (!assignee) throw new AppError('Assignee not found', 404, 'TICKET_ASSIGNEE_NOT_FOUND');
};

export const createHelpdeskService = (
  db: HelpdeskDatabase,
  audit: AuditService,
  // Secondary consumers (event stream, realtime channel) are notified only once
  // the transaction has committed, so they can never affect its outcome.
  events: DomainEventPublisher = noopDomainEventPublisher,
): HelpdeskService => {
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

  /**
   * Retries the whole transaction, not just the insert: a unique violation
   * aborts the surrounding Postgres transaction, so a fresh number has to be
   * drawn in a fresh transaction.
   */
  const withTicketNumber = async <T>(run: (ticketNumber: string) => Promise<T>): Promise<T> => {
    for (let attempt = 1; attempt <= TICKET_NUMBER_ATTEMPTS; attempt += 1) {
      try {
        return await run(generateTicketNumber());
      } catch (error) {
        if (!isTicketNumberConflict(error)) throw error;
        if (attempt === TICKET_NUMBER_ATTEMPTS) {
          throw new AppError('Could not allocate a ticket number', 409, 'TICKET_DUPLICATE_NUMBER');
        }
      }
    }
    /* c8 ignore next */
    throw new AppError('Could not allocate a ticket number', 409, 'TICKET_DUPLICATE_NUMBER');
  };

  const readPage = createListReader({ model: db.ticket, select: ticketSelection, toDto });

  return {
    async list(access, query) {
      const ownerId = access.scope === 'OWN' ? access.actorId : query.ownerId;
      const where = filter<Prisma.TicketWhereInput>({ deletedAt: null })
        .equals('ownerId', ownerId)
        .equals('contactId', query.contactId)
        .equals('assigneeId', query.assigneeId)
        .equals('status', query.status)
        .equals('channel', query.channel)
        .equals('priority', query.priority)
        // The number is quoted back by the person reporting the problem far
        // more often than the subject is, so it is searchable alongside it.
        .search(query.search, ['subject', 'number'])
        .range('openedAt', query.openedFrom, query.openedTo, toDate)
        .build();
      return readPage({
        where,
        page: query.page,
        pageSize: query.pageSize,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
      });
    },

    async getById(access, id) {
      return toDto(await findActive(db.ticket, access, id));
    },

    async create(access, data) {
      const ownerId = data.ownerId ?? access.actorId;
      ensureOwnerAccess(access, ownerId);
      const created = await withTicketNumber((number) =>
        db.$transaction(async (transaction) => {
          await assertContactAccess(transaction, access, data.contactId);
          await assertAssigneeExists(transaction, data.assigneeId);
          const ticket = await transaction.ticket.create({
            data: {
              number,
              subject: data.subject,
              body: data.body,
              channel: data.channel,
              status: 'NEW',
              priority: data.priority ?? 'NORMAL',
              ownerId,
              contactId: data.contactId ?? null,
              assigneeId: data.assigneeId ?? null,
              resolvedAt: null,
            },
            select: ticketSelection,
          });
          // The opening entry closes the journal's gap: without it the first
          // recorded transition would start from a status nothing accounts
          // for, which is exactly what the nullable `fromStatus` is for.
          await transaction.ticketStatusLog.create({
            data: {
              ticketId: ticket.id,
              fromStatus: null,
              toStatus: ticket.status,
              changedById: access.actorId,
              note: null,
            },
            select: { id: true },
          });
          const dto = toDto(ticket);
          await audit.record(transaction, {
            actorId: access.actorId,
            action: 'ticket.created',
            entityType: 'ticket',
            entityId: ticket.id,
            changes: { after: dto },
            ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
          });
          return dto;
        }),
      );

      announce({
        eventType: 'ticket.created',
        entityType: 'ticket',
        entityId: created.id,
        actorId: access.actorId,
        payload: { after: created },
      });

      return created;
    },

    async update(access, id, data) {
      const result = await db.$transaction(async (transaction) => {
        const existing = await findActive(transaction.ticket, access, id);
        assertCurrentVersion(existing.version, data.version);
        const ownerId = data.ownerId ?? existing.ownerId;
        ensureOwnerAccess(access, ownerId);
        await assertContactAccess(transaction, access, data.contactId);
        await assertAssigneeExists(transaction, data.assigneeId);
        const updateData: Prisma.TicketUncheckedUpdateInput = {
          ...(data.ownerId !== undefined ? { ownerId: data.ownerId } : {}),
          ...(data.contactId !== undefined ? { contactId: data.contactId } : {}),
          ...(data.assigneeId !== undefined ? { assigneeId: data.assigneeId } : {}),
          ...(data.subject !== undefined ? { subject: data.subject } : {}),
          ...(data.body !== undefined ? { body: data.body } : {}),
          ...(data.channel !== undefined ? { channel: data.channel } : {}),
          ...(data.priority !== undefined ? { priority: data.priority } : {}),
          version: { increment: 1 },
        };
        let updated: TicketRecord;
        try {
          updated = await transaction.ticket.update({
            // The previously read version *and* status are part of the
            // predicate, so a racing transition that already moved the ticket
            // wins and this write is rejected instead of overwriting it.
            where: {
              id,
              version: data.version,
              status: existing.status,
              deletedAt: null,
              ...(access.scope === 'OWN' ? { ownerId: access.actorId } : {}),
            },
            data: updateData,
            select: ticketSelection,
          });
        } catch (error) {
          if (isRecordNotFoundError(error)) throw concurrentModification();
          throw error;
        }
        const before = toDto(existing);
        const after = toDto(updated);
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'ticket.updated',
          entityType: 'ticket',
          entityId: id,
          changes: { before, after },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
        return { before, after };
      });

      announce({
        eventType: 'ticket.updated',
        entityType: 'ticket',
        entityId: id,
        actorId: access.actorId,
        payload: result,
      });

      return result.after;
    },

    async transition(access, id, data) {
      const result = await db.$transaction(async (transaction) => {
        const existing = await findActive(transaction.ticket, access, id);
        assertCurrentVersion(existing.version, data.version);
        assertTicketStatusTransition(existing.status, data.toStatus);
        const resolvedAt = resolutionFor(data.toStatus, new Date());
        let transitioned: TicketRecord;
        try {
          transitioned = await transaction.ticket.update({
            where: {
              id,
              version: data.version,
              status: existing.status,
              deletedAt: null,
              ...(access.scope === 'OWN' ? { ownerId: access.actorId } : {}),
            },
            data: {
              status: data.toStatus,
              // Left out of the write entirely when the status has no opinion
              // about it, which is what closing a ticket needs: an absent key
              // keeps whatever the column already held.
              ...(resolvedAt !== undefined ? { resolvedAt } : {}),
              version: { increment: 1 },
            },
            select: ticketSelection,
          });
        } catch (error) {
          if (isRecordNotFoundError(error)) throw concurrentModification();
          throw error;
        }
        // Same transaction as the status change: a journal that can outlive a
        // rolled-back transition is worse than no journal at all.
        await transaction.ticketStatusLog.create({
          data: {
            ticketId: id,
            fromStatus: existing.status,
            toStatus: data.toStatus,
            changedById: access.actorId,
            note: data.note ?? null,
          },
          select: { id: true },
        });
        const before = toDto(existing);
        const after = toDto(transitioned);
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'ticket.status_transitioned',
          entityType: 'ticket',
          entityId: id,
          changes: { before, after },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
        return { before, after };
      });

      announce({
        eventType: 'ticket.status_transitioned',
        entityType: 'ticket',
        entityId: id,
        actorId: access.actorId,
        payload: { from: result.before.status, to: result.after.status, after: result.after },
      });

      return result.after;
    },

    async delete(access, id, version) {
      await db.$transaction(async (transaction) => {
        const existing = await findActive(transaction.ticket, access, id);
        assertCurrentVersion(existing.version, version);
        const deletedAt = new Date();
        try {
          await transaction.ticket.update({
            where: {
              id,
              version,
              deletedAt: null,
              ...(access.scope === 'OWN' ? { ownerId: access.actorId } : {}),
            },
            data: { deletedAt, version: { increment: 1 } },
            select: ticketSelection,
          });
        } catch (error) {
          if (isRecordNotFoundError(error)) throw concurrentModification();
          throw error;
        }
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'ticket.deleted',
          entityType: 'ticket',
          entityId: id,
          changes: { before: toDto(existing), after: { deletedAt, version: version + 1 } },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
      });

      announce({
        eventType: 'ticket.deleted',
        entityType: 'ticket',
        entityId: id,
        actorId: access.actorId,
        payload: { id },
      });
    },
  };
};
