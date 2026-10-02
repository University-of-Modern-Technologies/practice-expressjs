import { z } from 'zod';

import {
  DEFAULT_REPORT_WINDOW_FROM,
  MAX_REPORT_WINDOW_DAYS,
  defaultReportWindowTo,
} from '../../common/reporting/index.js';
import { analyticsPeriods, type DateRange } from './types.js';

const DAY_MS = 86_400_000;

/** Widest window a single report may scan. See `common/reporting`. */
export const MAX_RANGE_DAYS = MAX_REPORT_WINDOW_DAYS;
/**
 * Start of the window applied when the caller does not name one; the end is
 * today. See `common/reporting`.
 */
export const DEFAULT_RANGE_FROM = DEFAULT_REPORT_WINDOW_FROM;
/** Hard ceiling for every `limit`; larger values are clamped, not rejected. */
export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 10;
export const MAX_STOCK_THRESHOLD = 1_000_000;
export const DEFAULT_STOCK_THRESHOLD = 5;

/**
 * Dates are normalised to ISO 8601 UTC strings rather than `Date` objects so
 * that parsing the output again is a no-op: the router validates a request and
 * the controller validates it once more, and both must agree.
 */
const isoInstant = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'Expected an ISO 8601 date or timestamp',
  })
  .transform((value) => new Date(value).toISOString());

interface RangeInput {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

// Each bound defaults on its own, so a caller may send neither, either, or
// both. The start is fixed and the end is the close of today, so a report asked
// for without a window includes what was entered today.
const applyRangeDefaults = <T extends RangeInput>(value: T): T & DateRange => ({
  ...value,
  from: value.from ?? DEFAULT_RANGE_FROM,
  to: value.to ?? defaultReportWindowTo(),
});

const rangeIsOrdered = (value: DateRange): boolean => Date.parse(value.from) < Date.parse(value.to);

const rangeIsBounded = (value: DateRange): boolean =>
  Date.parse(value.to) - Date.parse(value.from) <= MAX_RANGE_DAYS * DAY_MS;

const orderedMessage = (): { message: string; path: PropertyKey[] } => ({
  message: 'from must be earlier than to',
  path: ['from'],
});
const boundedMessage = (): { message: string; path: PropertyKey[] } => ({
  message: `The date range must not exceed ${MAX_RANGE_DAYS} days`,
  path: ['from'],
});

const rangeShape = {
  from: isoInstant.optional(),
  to: isoInstant.optional(),
};

// Clamped rather than rejected: a caller asking for "everything" gets the
// maximum page instead of an error, while the ceiling still holds.
const boundedLimit = z.coerce
  .number()
  .int()
  .min(1)
  .transform((value) => Math.min(value, MAX_LIMIT))
  .default(DEFAULT_LIMIT);

export const salesSummarySchema = z.object({
  query: z
    .object({
      ...rangeShape,
      period: z.enum(analyticsPeriods).default('day'),
      ownerId: z.string().uuid().optional(),
    })
    .transform(applyRangeDefaults)
    .refine(rangeIsOrdered, orderedMessage())
    .refine(rangeIsBounded, boundedMessage()),
});

export const dealFunnelSchema = z.object({
  query: z
    .object({
      ...rangeShape,
      ownerId: z.string().uuid().optional(),
    })
    .transform(applyRangeDefaults)
    .refine(rangeIsOrdered, orderedMessage())
    .refine(rangeIsBounded, boundedMessage()),
});

export const topProductsSchema = z.object({
  query: z
    .object({
      ...rangeShape,
      limit: boundedLimit,
    })
    .transform(applyRangeDefaults)
    .refine(rangeIsOrdered, orderedMessage())
    .refine(rangeIsBounded, boundedMessage()),
});

export const ownerPerformanceSchema = z.object({
  query: z
    .object({
      ...rangeShape,
      limit: boundedLimit,
    })
    .transform(applyRangeDefaults)
    .refine(rangeIsOrdered, orderedMessage())
    .refine(rangeIsBounded, boundedMessage()),
});

export const stockHealthSchema = z.object({
  query: z.object({
    threshold: z.coerce
      .number()
      .int()
      .min(0)
      .transform((value) => Math.min(value, MAX_STOCK_THRESHOLD))
      .default(DEFAULT_STOCK_THRESHOLD),
    limit: boundedLimit,
    warehouseId: z.string().uuid().optional(),
  }),
});
