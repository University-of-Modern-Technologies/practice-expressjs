import { describe, expect, it } from '@jest/globals';

import { fromMinorUnits, toMinorUnits } from '../../common/money/index.js';
import { bankProviderStatementSchema } from './provider.js';
import {
  STUB_STATEMENT_EXTERNAL_ID,
  STUB_TRANSACTION_COUNT,
  buildStubStatement,
  createStubBankProvider,
} from './stub-provider.js';

const DAY_MS = 86_400_000;

describe('stub bank provider', () => {
  it('speaks exactly the payload the module requires of a real bank', async () => {
    const statement = await createStubBankProvider().fetchStatement();

    expect(bankProviderStatementSchema.safeParse(statement).success).toBe(true);
    expect(statement.externalId).toBe(STUB_STATEMENT_EXTERNAL_ID);
    expect(statement.transactions).toHaveLength(STUB_TRANSACTION_COUNT);
  });

  it('returns the same statement to two independent instances', async () => {
    // Determinism is what makes a repeated import land entirely in `skipped`:
    // a stub that invented fresh ids would hide a broken idempotency key.
    const first = await createStubBankProvider().fetchStatement();
    const second = await createStubBankProvider().fetchStatement();

    expect(first).toEqual(second);
    const ids = first.transactions.map((transaction) => transaction.externalId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('numbers and dates the transactions the way the fixture says', () => {
    const { transactions } = buildStubStatement();
    const anchor = Date.parse('2026-01-02T10:00:00.000Z');

    transactions.forEach((transaction, index) => {
      expect(transaction.externalId).toBe(
        `stub-txn-2026-01-${(index + 1).toString().padStart(4, '0')}`,
      );
      expect(Date.parse(transaction.bookedAt)).toBe(anchor + index * 2 * DAY_MS);
    });
  });

  it('closes on the balance its own rows add up to', () => {
    const statement = buildStubStatement();

    const expected = statement.transactions.reduce(
      (balance, transaction) =>
        transaction.direction === 'CREDIT'
          ? balance + toMinorUnits(transaction.amount)
          : balance - toMinorUnits(transaction.amount),
      toMinorUnits(statement.openingBalance),
    );

    expect(statement.openingBalance).toBe('10000.00');
    expect(statement.closingBalance).toBe(fromMinorUnits(expected));
  });

  it('carries money in both directions and a payer without an account', () => {
    const { transactions } = buildStubStatement();

    // Every branch of the reconciliation rule has to occur in the fixture, or
    // the rule is written but never seen working on real rows.
    expect(transactions.some((transaction) => transaction.direction === 'CREDIT')).toBe(true);
    expect(transactions.some((transaction) => transaction.direction === 'DEBIT')).toBe(true);
    expect(transactions.some((transaction) => transaction.counterpartyAccount === undefined)).toBe(
      true,
    );
    expect(transactions.some((transaction) => transaction.counterpartyAccount !== undefined)).toBe(
      true,
    );
  });

  it('holds one amount twice, so that an ambiguous payment exists at all', () => {
    const credits = buildStubStatement().transactions.filter(
      (transaction) => transaction.direction === 'CREDIT',
    );
    const counts = new Map<string, number>();
    for (const credit of credits) {
      counts.set(credit.amount, (counts.get(credit.amount) ?? 0) + 1);
    }

    expect([...counts.values()].some((count) => count > 1)).toBe(true);
  });
});
