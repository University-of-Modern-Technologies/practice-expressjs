import { z } from 'zod';

import {
  currencyCodeSchema,
  decimalStringSchema,
  versionNumberSchema,
} from '../../common/openapi/index.js';
import { orderStatusSchema } from '../orders/types.js';
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
export const bankStatementSchema = z
  .object({
    id: z.uuid(),
    externalId: z.string().min(1).max(64),
    accountLabel: z.string().min(1).max(64),
    periodStart: z.date(),
    periodEnd: z.date(),
    openingBalance: decimalStringSchema,
    closingBalance: decimalStringSchema,
    currency: currencyCodeSchema,
    importedById: z.uuid().nullable(),
    importedAt: z.date(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .meta({ id: 'BankStatement' });

export type BankStatementDto = Readonly<z.infer<typeof bankStatementSchema>>;

const bankTransactionShape = {
  id: z.uuid(),
  statementId: z.uuid(),
  externalId: z.string().min(1).max(64),
  bookedAt: z.date(),
  // Money crosses this boundary as a decimal string, never as a number.
  amount: decimalStringSchema,
  currency: currencyCodeSchema,
  direction: z.enum(transactionDirections),
  counterpartyName: z.string().min(1).max(200),
  counterpartyAccount: z.string().max(64).nullable(),
  // The payment reference; the main thing reconciliation reads.
  reference: z.string().min(1).max(300),
  matchStatus: z.enum(paymentMatchStatuses),
  // Set if and only if `matchStatus` is `MATCHED`. The database holds the same
  // rule as a check constraint, so a logic error here fails loudly instead of
  // leaving a half-matched row behind.
  matchedOrderId: z
    .uuid()
    .nullable()
    .meta({ description: 'Заповнене тоді й лише тоді, коли matchStatus = MATCHED.' }),
  matchedAt: z.date().nullable(),
  matchedById: z.uuid().nullable(),
  // Set when a person takes a match back; automatic reconciliation skips the
  // row until a person matches it again by hand.
  autoMatchDisabled: z.boolean().meta({
    description:
      'true, якщо зведення зняли вручну: автозведення цей рядок пропускає, доки його ' +
      'не зведуть вручну знову.',
  }),
  version: versionNumberSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
};

export const bankTransactionSchema = z.object(bankTransactionShape).meta({ id: 'BankTransaction' });

export type BankTransactionDto = Readonly<z.infer<typeof bankTransactionSchema>>;

/**
 * One order that a transaction could belong to. A suggestion is not stored —
 * the check constraint allows an order reference only on a matched row — so it
 * is recomputed whenever a single transaction is read.
 */
const matchCandidateSchema = z.object({
  orderId: z.uuid(),
  orderNumber: z.string().max(32),
  status: orderStatusSchema,
  total: decimalStringSchema,
  currency: currencyCodeSchema,
  contactId: z.uuid().nullable(),
  // The field the rule compared against, so the reader can check the answer.
  placedAt: z.date().nullable(),
});

export type MatchCandidateDto = Readonly<z.infer<typeof matchCandidateSchema>>;

/**
 * The single-transaction view. `candidates` is empty unless the transaction is
 * `SUGGESTED`: for every other state the question "which order is this?" has
 * either been answered or has no answer worth offering.
 */
export const bankTransactionDetailSchema = z
  .object({
    ...bankTransactionShape,
    candidates: z.array(matchCandidateSchema).meta({
      description: 'Непорожній лише для SUGGESTED: кандидати обчислюються на читанні.',
    }),
  })
  .meta({ id: 'BankTransactionDetail' });

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
export const statementImportResultSchema = z.object({
  statementId: z.uuid(),
  imported: z.int().min(0),
  skipped: z.int().min(0),
});

export type StatementImportResult = Readonly<z.infer<typeof statementImportResultSchema>>;

/**
 * What one reconciliation pass decided about the transactions it examined.
 *
 * `ignored` counts the outgoing lines. They are examined — that is why
 * `examined` is the size of the batch and not the size of its incoming half —
 * and filing them as ignored is the decision, not an omission: rent and
 * payroll are real movements that no order will ever explain.
 */
export const reconcileResultSchema = z.object({
  examined: z.int().min(0),
  matched: z.int().min(0),
  suggested: z.int().min(0),
  unmatched: z.int().min(0),
  ignored: z.int().min(0),
});

export type ReconcileResult = Readonly<z.infer<typeof reconcileResultSchema>>;

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

const financeSummaryStatusRowSchema = z.object({
  status: z.enum(paymentMatchStatuses),
  count: z.int().min(0),
  amount: decimalStringSchema,
  // Share of the examined transactions, in `[0, 1]`, rounded to four decimals.
  share: z.number().min(0).max(1),
});

export type FinanceSummaryStatusRow = Readonly<z.infer<typeof financeSummaryStatusRowSchema>>;

/**
 * Flat on purpose. Grouping the three totals under a `totals` object adds a
 * level that carries no meaning — every field at the top is a fact about the
 * same window — and the two backends have to agree on the shape, not each
 * pick the one its author preferred.
 */
export const financeSummaryReportSchema = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  transactionCount: z.int().min(0),
  inflow: decimalStringSchema,
  outflow: decimalStringSchema,
  // Inflow minus outflow; the only value in this module that may be negative.
  net: z
    .string()
    .regex(/^-?\d{1,12}(?:\.\d{1,2})?$/)
    .meta({ description: 'Десяткове число у вигляді рядка; може бути відʼємним.' }),
  statuses: z.array(financeSummaryStatusRowSchema),
});

export type FinanceSummaryReport = Readonly<z.infer<typeof financeSummaryReportSchema>>;
