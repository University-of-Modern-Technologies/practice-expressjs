import { describe, expect, it } from '@jest/globals';

import { defaultKyivWindowTo } from './kyiv-time.js';
import {
  DEFAULT_RANGE_FROM,
  MAX_LIMIT,
  MAX_RANGE_DAYS,
  dealFunnelSchema,
  salesSummarySchema,
  stockHealthSchema,
  topProductsSchema,
} from './validation.js';

const DAY_MS = 86_400_000;

describe('analytics query validation', () => {
  /*
   * A window measured back from the clock would lose the demonstration data.
   * The start stays where the data begins, and the end covers today, so a
   * record entered this morning is in the report asked for this afternoon.
   */
  it('defaults the range to a fixed start and the end of today', () => {
    const parsed = salesSummarySchema.parse({ query: {} });
    expect(parsed.query.from).toBe(DEFAULT_RANGE_FROM);
    expect(parsed.query.to).toBe(defaultKyivWindowTo());
    expect(Date.parse(parsed.query.to)).toBeGreaterThan(Date.now());
    expect(parsed.query.period).toBe('day');
  });

  it('fills only the bound the caller left out', () => {
    const parsed = salesSummarySchema.parse({ query: { from: '2026-01-01' } });
    expect(parsed.query.from).toBe('2025-12-31T22:00:00.000Z');
    expect(parsed.query.to).toBe(defaultKyivWindowTo());
  });

  it('normalises dates to ISO 8601 and stays idempotent on a second parse', () => {
    const first = salesSummarySchema.parse({
      query: { from: '2026-01-01', to: '2026-02-01', period: 'week' },
    });
    // A bare date is the day as Kyiv lives it: its midnight, in UTC.
    expect(first.query.from).toBe('2025-12-31T22:00:00.000Z');
    expect(first.query.to).toBe('2026-01-31T22:00:00.000Z');

    // The router validates a request and the controller validates it again.
    const second = salesSummarySchema.parse(first);
    expect(second).toEqual(first);
  });

  it('rejects an inverted date range', () => {
    const result = salesSummarySchema.safeParse({
      query: { from: '2026-02-01', to: '2026-01-01' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty date range', () => {
    const result = dealFunnelSchema.safeParse({
      query: { from: '2026-01-01', to: '2026-01-01' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an excessively wide date range', () => {
    const from = new Date('2020-01-01T00:00:00.000Z');
    const justInside = new Date(from.getTime() + MAX_RANGE_DAYS * DAY_MS);
    const justOutside = new Date(from.getTime() + (MAX_RANGE_DAYS + 1) * DAY_MS);

    expect(
      dealFunnelSchema.safeParse({
        query: { from: from.toISOString(), to: justInside.toISOString() },
      }).success,
    ).toBe(true);
    expect(
      dealFunnelSchema.safeParse({
        query: { from: from.toISOString(), to: justOutside.toISOString() },
      }).success,
    ).toBe(false);
  });

  it('rejects an unparsable date', () => {
    expect(salesSummarySchema.safeParse({ query: { from: 'yesterday' } }).success).toBe(false);
  });

  it('restricts the period to the supported buckets', () => {
    expect(salesSummarySchema.safeParse({ query: { period: 'month' } }).success).toBe(true);
    expect(salesSummarySchema.safeParse({ query: { period: 'hour' } }).success).toBe(false);
  });

  it('clamps the limit to the ceiling and coerces a query string', () => {
    expect(topProductsSchema.parse({ query: { limit: '5' } }).query.limit).toBe(5);
    expect(topProductsSchema.parse({ query: { limit: '5000' } }).query.limit).toBe(MAX_LIMIT);
    expect(topProductsSchema.parse({ query: {} }).query.limit).toBe(10);
    expect(topProductsSchema.safeParse({ query: { limit: '0' } }).success).toBe(false);
    expect(topProductsSchema.safeParse({ query: { limit: '2.5' } }).success).toBe(false);
  });

  it('defaults and bounds the stock threshold', () => {
    expect(stockHealthSchema.parse({ query: {} }).query.threshold).toBe(5);
    expect(stockHealthSchema.parse({ query: { threshold: '0' } }).query.threshold).toBe(0);
    expect(stockHealthSchema.safeParse({ query: { threshold: '-1' } }).success).toBe(false);
    expect(stockHealthSchema.parse({ query: { limit: '900' } }).query.limit).toBe(MAX_LIMIT);
  });

  it('rejects an owner filter that is not an identifier', () => {
    expect(dealFunnelSchema.safeParse({ query: { ownerId: 'not-a-uuid' } }).success).toBe(false);
    expect(
      dealFunnelSchema.safeParse({ query: { ownerId: '10000000-0000-4000-8000-000000000001' } })
        .success,
    ).toBe(true);
  });
});

describe('analytics date bounds', () => {
  // A missing zone is not the zone of the server. Since the day
  // boundaries moved to Kyiv it is Kyiv's clock, so a bare date and the same
  // date at midnight name one instant.
  it('reads a date-time without a zone on the Kyiv clock', () => {
    const parsed = salesSummarySchema.parse({
      query: { from: '2026-01-01T10:30', to: '2026-01-02T00:00:00.5' },
    });
    expect(parsed.query.from).toBe('2026-01-01T08:30:00.000Z');
    expect(parsed.query.to).toBe('2026-01-01T22:00:00.500Z');
  });

  // Day boundaries are Kyiv's: an order placed at 00:30 in Kyiv belongs to the
  // day the clock in Kyiv showed, in winter (UTC+2) and in summer (UTC+3).
  it('cuts a day at Kyiv midnight, summer time included', () => {
    const winter = salesSummarySchema.parse({ query: { from: '2026-03-11', to: '2026-03-12' } });
    const halfPastMidnightInWinter = Date.parse('2026-03-10T22:30:00.000Z');
    expect(winter.query.from).toBe('2026-03-10T22:00:00.000Z');
    expect(winter.query.to).toBe('2026-03-11T22:00:00.000Z');
    expect(halfPastMidnightInWinter).toBeGreaterThanOrEqual(Date.parse(winter.query.from));
    expect(halfPastMidnightInWinter).toBeLessThan(Date.parse(winter.query.to));

    const summer = salesSummarySchema.parse({ query: { from: '2026-07-11', to: '2026-07-12' } });
    const halfPastMidnightInSummer = Date.parse('2026-07-10T21:30:00.000Z');
    expect(summer.query.from).toBe('2026-07-10T21:00:00.000Z');
    expect(summer.query.to).toBe('2026-07-11T21:00:00.000Z');
    expect(halfPastMidnightInSummer).toBeGreaterThanOrEqual(Date.parse(summer.query.from));

    // The day before ends where this one starts, so the order is not in it.
    const dayBefore = salesSummarySchema.parse({ query: { from: '2026-03-10', to: '2026-03-11' } });
    expect(halfPastMidnightInWinter).toBeGreaterThanOrEqual(Date.parse(dayBefore.query.to));
  });

  // The day the clocks go forward is 23 hours long, the day they go back 25.
  it('gives the days of a clock change their real length', () => {
    const spring = salesSummarySchema.parse({ query: { from: '2026-03-29', to: '2026-03-30' } });
    expect(spring.query.from).toBe('2026-03-28T22:00:00.000Z');
    expect(spring.query.to).toBe('2026-03-29T21:00:00.000Z');

    const autumn = salesSummarySchema.parse({ query: { from: '2026-10-25', to: '2026-10-26' } });
    expect(autumn.query.from).toBe('2026-10-24T21:00:00.000Z');
    expect(autumn.query.to).toBe('2026-10-25T22:00:00.000Z');
  });

  it('honours an explicit offset and truncates below the millisecond', () => {
    const parsed = salesSummarySchema.parse({
      query: { from: '2026-01-01T02:00:00.123987+02:00', to: '2026-01-02T00:00:00Z' },
    });
    expect(parsed.query.from).toBe('2026-01-01T00:00:00.123Z');
  });

  // Everything `Date.parse` would guess at is refused instead.
  it('refuses anything that is not an ISO 8601 date or timestamp', () => {
    for (const junk of [
      '1',
      '2026',
      '2026-02-31',
      '2026-01-01 10:00',
      '2026-01-01T10:00:00+0200',
      '2026-01-01T24:00',
      ' 2026-01-01',
      'Jan 1 2026',
    ]) {
      expect(salesSummarySchema.safeParse({ query: { from: junk } }).success).toBe(false);
    }
  });
});
