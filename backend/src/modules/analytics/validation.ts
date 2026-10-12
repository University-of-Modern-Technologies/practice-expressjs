import { z } from 'zod';

import { MAX_REPORT_WINDOW_DAYS } from '../../common/reporting/index.js';
import {
  DEFAULT_KYIV_WINDOW_FROM,
  defaultKyivWindowTo,
  kyivWallClockToInstant,
} from './kyiv-time.js';
import { analyticsPeriods, type DateRange } from './types.js';

const DAY_MS = 86_400_000;

/** Widest window a single report may scan. See `common/reporting`. */
export const MAX_RANGE_DAYS = MAX_REPORT_WINDOW_DAYS;
/**
 * Start of the window applied when the caller does not name one — Kyiv
 * midnight of 1 January 2026; the end is the close of today in Kyiv. See
 * `kyiv-time.ts`.
 */
export const DEFAULT_RANGE_FROM = DEFAULT_KYIV_WINDOW_FROM;
/** Hard ceiling for every `limit`; larger values are clamped, not rejected. */
export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 10;
export const MAX_STOCK_THRESHOLD = 1_000_000;
export const DEFAULT_STOCK_THRESHOLD = 5;

/**
 * The one spelling of an instant both backends accept: a calendar date, then
 * optionally a time, then optionally `Z` or a `±HH:MM` offset. Deliberately
 * narrower than `Date.parse`, which also takes `"1"`, a space instead of `T`,
 * local-time readings and English month names — every one of them a reading
 * the sibling backend would have to reproduce, and does not.
 */
const ISO_INSTANT =
  /^([1-9]\d{3})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,9}))?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/;

const MINUTE_MS = 60_000;
const EARLIEST_YEAR = 1000;
const LATEST_YEAR = 9999;

/**
 * Reads a bound as an instant, or returns null when it is not one.
 *
 * A value without a zone is read on the Kyiv clock, the calendar every report
 * is cut on: `2026-03-01` is the instant that day begins in Kyiv, and
 * `2026-03-01T10:00` is ten in the morning there — not in UTC, and not in the
 * zone of whichever machine this process runs on, which is what `Date.parse`
 * would make of it. An explicit `Z` or offset is taken as written. The
 * calendar is checked rather than trusted: `2026-02-31` is refused instead
 * of rolling over into March. Anything finer than a millisecond is truncated,
 * because that is the resolution the data is stored at.
 */
export const parseIsoInstant = (value: string): string | null => {
  const match = ISO_INSTANT.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  const calendarYear = Number(year);
  const monthIndex = Number(month) - 1;
  const dayOfMonth = Number(day);

  const midnight = new Date(Date.UTC(calendarYear, monthIndex, dayOfMonth));
  if (midnight.getUTCMonth() !== monthIndex || midnight.getUTCDate() !== dayOfMonth) return null;

  const wallClock = Date.UTC(
    calendarYear,
    monthIndex,
    dayOfMonth,
    Number(hour ?? 0),
    Number(minute ?? 0),
    Number(second ?? 0),
    Number((fraction ?? '').slice(0, 3).padEnd(3, '0')),
  );
  const offsetMinutes =
    zone === undefined || zone === 'Z'
      ? 0
      : (zone.startsWith('-') ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4)));
  const instant = new Date(
    zone === undefined ? kyivWallClockToInstant(wallClock) : wallClock - offsetMinutes * MINUTE_MS,
  );
  const utcYear = instant.getUTCFullYear();
  if (utcYear < EARLIEST_YEAR || utcYear > LATEST_YEAR) return null;
  return instant.toISOString();
};

/**
 * Dates are normalised to ISO 8601 UTC strings rather than `Date` objects so
 * that parsing the output again is a no-op: the router validates a request and
 * the controller validates it once more, and both must agree.
 */
const isoInstant = z
  .string()
  .min(1)
  .transform((value, context) => {
    const instant = parseIsoInstant(value);
    if (instant === null) {
      context.addIssue({ code: 'custom', message: 'Expected an ISO 8601 date or timestamp' });
      return z.NEVER;
    }
    return instant;
  })
  .meta({
    description:
      'Дата або мітка часу ISO 8601; без зони читається за київським часом, нормалізується до UTC.',
  });

interface RangeInput {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

// Each bound defaults on its own, so a caller may send neither, either, or
// both. The start is fixed and the end is the close of today in Kyiv, so a
// report asked for without a window includes what was entered today.
const applyRangeDefaults = <T extends RangeInput>(value: T): T & DateRange => ({
  ...value,
  from: value.from ?? DEFAULT_RANGE_FROM,
  to: value.to ?? defaultKyivWindowTo(),
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
  .default(DEFAULT_LIMIT)
  .meta({
    description: `Значення понад ${String(MAX_LIMIT)} обрізаються до ${String(MAX_LIMIT)}, а не відхиляються.`,
  });

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
