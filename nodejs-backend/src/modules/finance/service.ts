import { AppError } from '../../common/errors/index.js';
import { fromMinorUnits, normalizeMoney, toMinorUnits } from '../../common/money/index.js';
import { filter } from '../../common/query/filter-builder.js';
import { createListReader } from '../../common/query/list-reader.js';
import {
  noopDomainEventPublisher,
  type DomainEventNotification,
  type DomainEventPublisher,
} from '../../common/types/domain-event-publisher.js';
import type { Prisma, PrismaDatabase, PrismaTransaction } from '../../db/prisma.js';
import type { AuditService } from '../audit/service.js';
import {
  MATCHABLE_ORDER_STATUSES,
  amountsAgree,
  candidateCreationWindow,
  findMatchCandidates,
  matchOutcomeFor,
  type MatchableOrder,
} from './matching.js';
import type { BankProvider, BankProviderStatement } from './provider.js';
import type {
  BankStatementDto,
  BankTransactionDetailDto,
  BankTransactionDto,
  FinanceAccess,
  FinanceSummaryQuery,
  FinanceSummaryReport,
  FinanceSummaryStatusRow,
  MatchCandidateDto,
  MatchTransactionData,
  PaymentMatchStatus,
  ReconcileResult,
  StatementImportResult,
  StatementListQuery,
  StatementListResult,
  TransactionListQuery,
  TransactionListResult,
} from './types.js';
import { paymentMatchStatuses } from './types.js';

/**
 * Bank statements and the reconciliation of payments against orders.
 *
 * This is the one module in the system where the data does not agree with
 * itself and that is the normal state: a bank knows amounts and references, a
 * CRM knows orders, and nothing guarantees a correspondence between them. The
 * module's job is therefore not to force an answer but to say clearly which of
 * the three answers it has — this is the order, these might be, or nothing
 * here matches — and to make the third case ordinary rather than a failure.
 *
 * **Scope.** A statement belongs to the company, not to a person: there is no
 * owner column on either table, so there is nothing for a narrowed scope to
 * narrow to. `finance` is consequently granted at `ALL` or not at all, and a
 * role without the permission gets 403 from the controller before any of this
 * is reached. The narrowing seen in `contacts` and `calls` has no counterpart
 * here, and inventing one — "transactions matched to my orders" — would answer
 * a question nobody asked.
 */

/** A `Decimal` column as it arrives from Prisma. */
type DecimalLike = { toString(): string } | string | number;

interface BankStatementRecord extends Omit<BankStatementDto, 'openingBalance' | 'closingBalance'> {
  readonly openingBalance: DecimalLike;
  readonly closingBalance: DecimalLike;
}

interface BankTransactionRecord extends Omit<BankTransactionDto, 'amount'> {
  readonly amount: DecimalLike;
}

interface CandidateOrderRecord {
  readonly id: string;
  readonly orderNumber: string;
  readonly status: string;
  readonly currency: string;
  readonly total: DecimalLike;
  readonly contactId: string | null;
  readonly createdAt: Date;
  readonly contact: { readonly firstName: string; readonly lastName: string } | null;
}

/** An order carried through the rule together with the shape the API returns. */
interface CandidateOrder extends MatchableOrder {
  readonly dto: MatchCandidateDto;
}

/**
 * The slice of the order delegate this module reads. Declared structurally,
 * the way the shared list reader declares its model, so the reconciliation
 * path can be exercised without a database and so that `finance` never reaches
 * into the orders module for anything but data it is allowed to see.
 */
interface CandidateOrderStore {
  findMany(args: {
    where: Prisma.OrderWhereInput;
    select: typeof candidateOrderSelection;
    orderBy: Prisma.OrderOrderByWithRelationInput[];
  }): Promise<CandidateOrderRecord[]>;
  findFirst(args: {
    where: Prisma.OrderWhereInput;
    select: typeof candidateOrderSelection;
  }): Promise<CandidateOrderRecord | null>;
}

type FinanceTransaction = Pick<
  PrismaTransaction,
  'auditLog' | 'bankStatement' | 'bankTransaction' | 'order'
>;
export type FinanceDatabase = Pick<
  PrismaDatabase,
  '$transaction' | 'bankStatement' | 'bankTransaction' | 'order'
>;

export interface FinanceService {
  listStatements(access: FinanceAccess, query: StatementListQuery): Promise<StatementListResult>;
  importStatement(access: FinanceAccess): Promise<StatementImportResult>;
  listTransactions(
    access: FinanceAccess,
    query: TransactionListQuery,
  ): Promise<TransactionListResult>;
  getTransactionById(access: FinanceAccess, id: string): Promise<BankTransactionDetailDto>;
  match(access: FinanceAccess, id: string, data: MatchTransactionData): Promise<BankTransactionDto>;
  unmatch(access: FinanceAccess, id: string, version: number): Promise<BankTransactionDto>;
  reconcile(access: FinanceAccess): Promise<ReconcileResult>;
  summary(access: FinanceAccess, query: FinanceSummaryQuery): Promise<FinanceSummaryReport>;
}

const statementSelection = {
  id: true,
  externalId: true,
  accountLabel: true,
  periodStart: true,
  periodEnd: true,
  openingBalance: true,
  closingBalance: true,
  currency: true,
  importedById: true,
  importedAt: true,
  createdAt: true,
  updatedAt: true,
};

const transactionSelection = {
  id: true,
  statementId: true,
  externalId: true,
  bookedAt: true,
  amount: true,
  currency: true,
  direction: true,
  counterpartyName: true,
  counterpartyAccount: true,
  reference: true,
  matchStatus: true,
  matchedOrderId: true,
  matchedById: true,
  matchedAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
};

const candidateOrderSelection = {
  id: true,
  orderNumber: true,
  status: true,
  currency: true,
  total: true,
  contactId: true,
  createdAt: true,
  contact: { select: { firstName: true, lastName: true } },
};

/**
 * Prisma renders `Decimal(14, 2)` without trailing zeros, so `1800.00` comes
 * back as `1800`. Every amount is put back into the canonical two-decimal
 * shape on the way out: the wire format is part of the contract, and a client
 * that has to guess the scale is a client that will guess wrong.
 */
const toStatementDto = ({
  openingBalance,
  closingBalance,
  ...statement
}: BankStatementRecord): BankStatementDto => ({
  ...statement,
  openingBalance: normalizeMoney(openingBalance.toString()),
  closingBalance: normalizeMoney(closingBalance.toString()),
});

const toTransactionDto = ({
  amount,
  ...transaction
}: BankTransactionRecord): BankTransactionDto => ({
  ...transaction,
  amount: normalizeMoney(amount.toString()),
});

const toDate = (value: string): Date => new Date(value);

const contactNameOf = (order: CandidateOrderRecord): string | null =>
  order.contact === null ? null : `${order.contact.firstName} ${order.contact.lastName}`;

const toCandidateOrder = (order: CandidateOrderRecord): CandidateOrder => ({
  orderId: order.id,
  orderNumber: order.orderNumber,
  status: order.status,
  total: normalizeMoney(order.total.toString()),
  createdAt: order.createdAt,
  contactName: contactNameOf(order),
  dto: {
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    total: normalizeMoney(order.total.toString()),
    currency: order.currency,
    contactId: order.contactId,
    createdAt: order.createdAt,
  },
});

const isRecordNotFoundError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2025';

const isUniqueConstraintError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';

const concurrentModification = (): AppError =>
  new AppError(
    'Transaction was modified by another request',
    409,
    'TRANSACTION_CONCURRENT_MODIFICATION',
  );

const assertCurrentVersion = (actual: number, expected: number): void => {
  if (actual !== expected) throw concurrentModification();
};

const findTransaction = async (
  store: FinanceTransaction['bankTransaction'],
  id: string,
): Promise<BankTransactionRecord> => {
  const transaction = await store.findFirst({ where: { id }, select: transactionSelection });
  if (!transaction) throw new AppError('Transaction not found', 404, 'TRANSACTION_NOT_FOUND');
  return transaction;
};

/** Counts as reported by Prisma's `_count._all`, which may be absent. */
const toCount = (value: number | undefined): number => (typeof value === 'number' ? value : 0);

/** A share in `[0, 1]`, rounded to four decimals; an empty base yields 0. */
const share = (part: number, whole: number): number =>
  whole <= 0 ? 0 : Math.round((part / whole) * 10_000) / 10_000;

const sumOf = (value: DecimalLike | null | undefined): bigint =>
  value === null || value === undefined ? 0n : toMinorUnits(normalizeMoney(value.toString()));

export const createFinanceService = (
  db: FinanceDatabase,
  audit: AuditService,
  provider: BankProvider,
  // Secondary consumers (event stream, realtime channel) are notified only once
  // the transaction has committed, so they can never affect its outcome.
  events: DomainEventPublisher = noopDomainEventPublisher,
): FinanceService => {
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

  const readStatementPage = createListReader({
    model: db.bankStatement,
    select: statementSelection,
    toDto: toStatementDto,
  });
  const readTransactionPage = createListReader({
    model: db.bankTransaction,
    select: transactionSelection,
    toDto: toTransactionDto,
  });

  const loadCandidateOrders = async (
    store: CandidateOrderStore,
    bookedAt: readonly Date[],
  ): Promise<readonly CandidateOrder[]> => {
    // A candidate must have been created no later than the payment and no
    // earlier than the window before it, so the whole batch needs only the
    // orders inside one bounded span rather than the whole table.
    const window = candidateCreationWindow(bookedAt);
    if (!window) return [];
    const orders = await store.findMany({
      where: {
        deletedAt: null,
        status: { in: [...MATCHABLE_ORDER_STATUSES] },
        createdAt: { gte: window.from, lte: window.to },
      },
      select: candidateOrderSelection,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return orders.map(toCandidateOrder);
  };

  /**
   * Writes one statement and everything on it in a single transaction.
   *
   * The import of a telephony batch gives each record its own transaction,
   * because the records are independent and a duplicate must not undo its
   * neighbours. A statement is the opposite: it is one document, and half of
   * it in the database is worse than none of it. Duplicates are therefore
   * found by reading the external ids that are already stored rather than by
   * letting a unique violation abort the write — which also keeps the audit
   * record in the same transaction as the change it describes.
   */
  const storeStatement = async (
    access: FinanceAccess,
    payload: BankProviderStatement,
  ): Promise<StatementImportResult> =>
    db.$transaction(async (transaction) => {
      const existing = await transaction.bankStatement.findFirst({
        where: { externalId: payload.externalId },
        select: statementSelection,
      });
      const statement =
        existing ??
        (await transaction.bankStatement.create({
          data: {
            externalId: payload.externalId,
            accountLabel: payload.accountLabel,
            periodStart: new Date(payload.periodStart),
            periodEnd: new Date(payload.periodEnd),
            openingBalance: payload.openingBalance,
            closingBalance: payload.closingBalance,
            currency: payload.currency,
            importedById: access.actorId,
          },
          select: statementSelection,
        }));

      const known = await transaction.bankTransaction.findMany({
        where: { externalId: { in: payload.transactions.map((row) => row.externalId) } },
        select: { externalId: true },
      });
      const seen = new Set(known.map((row) => row.externalId));
      const fresh = payload.transactions.filter((row) => !seen.has(row.externalId));

      for (const row of fresh) {
        await transaction.bankTransaction.create({
          data: {
            statementId: statement.id,
            externalId: row.externalId,
            bookedAt: new Date(row.bookedAt),
            amount: row.amount,
            currency: row.currency,
            direction: row.direction,
            counterpartyName: row.counterpartyName,
            counterpartyAccount: row.counterpartyAccount ?? null,
            reference: row.reference,
            // Nothing is reconciled on arrival: a payment is unmatched until
            // somebody, or the rule, says otherwise.
            matchStatus: 'UNMATCHED',
          },
          select: { id: true },
        });
      }

      const result: StatementImportResult = {
        statementId: statement.id,
        imported: fresh.length,
        skipped: payload.transactions.length - fresh.length,
      };
      await audit.record(transaction, {
        actorId: access.actorId,
        action: 'statement.imported',
        entityType: 'statement',
        entityId: statement.id,
        changes: { after: { ...toStatementDto(statement), ...result } },
        ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
      });
      return result;
    });

  /** Recomputes the suggestions for one transaction; nothing is written. */
  const candidatesFor = async (
    transaction: BankTransactionDto,
  ): Promise<readonly MatchCandidateDto[]> => {
    const orders = await loadCandidateOrders(db.order, [transaction.bookedAt]);
    return findMatchCandidates(transaction, orders).map((order) => order.dto);
  };

  /**
   * The write half of one automatic match, kept apart from the rule so the
   * rule stays a rule. Returns false when a concurrent writer got there first,
   * which the batch treats as "not this run" rather than as a fault.
   */
  const applyAutoMatch = async (
    access: FinanceAccess,
    transaction: BankTransactionDto,
    orderId: string,
  ): Promise<boolean> => {
    try {
      await db.$transaction(async (tx) => {
        const updated = await tx.bankTransaction.update({
          where: { id: transaction.id, version: transaction.version },
          data: {
            matchStatus: 'MATCHED',
            matchedOrderId: orderId,
            matchedById: access.actorId,
            matchedAt: new Date(),
            version: { increment: 1 },
          },
          select: transactionSelection,
        });
        await audit.record(tx, {
          actorId: access.actorId,
          action: 'transaction.matched',
          entityType: 'transaction',
          entityId: transaction.id,
          changes: { before: transaction, after: toTransactionDto(updated) },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
      });
      return true;
    } catch (error) {
      // A transaction somebody edited while the batch was thinking is left
      // alone and picked up by the next run; one moving row must not abandon
      // the rest of the statement.
      if (isRecordNotFoundError(error)) return false;
      throw error;
    }
  };

  return {
    async listStatements(_access, query) {
      const where = filter<Prisma.BankStatementWhereInput>({})
        .search(query.search, ['accountLabel', { field: 'externalId', insensitive: false }])
        .build();
      return readStatementPage({
        where,
        page: query.page,
        pageSize: query.pageSize,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
      });
    },

    async importStatement(access) {
      // Anything the provider throws is already one of this module's errors;
      // it reaches the caller as 502 and touches nothing that is stored.
      const payload = await provider.fetchStatement();
      let result: StatementImportResult;
      try {
        result = await storeStatement(access, payload);
      } catch (error) {
        // The external ids already stored were read inside this transaction,
        // so a uniqueness violation can only mean a second import of the same
        // statement running at the same moment. That one loses, and nothing
        // it wrote survives.
        if (isUniqueConstraintError(error)) {
          throw new AppError(
            'This statement has already been imported',
            409,
            'STATEMENT_DUPLICATE_EXTERNAL_ID',
          );
        }
        throw error;
      }

      announce({
        eventType: 'statement.imported',
        entityType: 'statement',
        entityId: result.statementId,
        actorId: access.actorId,
        payload: { after: result },
      });

      return result;
    },

    async listTransactions(_access, query) {
      const where = filter<Prisma.BankTransactionWhereInput>({})
        .equals('statementId', query.statementId)
        .equals('matchStatus', query.matchStatus)
        .equals('direction', query.direction)
        .search(query.search, [
          'reference',
          'counterpartyName',
          { field: 'counterpartyAccount', insensitive: false },
        ])
        .range('bookedAt', query.bookedFrom, query.bookedTo, toDate)
        .range('amount', query.minAmount, query.maxAmount)
        .build();
      return readTransactionPage({
        where,
        page: query.page,
        pageSize: query.pageSize,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
      });
    },

    async getTransactionById(_access, id) {
      const transaction = toTransactionDto(await findTransaction(db.bankTransaction, id));
      // Suggestions are the one thing this module cannot store: the database
      // allows an order reference only on a matched row, which is exactly what
      // keeps "suggested" from quietly hardening into "decided".
      const candidates =
        transaction.matchStatus === 'SUGGESTED' ? await candidatesFor(transaction) : [];
      return { ...transaction, candidates };
    },

    async match(access, id, data) {
      const result = await db.$transaction(async (transaction) => {
        const existing = await findTransaction(transaction.bankTransaction, id);
        assertCurrentVersion(existing.version, data.version);
        if (existing.matchStatus === 'MATCHED') {
          throw new AppError(
            'Transaction is already matched to an order',
            409,
            'TRANSACTION_ALREADY_MATCHED',
          );
        }
        const order = await transaction.order.findFirst({
          where: { id: data.orderId, deletedAt: null },
          select: candidateOrderSelection,
        });
        if (!order) {
          throw new AppError('Order not found', 404, 'TRANSACTION_ORDER_NOT_FOUND');
        }
        const amount = normalizeMoney(existing.amount.toString());
        const total = normalizeMoney(order.total.toString());
        // A person overriding the rule may override the reference, the status
        // and the window — those are heuristics. The amount is not: money that
        // does not add up is the one thing a manual match must not hide.
        if (!amountsAgree(amount, total)) {
          throw new AppError(
            'The transaction amount does not match the order total',
            422,
            'TRANSACTION_AMOUNT_MISMATCH',
            { amount, orderTotal: total },
          );
        }
        const matchedAt = new Date();
        let updated: BankTransactionRecord;
        try {
          updated = await transaction.bankTransaction.update({
            // The previously read version is part of the predicate, so a racing
            // write that already moved the transaction wins and this one is
            // rejected instead of overwriting it.
            where: { id, version: data.version },
            data: {
              matchStatus: 'MATCHED',
              matchedOrderId: data.orderId,
              matchedById: access.actorId,
              matchedAt,
              version: { increment: 1 },
            },
            select: transactionSelection,
          });
        } catch (error) {
          if (isRecordNotFoundError(error)) throw concurrentModification();
          throw error;
        }
        const before = toTransactionDto(existing);
        const after = toTransactionDto(updated);
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'transaction.matched',
          entityType: 'transaction',
          entityId: id,
          changes: { before, after },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
        return { before, after };
      });

      announce({
        eventType: 'transaction.matched',
        entityType: 'transaction',
        entityId: id,
        actorId: access.actorId,
        payload: result,
      });

      return result.after;
    },

    async unmatch(access, id, version) {
      const result = await db.$transaction(async (transaction) => {
        const existing = await findTransaction(transaction.bankTransaction, id);
        assertCurrentVersion(existing.version, version);
        if (existing.matchStatus !== 'MATCHED') {
          throw new AppError(
            'Transaction is not matched to an order',
            409,
            'TRANSACTION_NOT_MATCHED',
          );
        }
        let updated: BankTransactionRecord;
        try {
          updated = await transaction.bankTransaction.update({
            where: { id, version },
            // Undoing a match clears everything the match wrote. Leaving the
            // order behind on an unmatched row is precisely what the database
            // check refuses, and it would be a lie besides.
            data: {
              matchStatus: 'UNMATCHED',
              matchedOrderId: null,
              matchedById: null,
              matchedAt: null,
              version: { increment: 1 },
            },
            select: transactionSelection,
          });
        } catch (error) {
          if (isRecordNotFoundError(error)) throw concurrentModification();
          throw error;
        }
        const before = toTransactionDto(existing);
        const after = toTransactionDto(updated);
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'transaction.unmatched',
          entityType: 'transaction',
          entityId: id,
          changes: { before, after },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
        return { before, after };
      });

      announce({
        eventType: 'transaction.unmatched',
        entityType: 'transaction',
        entityId: id,
        actorId: access.actorId,
        payload: result,
      });

      return result.after;
    },

    async reconcile(access) {
      // Matched transactions are settled and ignored ones were settled by a
      // person saying "leave this alone"; neither is reconsidered.
      const pending = await db.bankTransaction.findMany({
        where: { matchStatus: { in: ['UNMATCHED', 'SUGGESTED'] } },
        select: transactionSelection,
        orderBy: [{ bookedAt: 'asc' }, { id: 'asc' }],
      });
      const transactions = pending.map(toTransactionDto);
      const orders = await loadCandidateOrders(
        db.order,
        transactions.map((row) => row.bookedAt),
      );

      const tally: Record<PaymentMatchStatus, number> = {
        UNMATCHED: 0,
        SUGGESTED: 0,
        MATCHED: 0,
        IGNORED: 0,
      };
      const matched: string[] = [];

      for (const transaction of transactions) {
        const outcome = matchOutcomeFor(findMatchCandidates(transaction, orders));
        tally[outcome.matchStatus] += 1;
        if (outcome.matchStatus === 'MATCHED' && outcome.matchedOrderId !== null) {
          const applied = await applyAutoMatch(access, transaction, outcome.matchedOrderId);
          if (applied) matched.push(transaction.id);
          continue;
        }
        if (transaction.matchStatus !== outcome.matchStatus) {
          await db.bankTransaction
            .update({
              where: { id: transaction.id, version: transaction.version },
              data: { matchStatus: outcome.matchStatus, version: { increment: 1 } },
              select: { id: true },
            })
            .catch((error: unknown) => {
              if (isRecordNotFoundError(error)) return null;
              throw error;
            });
        }
      }

      for (const id of matched) {
        announce({
          eventType: 'transaction.matched',
          entityType: 'transaction',
          entityId: id,
          actorId: access.actorId,
          payload: { after: { id, matchStatus: 'MATCHED' } },
        });
      }

      return {
        examined: transactions.length,
        matched: tally.MATCHED,
        suggested: tally.SUGGESTED,
        unmatched: tally.UNMATCHED,
      };
    },

    async summary(_access, query) {
      const where: Prisma.BankTransactionWhereInput = {
        bookedAt: { gte: new Date(query.from), lt: new Date(query.to) },
      };
      const [byDirection, byStatus] = await Promise.all([
        db.bankTransaction.groupBy({
          by: ['direction'],
          where,
          _count: { _all: true },
          _sum: { amount: true },
        }),
        db.bankTransaction.groupBy({
          by: ['matchStatus'],
          where,
          _count: { _all: true },
          _sum: { amount: true },
        }),
      ]);

      const inflow = byDirection
        .filter((group) => group.direction === 'CREDIT')
        .reduce((total, group) => total + sumOf(group._sum.amount), 0n);
      const outflow = byDirection
        .filter((group) => group.direction === 'DEBIT')
        .reduce((total, group) => total + sumOf(group._sum.amount), 0n);
      const transactionCount = byDirection.reduce(
        (total, group) => total + toCount(group._count._all),
        0,
      );

      const counted = new Map(
        byStatus.map((group) => [
          group.matchStatus as PaymentMatchStatus,
          { count: toCount(group._count._all), amount: sumOf(group._sum.amount) },
        ]),
      );
      // Every status is reported, including the ones with nothing in them: a
      // client rendering shares must not have to guess whether a missing
      // bucket is zero or unknown.
      const rows: FinanceSummaryStatusRow[] = paymentMatchStatuses.map((matchStatus) => {
        const entry = counted.get(matchStatus);
        const count = entry?.count ?? 0;
        return {
          matchStatus,
          count,
          amount: fromMinorUnits(entry?.amount ?? 0n),
          share: share(count, transactionCount),
        };
      });

      return {
        from: query.from,
        to: query.to,
        totals: {
          transactionCount,
          inflow: fromMinorUnits(inflow),
          outflow: fromMinorUnits(outflow),
          net: fromMinorUnits(inflow - outflow),
        },
        byStatus: rows,
      };
    },
  };
};
