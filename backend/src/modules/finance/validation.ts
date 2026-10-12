import { MAX_PAGE } from '../../common/query/pagination.js';
import { z } from 'zod';

import { MAX_REPORT_WINDOW_DAYS } from '../../common/reporting/index.js';
import { DEFAULT_KYIV_WINDOW_FROM, defaultKyivWindowTo } from '../analytics/kyiv-time.js';
import { parseIsoInstant } from '../analytics/validation.js';
import {
  paymentMatchStatuses,
  statementSortFields,
  transactionDirections,
  transactionSortFields,
} from './types.js';

const idParams = z.object({ id: z.string().uuid() });
const version = z.coerce.number().int().positive();

/**
 * An amount is read as text and stays text. Coercing it to a number here would
 * undo, in one line, the arithmetic care the rest of the module takes.
 */
const money = z
  .string()
  .trim()
  .regex(/^\d{1,12}(?:\.\d{1,2})?$/, 'Invalid monetary amount');

/**
 * Widest window a summary may scan: the shared reporting ceiling, so the
 * default window, which ends today, is always one the summary accepts.
 */
export const MAX_SUMMARY_RANGE_DAYS = MAX_REPORT_WINDOW_DAYS;
const DAY_MS = 86_400_000;

/**
 * An instant, read by the same rule as every report bound in this API: ISO
 * 8601, a missing zone meaning the Kyiv clock — so `2026-03-01` is the start
 * of that day in Kyiv — and nothing `Date.parse` would guess at.
 * The output is a UTC string, so a second parse of it is a no-op.
 */
const readInstant = (value: string, context: z.RefinementCtx): string => {
  const instant = parseIsoInstant(value);
  if (instant === null) {
    context.addIssue({ code: 'custom', message: 'Expected an ISO 8601 date or timestamp' });
    return z.NEVER;
  }
  return instant;
};

const isoInstant = z.string().min(1).transform(readInstant);

/**
 * The booking bounds of the ledger. `bookedTo` is exclusive, as the end of
 * every window in this API is: two adjacent periods must not both claim the
 * line booked on their shared boundary.
 */
const bookedFrom = z.string().transform(readInstant).meta({ format: 'date-time' });
const bookedTo = z.string().transform(readInstant).meta({
  format: 'date-time',
  description: 'Виключна межа: до вибірки потрапляють транзакції, проведені раніше за неї.',
});

export const listStatementsSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).max(MAX_PAGE).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().min(1).max(160).optional(),
    sortBy: z.enum(statementSortFields).default('periodStart'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  }),
});

/**
 * Import takes no parameters: which statement is pulled is the bank's
 * business. Anything a caller sends is dropped rather than honoured, so a
 * client cannot steer the import by hand.
 */
export const importStatementSchema = z.object({ body: z.object({}).optional() });

export const listTransactionsSchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).max(MAX_PAGE).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
      search: z.string().trim().min(1).max(160).optional(),
      statementId: z.string().uuid().optional(),
      matchStatus: z.enum(paymentMatchStatuses).optional(),
      direction: z.enum(transactionDirections).optional(),
      bookedFrom: bookedFrom.optional(),
      bookedTo: bookedTo.optional(),
      minAmount: money.optional(),
      maxAmount: money.optional(),
      sortBy: z.enum(transactionSortFields).default('bookedAt'),
      sortOrder: z.enum(['asc', 'desc']).default('desc'),
    })
    .refine(
      (value) =>
        value.bookedFrom === undefined ||
        value.bookedTo === undefined ||
        Date.parse(value.bookedFrom) <= Date.parse(value.bookedTo),
      { message: 'bookedFrom must not be later than bookedTo', path: ['bookedFrom'] },
    )
    // Compared as text of equal scale would be wrong for `9.99` against
    // `10.00`, so the bounds are compared as numbers — a comparison, never an
    // arithmetic step, and never a value that is stored.
    .refine(
      (value) =>
        value.minAmount === undefined ||
        value.maxAmount === undefined ||
        Number(value.minAmount) <= Number(value.maxAmount),
      { message: 'minAmount must not exceed maxAmount', path: ['minAmount'] },
    ),
});

export const getTransactionSchema = z.object({ params: idParams });

/**
 * Matching by hand is an override: a person has seen the statement and the
 * order and says they belong together. The order is named explicitly, and the
 * version is what stops two people from overriding each other blindly.
 */
export const matchTransactionSchema = z.object({
  params: idParams,
  body: z.object({ version, orderId: z.string().uuid() }),
});

/** Unmatching carries the version in the query, as every other delete does. */
export const unmatchTransactionSchema = z.object({
  params: idParams,
  query: z.object({ version }),
});

/** Reconciliation takes no parameters either; it examines what is pending. */
export const reconcileSchema = z.object({ body: z.object({}).optional() });

/**
 * Each bound is optional on the wire and defaults on its own, from the shared
 * reporting window rather than from the clock: a fixed start, and the end of
 * today — both on the Kyiv calendar, as every report is cut.
 *
 * The defaults are applied *before* the two checks, exactly as the analytics
 * reports do it. Checking only a window the caller named in full let a single
 * bound through unexamined — `from` in 2031 with the default `to` of today is
 * a window that runs backwards, and it used to be answered with an empty
 * report instead of being refused.
 */
export const financeSummarySchema = z.object({
  query: z
    .object({ from: isoInstant.optional(), to: isoInstant.optional() })
    .transform((value) => ({
      ...value,
      from: value.from ?? DEFAULT_KYIV_WINDOW_FROM,
      to: value.to ?? defaultKyivWindowTo(),
    }))
    .refine((value) => Date.parse(value.from) < Date.parse(value.to), {
      message: 'from must be earlier than to',
      path: ['from'],
    })
    .refine(
      (value) => Date.parse(value.to) - Date.parse(value.from) <= MAX_SUMMARY_RANGE_DAYS * DAY_MS,
      {
        message: `The date range must not exceed ${MAX_SUMMARY_RANGE_DAYS} days`,
        path: ['from'],
      },
    ),
});
