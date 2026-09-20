import { z } from 'zod';

import { AppError } from '../../common/errors/app-error.js';
import { transactionDirections } from './types.js';

/**
 * Provider-agnostic port for bank statements.
 *
 * Everything above this interface — idempotent import, reconciliation,
 * summaries — is written once and works with the in-repo stub or with whatever
 * the deployment actually banks with. The port is deliberately tiny: one read
 * of one statement, no payments, no balances enquiry. A narrow port is a port
 * that is easy to fake.
 */

/** Money on the wire: a decimal string, never a floating point number. */
const money = z
  .string()
  .trim()
  .regex(/^\d{1,12}(?:\.\d{1,2})?$/, 'Invalid monetary amount');

const currencyCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, 'Invalid currency code')
  .transform((value) => value.toUpperCase());

const calendarDay = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a calendar date');

/**
 * What we require of a transaction on the wire. A bank that answers with
 * anything else is treated as unavailable rather than half-trusted: importing
 * a payment with a mangled amount would put the defect in the ledger, where it
 * outlives the bad response.
 */
export const bankProviderTransactionSchema = z.object({
  externalId: z.string().trim().min(1).max(64),
  bookedAt: z.string().datetime({ offset: true }),
  amount: money,
  currency: currencyCode,
  direction: z.enum(transactionDirections),
  counterpartyName: z.string().trim().min(1).max(200),
  counterpartyAccount: z.string().trim().min(1).max(64).optional(),
  reference: z.string().trim().min(1).max(300),
});

export type BankProviderTransaction = z.infer<typeof bankProviderTransactionSchema>;

export const bankProviderStatementSchema = z.object({
  externalId: z.string().trim().min(1).max(64),
  accountLabel: z.string().trim().min(1).max(64),
  periodStart: calendarDay,
  periodEnd: calendarDay,
  openingBalance: money,
  closingBalance: money,
  currency: currencyCode,
  transactions: z.array(bankProviderTransactionSchema),
});

export type BankProviderStatement = z.infer<typeof bankProviderStatementSchema>;

export interface BankProvider {
  /** Identifies the implementation in responses and logs. */
  readonly name: string;
  fetchStatement(): Promise<BankProviderStatement>;
}

export const BANK_PROVIDER_UNAVAILABLE = 'BANK_PROVIDER_UNAVAILABLE';

/**
 * The single failure mode the module exposes for the bank: a timeout, a
 * refused connection, a 5xx and a payload that violates the contract all reach
 * the caller as the same thing, because they all mean "the statement could not
 * be read just now, try again". The distinguishing detail stays in the log, on
 * our side of the boundary.
 */
export const bankProviderUnavailableError = (): AppError =>
  new AppError('The bank provider is temporarily unavailable', 502, BANK_PROVIDER_UNAVAILABLE);

/**
 * Parses whatever a provider handed over. Anything that does not satisfy the
 * contract is reported as an unavailable bank, which is the only failure the
 * module has for this boundary.
 */
export const parseBankProviderStatement = (payload: unknown): BankProviderStatement => {
  const parsed = bankProviderStatementSchema.safeParse(payload);
  if (!parsed.success) throw bankProviderUnavailableError();
  return parsed.data;
};
