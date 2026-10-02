import { z } from 'zod';

import { MAX_REPORT_WINDOW_DAYS } from '../../common/reporting/index.js';
import {
  paymentMatchStatuses,
  statementSortFields,
  transactionDirections,
  transactionSortFields,
} from './types.js';

const idParams = z.object({ id: z.string().uuid() });
const timestamp = z.string().datetime({ offset: true });
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

export const listStatementsSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
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
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
      search: z.string().trim().min(1).max(160).optional(),
      statementId: z.string().uuid().optional(),
      matchStatus: z.enum(paymentMatchStatuses).optional(),
      direction: z.enum(transactionDirections).optional(),
      bookedFrom: timestamp.optional(),
      bookedTo: timestamp.optional(),
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

const isoInstant = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'Expected an ISO 8601 date or timestamp',
  })
  .transform((value) => new Date(value).toISOString());

/**
 * Both bounds stay optional here, and neither is filled in.
 *
 * They used to be defaulted at this point, against the clock: `to` became
 * "now" and `from` a month before it. That made the answer to a question with
 * no parameters depend on the day it was asked — a ledger read months later
 * reported an empty period for ever. The reporting default is a shared
 * constant, so the decision stays in the service rather than the validator.
 *
 * The two checks below therefore apply only to a window the caller actually
 * named. A caller who names nothing is not making a claim to contradict.
 */
export const financeSummarySchema = z.object({
  query: z
    .object({ from: isoInstant.optional(), to: isoInstant.optional() })
    .refine(
      (value) =>
        value.from === undefined ||
        value.to === undefined ||
        Date.parse(value.from) < Date.parse(value.to),
      { message: 'from must be earlier than to', path: ['from'] },
    )
    .refine(
      (value) =>
        value.from === undefined ||
        value.to === undefined ||
        Date.parse(value.to) - Date.parse(value.from) <= MAX_SUMMARY_RANGE_DAYS * DAY_MS,
      {
        message: `The date range must not exceed ${MAX_SUMMARY_RANGE_DAYS} days`,
        path: ['from'],
      },
    ),
});
