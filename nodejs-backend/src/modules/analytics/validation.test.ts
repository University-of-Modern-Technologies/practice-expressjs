import { describe, expect, it } from '@jest/globals';

import {
  DEFAULT_RANGE_FROM,
  DEFAULT_RANGE_TO,
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
   * The window used to be "the last thirty days", which made the answer to a
   * question with no parameters depend on the day it was asked — and made a
   * report of data that is a year old look like a report of nothing.
   */
  it('defaults the range to a fixed month rather than to the last thirty days', () => {
    const parsed = salesSummarySchema.parse({ query: {} });
    expect(parsed.query.from).toBe(DEFAULT_RANGE_FROM);
    expect(parsed.query.to).toBe(DEFAULT_RANGE_TO);
    expect(parsed.query.period).toBe('day');
  });

  it('fills only the bound the caller left out', () => {
    const parsed = salesSummarySchema.parse({ query: { from: '2026-01-01' } });
    expect(parsed.query.from).toBe('2026-01-01T00:00:00.000Z');
    expect(parsed.query.to).toBe(DEFAULT_RANGE_TO);
  });

  it('normalises dates to ISO 8601 and stays idempotent on a second parse', () => {
    const first = salesSummarySchema.parse({
      query: { from: '2026-01-01', to: '2026-02-01', period: 'week' },
    });
    expect(first.query.from).toBe('2026-01-01T00:00:00.000Z');
    expect(first.query.to).toBe('2026-02-01T00:00:00.000Z');

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
