import { AppError } from '../../common/errors/index.js';
import { fromMinorUnits, normalizeMoney } from '../../common/money/index.js';
import { filter } from '../../common/query/filter-builder.js';
import { createListReader } from '../../common/query/list-reader.js';
import {
  noopDomainEventPublisher,
  type DomainEventNotification,
  type DomainEventPublisher,
} from '../../common/types/domain-event-publisher.js';
import type { Prisma, PrismaDatabase, PrismaTransaction } from '../../db/prisma.js';
import type { AuditService } from '../audit/service.js';
import type { OrderStatus } from '../orders/types.js';
import { DEFAULT_KYIV_WINDOW_FROM, defaultKyivWindowTo } from '../analytics/kyiv-time.js';
import {
  MATCHABLE_ORDER_STATUSES,
  amountsAgree,
  candidatePlacementWindow,
  isReconcilableDirection,
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
  readonly status: OrderStatus;
  readonly currency: string;
  readonly total: DecimalLike;
  readonly contactId: string | null;
  readonly placedAt: Date | null;
  readonly contact: {
    readonly firstName: string;
    readonly lastName: string;
    readonly company: string | null;
  } | null;
}

/** The order a person names by hand, with the payment that already settles it, if any. */
interface ManualMatchOrderRecord extends CandidateOrderRecord {
  readonly bankTransaction?: { readonly id: string } | null;
}

/**
 * What one import wrote: the counts the caller sees, and the change the trail
 * and the stream are told about — `null` when the pull filed nothing new.
 */
interface StoredStatement {
  readonly result: StatementImportResult;
  readonly changes: { readonly after: Record<string, unknown> } | null;
}

/** A matched transaction's two snapshots, as the trail and the stream carry them. */
interface MatchChange {
  readonly before: BankTransactionDto;
  readonly after: BankTransactionDto;
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
  matchedAt: true,
  matchedById: true,
  autoMatchDisabled: true,
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
  placedAt: true,
  contact: { select: { firstName: true, lastName: true, company: true } },
};

/**
 * What a manual match reads about the order it names: what a candidate
 * carries, and whether some payment already settles it.
 */
const manualMatchOrderSelection = {
  ...candidateOrderSelection,
  bankTransaction: { select: { id: true } },
};

/**
 * Amounts leave as Prisma renders them — shortest exact, so `1800.00` is sent
 * as `1800` and `12.50` as `12.5`. That is what every other monetary field in
 * this API already does, and a scale invented for this one module would put
 * `finance` at odds with `orders` on the same screen.
 *
 * Normalisation still happens, but inwards: the rule compares minor units, and
 * `toMinorUnits` reads either spelling.
 */
/*
 * Both mappers name every field in order rather than spreading the record and
 * patching the money on top. Spreading looks tidier and is wrong here: a
 * patched key moves to the end of the object, so `amount` left in a different
 * place in the JSON than the sibling backend puts it. Two builds that agree on
 * every value and disagree on the order of the keys are two builds a
 * transcript diff reports as different, which is exactly what it is for.
 */
const toStatementDto = (statement: BankStatementRecord): BankStatementDto => ({
  id: statement.id,
  externalId: statement.externalId,
  accountLabel: statement.accountLabel,
  periodStart: statement.periodStart,
  periodEnd: statement.periodEnd,
  openingBalance: statement.openingBalance.toString(),
  closingBalance: statement.closingBalance.toString(),
  currency: statement.currency,
  importedAt: statement.importedAt,
  importedById: statement.importedById,
  createdAt: statement.createdAt,
  updatedAt: statement.updatedAt,
});

const toTransactionDto = (transaction: BankTransactionRecord): BankTransactionDto => ({
  id: transaction.id,
  statementId: transaction.statementId,
  externalId: transaction.externalId,
  bookedAt: transaction.bookedAt,
  amount: transaction.amount.toString(),
  currency: transaction.currency,
  direction: transaction.direction,
  counterpartyName: transaction.counterpartyName,
  counterpartyAccount: transaction.counterpartyAccount,
  reference: transaction.reference,
  matchStatus: transaction.matchStatus,
  matchedOrderId: transaction.matchedOrderId,
  matchedAt: transaction.matchedAt,
  matchedById: transaction.matchedById,
  autoMatchDisabled: transaction.autoMatchDisabled,
  version: transaction.version,
  createdAt: transaction.createdAt,
  updatedAt: transaction.updatedAt,
});

/**
 * The booking window of a ledger page, half-open: `[bookedFrom, bookedTo)`.
 *
 * The shared range filter closes both ends, which is right for an amount and
 * wrong for an instant. Every other window in this API excludes its end, so
 * two adjacent periods never both claim the line booked on their boundary;
 * a ledger filtered by the same two bounds as the summary has to see the same
 * lines the summary counted.
 */
const bookedWithin = (
  bookedFrom: string | undefined,
  bookedTo: string | undefined,
): Prisma.BankTransactionWhereInput => {
  if (bookedFrom === undefined && bookedTo === undefined) return {};
  return {
    bookedAt: {
      ...(bookedFrom !== undefined ? { gte: new Date(bookedFrom) } : {}),
      ...(bookedTo !== undefined ? { lt: new Date(bookedTo) } : {}),
    },
  };
};

/**
 * Upper bound on one reconciliation run. A deployment constant rather than a
 * client parameter: the work is bounded by what this system can absorb inside
 * one request, not by what a caller would like.
 */
export const RECONCILE_BATCH_SIZE = 200;

const contactNameOf = (order: CandidateOrderRecord): string | null =>
  order.contact === null ? null : `${order.contact.firstName} ${order.contact.lastName}`;

const toCandidateOrder = (order: CandidateOrderRecord): CandidateOrder => ({
  orderId: order.id,
  orderNumber: order.orderNumber,
  status: order.status,
  total: normalizeMoney(order.total.toString()),
  currency: order.currency,
  placedAt: order.placedAt,
  contactName: contactNameOf(order),
  contactCompany: order.contact?.company ?? null,
  dto: {
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    total: order.total.toString(),
    currency: order.currency,
    contactId: order.contactId,
    placedAt: order.placedAt,
  },
});

const isRecordNotFoundError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2025';

const isUniqueConstraintError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';

/**
 * An order is settled by at most one payment. Raised both when the check
 * before the write finds the order taken and when the unique index on
 * `matched_order_id` catches a concurrent request the check could not see.
 */
const orderAlreadyMatched = (orderId: string): AppError =>
  new AppError('The order is already settled by another payment', 409, 'ORDER_ALREADY_MATCHED', {
    orderId,
  });

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

/**
 * A summed amount in whole minor units, of any size.
 *
 * Deliberately not `toMinorUnits`: that one guards what a single amount may be
 * — twelve digits, the width of the column — and a sum over a window is not a
 * single amount. A ledger that books a few hundred large lines in a year adds
 * up past twelve digits, and a report that refused to total it would fail for
 * exactly the customers with the most money in it.
 */
const SUMMED_AMOUNT = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

const sumOf = (value: DecimalLike | null | undefined): bigint => {
  if (value === null || value === undefined) return 0n;
  const text = value.toString().trim();
  const match = SUMMED_AMOUNT.exec(text);
  if (!match) throw new Error(`Unexpected summed amount: ${text}`);
  const [, sign, whole = '0', fraction = ''] = match;
  const units = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return sign === '-' ? -units : units;
};

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

  const resolveSummaryWindow = (
    query: FinanceSummaryQuery,
  ): { readonly from: string; readonly to: string } => ({
    from: query.from ?? DEFAULT_KYIV_WINDOW_FROM,
    to: query.to ?? defaultKyivWindowTo(),
  });

  const loadCandidateOrders = async (
    store: CandidateOrderStore,
    bookedAt: readonly Date[],
  ): Promise<readonly CandidateOrder[]> => {
    // A candidate must have been placed no later than the payment and no
    // earlier than the window before it, so the whole batch needs only the
    // orders inside one bounded span rather than the whole table.
    const window = candidatePlacementWindow(bookedAt);
    if (!window) return [];
    const orders = await store.findMany({
      where: {
        deletedAt: null,
        status: { in: [...MATCHABLE_ORDER_STATUSES] },
        placedAt: { gte: window.from, lte: window.to },
        // An order is settled by at most one payment: one that already has
        // its payment is neither offered nor matched again.
        bankTransaction: { is: null },
      },
      select: candidateOrderSelection,
      orderBy: [{ placedAt: 'asc' }, { id: 'asc' }],
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
  ): Promise<StoredStatement> =>
    db.$transaction(async (transaction) => {
      const existing = await transaction.bankStatement.findFirst({
        where: { externalId: payload.externalId },
        select: statementSelection,
      });
      const created = existing === null;
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

      // A bank that repeats a line within one document is repeating itself:
      // the first mention is filed and the rest are skipped. The first rather
      // than the last, so the outcome never depends on the order of a list
      // nobody promised to order — and a repeat is never sent to the database
      // twice, where the second insert would fail the whole statement.
      const unique = new Map<string, BankProviderStatement['transactions'][number]>();
      for (const row of payload.transactions) {
        if (!unique.has(row.externalId)) unique.set(row.externalId, row);
      }
      const known = await transaction.bankTransaction.findMany({
        where: { externalId: { in: [...unique.keys()] } },
        select: { externalId: true },
      });
      const seen = new Set(known.map((row) => row.externalId));
      const fresh = [...unique.values()].filter((row) => !seen.has(row.externalId));

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
      // A pull that found everything already on file changed nothing, and an
      // entry claiming it did would make the trail of a quiet ledger read like
      // a busy one. Only a new statement or a new line is recorded.
      if (!created && fresh.length === 0) return { result, changes: null };

      const changes = {
        after: {
          ...toStatementDto(statement),
          imported: result.imported,
          skipped: result.skipped,
        },
      };
      await audit.record(transaction, {
        actorId: access.actorId,
        action: 'statement.imported',
        entityType: 'statement',
        entityId: statement.id,
        changes,
        ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
      });
      return { result, changes };
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
   * rule stays a rule. Returns the two snapshots it recorded, or why it wrote
   * nothing: the row moved under the batch, or a concurrent request settled
   * the order with another payment first. The batch treats both as "not this
   * run" rather than as a fault.
   */
  const applyAutoMatch = async (
    access: FinanceAccess,
    transaction: BankTransactionDto,
    orderId: string,
  ): Promise<MatchChange | 'ROW_MOVED' | 'ORDER_TAKEN'> => {
    try {
      return await db.$transaction(async (tx) => {
        const updated = await tx.bankTransaction.update({
          where: { id: transaction.id, version: transaction.version },
          data: {
            matchStatus: 'MATCHED',
            matchedOrderId: orderId,
            matchedById: access.actorId,
            matchedAt: new Date(),
            autoMatchDisabled: false,
            version: { increment: 1 },
          },
          select: transactionSelection,
        });
        const change: MatchChange = { before: transaction, after: toTransactionDto(updated) };
        await audit.record(tx, {
          actorId: access.actorId,
          action: 'transaction.matched',
          entityType: 'transaction',
          entityId: transaction.id,
          changes: change,
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
        return change;
      });
    } catch (error) {
      // A transaction somebody edited while the batch was thinking is left
      // alone and picked up by the next run; one moving row must not abandon
      // the rest of the statement.
      if (isRecordNotFoundError(error)) return 'ROW_MOVED';
      // The order was settled by another payment after the batch read the
      // order book; the unique index on `matched_order_id` refused the second.
      if (isUniqueConstraintError(error)) return 'ORDER_TAKEN';
      throw error;
    }
  };

  /**
   * Files a conclusion that is not a match — a new status and nothing else.
   * Returns false when the row moved under the batch, for the same reason
   * `applyAutoMatch` does.
   */
  const applyStatus = async (
    transaction: BankTransactionDto,
    matchStatus: PaymentMatchStatus,
  ): Promise<boolean> => {
    try {
      await db.bankTransaction.update({
        where: { id: transaction.id, version: transaction.version },
        data: { matchStatus, version: { increment: 1 } },
        select: { id: true },
      });
      return true;
    } catch (error) {
      if (isRecordNotFoundError(error)) return false;
      throw error;
    }
  };

  return {
    async listStatements(_access, query) {
      // Case-insensitive throughout, the identifier included: a person reading
      // a bank's id off a printout types it in whatever case they like, and a
      // search that agreed only with the exact spelling would answer "nothing"
      // about a statement that is right there.
      const where = filter<Prisma.BankStatementWhereInput>({})
        .search(query.search, ['accountLabel', 'externalId'])
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
      let stored: StoredStatement;
      try {
        stored = await storeStatement(access, payload);
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

      const { result, changes } = stored;
      // The stream hears exactly what the trail recorded, and nothing when
      // the trail recorded nothing.
      if (changes !== null) {
        announce({
          eventType: 'statement.imported',
          entityType: 'statement',
          entityId: result.statementId,
          actorId: access.actorId,
          payload: changes,
        });
      }

      return result;
    },

    async listTransactions(_access, query) {
      const where = filter<Prisma.BankTransactionWhereInput>({})
        .equals('statementId', query.statementId)
        .equals('matchStatus', query.matchStatus)
        .equals('direction', query.direction)
        // What the payer wrote, who they said they were and the account they
        // paid from — the three things a ledger is searched by when hunting a
        // payment, all without regard to case.
        .search(query.search, ['reference', 'counterpartyName', 'counterpartyAccount'])
        .extend(bookedWithin(query.bookedFrom, query.bookedTo))
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
        // Only money coming in can settle an order. A person may overrule the
        // rule's heuristics, but a payment we made is not a payment we got.
        if (!isReconcilableDirection(existing.direction)) {
          throw new AppError(
            'Only an incoming payment can be matched to an order',
            409,
            'TRANSACTION_NOT_INCOMING',
          );
        }
        const order: ManualMatchOrderRecord | null = await transaction.order.findFirst({
          where: { id: data.orderId, deletedAt: null },
          select: manualMatchOrderSelection,
        });
        if (!order) {
          throw new AppError('Order not found', 404, 'TRANSACTION_ORDER_NOT_FOUND');
        }
        // This transaction is not matched (checked above), so a payment that
        // already settles the order is necessarily another one.
        if (order.bankTransaction) throw orderAlreadyMatched(order.id);
        // Amounts in two currencies cannot settle each other, however close
        // the numbers happen to be, so the currency is compared first.
        if (existing.currency !== order.currency) {
          throw new AppError(
            'The transaction currency does not match the order currency',
            422,
            'CURRENCY_MISMATCH',
            { currency: existing.currency, orderCurrency: order.currency },
          );
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
              // A person matching by hand has made the decision the flag was
              // protecting; the automatic rule may look at the row again.
              autoMatchDisabled: false,
              version: { increment: 1 },
            },
            select: transactionSelection,
          });
        } catch (error) {
          if (isRecordNotFoundError(error)) throw concurrentModification();
          // Another request settled the order between the check above and
          // this write; the unique index is what saw it.
          if (isUniqueConstraintError(error)) throw orderAlreadyMatched(data.orderId);
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
              // A person took the match back; the next automatic run must not
              // quietly put it back. Only another manual match clears this.
              autoMatchDisabled: true,
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
      // person saying "leave this alone"; neither is reconsidered. Nor is a
      // line a person took a match back from: that was a decision too, and a
      // batch that quietly re-made the match would overrule it. Outgoing
      // lines are read in with the rest: they cannot be matched, but they can
      // be filed, and filing them is what makes IGNORED reachable at all.
      const pending = await db.bankTransaction.findMany({
        where: { matchStatus: { in: ['UNMATCHED', 'SUGGESTED'] }, autoMatchDisabled: false },
        select: transactionSelection,
        orderBy: [{ bookedAt: 'asc' }, { id: 'asc' }],
        take: RECONCILE_BATCH_SIZE,
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
      // Orders this run has already settled. The order book was read once,
      // before the first write, so without this a second payment for the same
      // sum would be matched to the very order the first one just closed.
      const settled = new Set<string>();

      // The tally counts what was filed, not what was concluded. A row that a
      // person moved while the batch was thinking keeps whatever they made of
      // it, so it is examined but lands in none of the four outcomes: a
      // report saying "matched: 2" over one write would be claiming a
      // settlement the ledger does not hold.
      for (const transaction of transactions) {
        const open = orders.filter((order) => !settled.has(order.orderId));
        const outcome = isReconcilableDirection(transaction.direction)
          ? matchOutcomeFor(findMatchCandidates(transaction, open))
          : ({ matchStatus: 'IGNORED', matchedOrderId: null } as const);
        if (outcome.matchStatus === 'MATCHED' && outcome.matchedOrderId !== null) {
          const result = await applyAutoMatch(access, transaction, outcome.matchedOrderId);
          if (result === 'ROW_MOVED') continue;
          settled.add(outcome.matchedOrderId);
          if (result === 'ORDER_TAKEN') continue;
          tally.MATCHED += 1;
          // Each match is its own committed transaction, so it is announced
          // as soon as that commit is behind it — not at the end of the loop,
          // where a later row failing would leave committed matches unheard.
          // The same two snapshots a manual match announces, so a consumer of
          // the stream cannot tell — and need not care — which of the two
          // decided.
          announce({
            eventType: 'transaction.matched',
            entityType: 'transaction',
            entityId: result.after.id,
            actorId: access.actorId,
            payload: result,
          });
          continue;
        }
        const filed =
          transaction.matchStatus === outcome.matchStatus ||
          (await applyStatus(transaction, outcome.matchStatus));
        if (filed) tally[outcome.matchStatus] += 1;
      }

      return {
        examined: transactions.length,
        matched: tally.MATCHED,
        suggested: tally.SUGGESTED,
        unmatched: tally.UNMATCHED,
        ignored: tally.IGNORED,
      };
    },

    async summary(_access, query) {
      const window = await resolveSummaryWindow(query);
      const where: Prisma.BankTransactionWhereInput = {
        bookedAt: { gte: new Date(window.from), lt: new Date(window.to) },
      };
      // One grouped query rather than one per figure: the same rows answer
      // every number below, and two reads — even issued together — can each
      // see a different moment of a ledger that an import is writing to, so
      // the totals by direction and the totals by state would stop adding up.
      const groups = await db.bankTransaction.groupBy({
        by: ['direction', 'matchStatus'],
        where,
        _count: { _all: true },
        _sum: { amount: true },
      });

      let inflow = 0n;
      let outflow = 0n;
      let transactionCount = 0;
      const counted = new Map<PaymentMatchStatus, { count: number; amount: bigint }>();
      for (const group of groups) {
        const count = toCount(group._count._all);
        const amount = sumOf(group._sum.amount);
        if (group.direction === 'CREDIT') inflow += amount;
        else outflow += amount;
        transactionCount += count;
        const status = group.matchStatus as PaymentMatchStatus;
        const entry = counted.get(status) ?? { count: 0, amount: 0n };
        counted.set(status, { count: entry.count + count, amount: entry.amount + amount });
      }
      // Every status is reported, including the ones with nothing in them: a
      // client rendering shares must not have to guess whether a missing
      // bucket is zero or unknown.
      const rows: FinanceSummaryStatusRow[] = paymentMatchStatuses.map((matchStatus) => {
        const entry = counted.get(matchStatus);
        const count = entry?.count ?? 0;
        return {
          status: matchStatus,
          count,
          amount: fromMinorUnits(entry?.amount ?? 0n),
          share: share(count, transactionCount),
        };
      });

      return {
        from: window.from,
        to: window.to,
        transactionCount,
        inflow: fromMinorUnits(inflow),
        outflow: fromMinorUnits(outflow),
        net: fromMinorUnits(inflow - outflow),
        statuses: rows,
      };
    },
  };
};
