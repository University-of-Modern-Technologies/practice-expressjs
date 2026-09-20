import { describe, expect, it } from '@jest/globals';

import {
  MAX_SUMMARY_RANGE_DAYS,
  financeSummarySchema,
  importStatementSchema,
  listStatementsSchema,
  listTransactionsSchema,
  matchTransactionSchema,
  reconcileSchema,
  unmatchTransactionSchema,
} from './validation.js';

const id = '5ff875e1-4c1d-4e45-9c8a-fceb5fb5d836';
const orderId = 'd2d0a3a1-0f9a-4c8e-8f0a-1f7f8ba2c111';

const DAY_MS = 86_400_000;

describe('statement list validation', () => {
  it('sorts by the statement period unless told otherwise', () => {
    const parsed = listStatementsSchema.safeParse({ query: {} });
    expect(parsed.success && parsed.data.query).toMatchObject({
      page: 1,
      pageSize: 20,
      sortBy: 'periodStart',
      sortOrder: 'desc',
    });
  });

  it('accepts only the documented sort fields', () => {
    for (const sortBy of ['periodStart', 'importedAt', 'createdAt']) {
      expect(listStatementsSchema.safeParse({ query: { sortBy } }).success).toBe(true);
    }
    expect(listStatementsSchema.safeParse({ query: { sortBy: 'closingBalance' } }).success).toBe(
      false,
    );
  });
});

describe('transaction list validation', () => {
  it('sorts by the booking date unless told otherwise', () => {
    const parsed = listTransactionsSchema.safeParse({ query: {} });
    expect(parsed.success && parsed.data.query).toMatchObject({
      page: 1,
      pageSize: 20,
      sortBy: 'bookedAt',
      sortOrder: 'desc',
    });
  });

  it('keeps an amount filter as text rather than coercing it to a number', () => {
    const parsed = listTransactionsSchema.safeParse({ query: { minAmount: '19.99' } });
    expect(parsed.success && parsed.data.query.minAmount).toBe('19.99');
    // Three decimals is not money at this scale, and neither is an exponent.
    expect(listTransactionsSchema.safeParse({ query: { minAmount: '19.999' } }).success).toBe(
      false,
    );
    expect(listTransactionsSchema.safeParse({ query: { minAmount: '1e3' } }).success).toBe(false);
    expect(listTransactionsSchema.safeParse({ query: { minAmount: '-5.00' } }).success).toBe(false);
  });

  it('rejects bounds that run backwards, in dates and in amounts alike', () => {
    expect(
      listTransactionsSchema.safeParse({
        query: { bookedFrom: '2026-03-02T00:00:00Z', bookedTo: '2026-03-01T00:00:00Z' },
      }).success,
    ).toBe(false);
    // `9.99` against `10.00` is exactly where a text comparison would be wrong.
    expect(
      listTransactionsSchema.safeParse({ query: { minAmount: '9.99', maxAmount: '10.00' } })
        .success,
    ).toBe(true);
    expect(
      listTransactionsSchema.safeParse({ query: { minAmount: '10.00', maxAmount: '9.99' } })
        .success,
    ).toBe(false);
  });

  it('accepts only the documented match statuses', () => {
    for (const matchStatus of ['UNMATCHED', 'SUGGESTED', 'MATCHED', 'IGNORED']) {
      expect(listTransactionsSchema.safeParse({ query: { matchStatus } }).success).toBe(true);
    }
    expect(listTransactionsSchema.safeParse({ query: { matchStatus: 'MAYBE' } }).success).toBe(
      false,
    );
  });
});

describe('import and reconcile validation', () => {
  it('take no parameters and drop anything a caller sends', () => {
    const imported = importStatementSchema.safeParse({ body: { statementId: 'forged' } });
    expect(imported.success && imported.data.body).toEqual({});
    expect(importStatementSchema.safeParse({ body: undefined }).success).toBe(true);

    const reconciled = reconcileSchema.safeParse({ body: { tolerance: '999.00' } });
    expect(reconciled.success && reconciled.data.body).toEqual({});
  });
});

describe('matching validation', () => {
  it('requires both the order and the version to match by hand', () => {
    expect(
      matchTransactionSchema.safeParse({ params: { id }, body: { version: 1, orderId } }).success,
    ).toBe(true);
    expect(matchTransactionSchema.safeParse({ params: { id }, body: { orderId } }).success).toBe(
      false,
    );
    expect(matchTransactionSchema.safeParse({ params: { id }, body: { version: 1 } }).success).toBe(
      false,
    );
  });

  it('requires a version query parameter to undo a match', () => {
    expect(
      unmatchTransactionSchema.safeParse({ params: { id }, query: { version: '2' } }).success,
    ).toBe(true);
    expect(unmatchTransactionSchema.safeParse({ params: { id }, query: {} }).success).toBe(false);
  });
});

describe('summary validation', () => {
  it('fills in a window when the caller names none', () => {
    const parsed = financeSummarySchema.safeParse({ query: {} });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(Date.parse(parsed.data.query.from)).toBeLessThan(Date.parse(parsed.data.query.to));
  });

  it('refuses a window that runs backwards or scans years', () => {
    expect(
      financeSummarySchema.safeParse({
        query: { from: '2026-03-02T00:00:00Z', to: '2026-03-01T00:00:00Z' },
      }).success,
    ).toBe(false);

    const to = Date.parse('2026-03-01T00:00:00Z');
    const tooWide = new Date(to - (MAX_SUMMARY_RANGE_DAYS + 1) * DAY_MS).toISOString();
    expect(
      financeSummarySchema.safeParse({ query: { from: tooWide, to: new Date(to).toISOString() } })
        .success,
    ).toBe(false);
  });
});
