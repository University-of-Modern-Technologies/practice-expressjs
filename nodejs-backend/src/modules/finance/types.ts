import type { PermissionScope } from '../rbac/types.js';

export const transactionDirections = ['CREDIT', 'DEBIT'] as const;
export type TransactionDirection = (typeof transactionDirections)[number];

export const paymentMatchStatuses = ['UNMATCHED', 'SUGGESTED', 'MATCHED', 'IGNORED'] as const;
export type PaymentMatchStatus = (typeof paymentMatchStatuses)[number];

/**
 * A bank statement is a document, not a record somebody in this system
 * authored: it arrives whole, it is never edited, and it carries no owner and
 * no version because nothing here ever rewrites it.
 */
export interface BankStatementDto {
  readonly id: string;
  readonly externalId: string;
  readonly accountLabel: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly openingBalance: string;
  readonly closingBalance: string;
  readonly currency: string;
  readonly importedById: string | null;
  readonly importedAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface BankTransactionDto {
  readonly id: string;
  readonly statementId: string;
  readonly externalId: string;
  readonly bookedAt: Date;
  /** Money crosses this boundary as a decimal string, never as a number. */
  readonly amount: string;
  readonly currency: string;
  readonly direction: TransactionDirection;
  readonly counterpartyName: string;
  readonly counterpartyAccount: string | null;
  /** The payment reference; the main thing reconciliation reads. */
  readonly reference: string;
  readonly matchStatus: PaymentMatchStatus;
  /**
   * Set if and only if `matchStatus` is `MATCHED`. The database holds the same
   * rule as a check constraint, so a logic error here fails loudly instead of
   * leaving a half-matched row behind.
   */
  readonly matchedOrderId: string | null;
  readonly matchedAt: Date | null;
  readonly matchedById: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * One order that a transaction could belong to. A suggestion is not stored —
 * the check constraint allows an order reference only on a matched row — so it
 * is recomputed whenever a single transaction is read.
 */
export interface MatchCandidateDto {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly status: string;
  readonly total: string;
  readonly currency: string;
  readonly contactId: string | null;
  /** The field the rule compared against, so the reader can check the answer. */
  readonly placedAt: Date | null;
}

/**
 * The single-transaction view. `candidates` is empty unless the transaction is
 * `SUGGESTED`: for every other state the question "which order is this?" has
 * either been answered or has no answer worth offering.
 */
export interface BankTransactionDetailDto extends BankTransactionDto {
  readonly candidates: readonly MatchCandidateDto[];
}

export interface FinanceAccess {
  readonly actorId: string;
  readonly scope: PermissionScope;
  readonly ipAddress?: string;
}

/**
 * What one import run did: whether a fresh statement appeared, how many of its
 * transactions became rows, and how many were already known by their external
 * id. `imported + skipped` is the size of the statement the bank handed over.
 */
export interface StatementImportResult {
  readonly statementId: string;
  readonly imported: number;
  readonly skipped: number;
}

/**
 * What one reconciliation pass decided about the transactions it examined.
 *
 * `ignored` counts the outgoing lines. They are examined — that is why
 * `examined` is the size of the batch and not the size of its incoming half —
 * and filing them as ignored is the decision, not an omission: rent and
 * payroll are real movements that no order will ever explain.
 */
export interface ReconcileResult {
  readonly examined: number;
  readonly matched: number;
  readonly suggested: number;
  readonly unmatched: number;
  readonly ignored: number;
}

export interface MatchTransactionData {
  readonly version: number;
  readonly orderId: string;
}

export const statementSortFields = ['periodStart', 'importedAt', 'createdAt'] as const;
export type StatementSortField = (typeof statementSortFields)[number];

export interface StatementListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string | undefined;
  readonly sortBy: StatementSortField;
  readonly sortOrder: 'asc' | 'desc';
}

export interface StatementListResult {
  readonly items: readonly BankStatementDto[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export const transactionSortFields = ['bookedAt', 'amount', 'createdAt'] as const;
export type TransactionSortField = (typeof transactionSortFields)[number];

export interface TransactionListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string | undefined;
  readonly statementId?: string | undefined;
  readonly matchStatus?: PaymentMatchStatus | undefined;
  readonly direction?: TransactionDirection | undefined;
  readonly bookedFrom?: string | undefined;
  readonly bookedTo?: string | undefined;
  readonly minAmount?: string | undefined;
  readonly maxAmount?: string | undefined;
  readonly sortBy: TransactionSortField;
  readonly sortOrder: 'asc' | 'desc';
}

export interface TransactionListResult {
  readonly items: readonly BankTransactionDto[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

/**
 * Half-open interval `[from, to)`, as the caller asked for it.
 *
 * Either bound may be absent, and an absent bound is resolved by the service
 * from the shared reporting default. The report echoes back the window it
 * actually used.
 */
export interface FinanceSummaryQuery {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export interface FinanceSummaryStatusRow {
  readonly status: PaymentMatchStatus;
  readonly count: number;
  readonly amount: string;
  /** Share of the examined transactions, in `[0, 1]`, rounded to four decimals. */
  readonly share: number;
}

/**
 * Flat on purpose. Grouping the three totals under a `totals` object adds a
 * level that carries no meaning — every field at the top is a fact about the
 * same window — and the two backends have to agree on the shape, not each
 * pick the one its author preferred.
 */
export interface FinanceSummaryReport {
  readonly from: string;
  readonly to: string;
  readonly transactionCount: number;
  readonly inflow: string;
  readonly outflow: string;
  /** Inflow minus outflow; the only value in this module that may be negative. */
  readonly net: string;
  readonly statuses: readonly FinanceSummaryStatusRow[];
}
