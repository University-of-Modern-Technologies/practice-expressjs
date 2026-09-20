import { fromMinorUnits, toMinorUnits } from '../../common/money/index.js';
import type { BankProvider, BankProviderStatement, BankProviderTransaction } from './provider.js';
import type { TransactionDirection } from './types.js';

/**
 * The default provider: deterministic, offline, no account, no key, no network.
 *
 * It exists so the module is complete on a fresh checkout — an import answers,
 * the ledger fills up, reconciliation has something to chew on — without
 * anybody opening a bank feed. It is a *stand-in*, not a bank.
 *
 * Everything it returns is observable through the API once imported, so none of
 * it is an implementation detail: the identifiers, the dates, the amounts and
 * the references below are fixture data, fixed on purpose and not to be
 * adjusted to make a particular run look better.
 *
 * The composition of the twelve rows is what makes the module worth studying.
 * It is uneven by design, so that every branch of the reconciliation rule
 * occurs at least once in real data rather than only in a test:
 *
 * | # | What it exercises |
 * |---|---|
 * | 1–3 | the reference quotes the order number and the amount is exact |
 * | 4 | the amount is a cent short — the tolerance, and only the tolerance |
 * | 5 | no reference at all; the payer's name carries the match |
 * | 6 | an amount belonging to no order — the ordinary unmatched case |
 * | 7–8 | one amount, two possible orders — a question, not an answer |
 * | 9–11 | money going out, which reconciliation does not consider |
 * | 12 | a payment far outside the window — the window's only witness |
 */

/** Identifier of the one statement the stub knows about. */
export const STUB_STATEMENT_EXTERNAL_ID = 'stub-stmt-2026-01';

/** How many transactions that statement carries. */
export const STUB_TRANSACTION_COUNT = 12;

/** Booking time of the first transaction. Fixed, so runs are reproducible. */
const ANCHOR_ISO = '2026-01-05T10:00:00.000Z';

/** Spacing between consecutive transactions. */
const STEP_DAYS = 2;

const DAY_MS = 86_400_000;

const OPENING_BALANCE = '10000.00';

const CURRENCY = 'USD';

/** The amounts, payers and references, in the order the bank lists them. */
interface StubRow {
  readonly direction: TransactionDirection;
  readonly amount: string;
  readonly counterpartyName: string;
  readonly counterpartyAccount: string | null;
  readonly reference: string;
}

const ROWS: readonly StubRow[] = [
  {
    direction: 'CREDIT',
    amount: '1800.00',
    counterpartyName: 'Northwind Workshop',
    counterpartyAccount: 'ACCT-1001',
    reference: 'Payment for order ORD-2026-0001',
  },
  {
    direction: 'CREDIT',
    amount: '2400.00',
    counterpartyName: 'Cedar Labs',
    counterpartyAccount: 'ACCT-1002',
    reference: 'Invoice settled, ORD-2026-0002',
  },
  {
    direction: 'CREDIT',
    amount: '450.00',
    counterpartyName: 'Blue Peak Studio',
    counterpartyAccount: 'ACCT-1003',
    reference: 'ORD-2026-0003 remittance',
  },
  {
    // A cent short of 1800.00: banks round transfer fees, and a payment that
    // is off by one cent is the same payment.
    direction: 'CREDIT',
    amount: '1799.99',
    counterpartyName: 'Northwind Workshop',
    counterpartyAccount: 'ACCT-1001',
    reference: 'Order ORD-2026-0004, net of transfer fee',
  },
  {
    // No reference to speak of; the payer's name is the whole evidence.
    direction: 'CREDIT',
    amount: '1800.00',
    counterpartyName: 'Alex North',
    counterpartyAccount: null,
    reference: 'Wire transfer',
  },
  {
    direction: 'CREDIT',
    amount: '77.15',
    counterpartyName: 'Unknown Payer',
    counterpartyAccount: null,
    reference: 'General deposit',
  },
  {
    direction: 'CREDIT',
    amount: '980.00',
    counterpartyName: 'Acme Holdings',
    counterpartyAccount: 'ACCT-1007',
    reference: 'Bank transfer',
  },
  {
    direction: 'CREDIT',
    amount: '980.00',
    counterpartyName: 'Acme Holdings',
    counterpartyAccount: 'ACCT-1007',
    reference: 'Bank transfer',
  },
  {
    direction: 'DEBIT',
    amount: '3200.00',
    counterpartyName: 'City Property Management',
    counterpartyAccount: 'ACCT-2001',
    reference: 'Office rent, January',
  },
  {
    direction: 'DEBIT',
    amount: '5400.00',
    counterpartyName: 'Payroll Services Ltd',
    counterpartyAccount: 'ACCT-2002',
    reference: 'Payroll, January',
  },
  {
    direction: 'DEBIT',
    amount: '640.00',
    counterpartyName: 'Cloud Hosting Inc',
    counterpartyAccount: 'ACCT-2003',
    reference: 'Hosting and services, January',
  },
  {
    // Quotes an order number, agrees on the amount, and is still not a match:
    // the order it names is created four months after this money arrived.
    // Without this row the ninety-day window is written but never exercised.
    direction: 'CREDIT',
    amount: '1250.00',
    counterpartyName: 'Late Payer LLC',
    counterpartyAccount: 'ACCT-1012',
    reference: 'Payment for order ORD-2026-0012',
  },
];

const bookedAtFor = (index: number): string =>
  new Date(Date.parse(ANCHOR_ISO) + index * STEP_DAYS * DAY_MS).toISOString();

const externalIdFor = (index: number): string =>
  `stub-txn-${(index + 1).toString().padStart(4, '0')}`;

const transactionFor = (row: StubRow, index: number): BankProviderTransaction => ({
  externalId: externalIdFor(index),
  bookedAt: bookedAtFor(index),
  amount: row.amount,
  currency: CURRENCY,
  direction: row.direction,
  counterpartyName: row.counterpartyName,
  ...(row.counterpartyAccount === null ? {} : { counterpartyAccount: row.counterpartyAccount }),
  reference: row.reference,
});

/**
 * Derived rather than written down: the closing balance is what the opening
 * balance becomes after the listed movements, and a statement whose footer
 * disagreed with its own rows would be the first thing to mislead a student.
 */
const closingBalanceFor = (transactions: readonly BankProviderTransaction[]): string =>
  fromMinorUnits(
    transactions.reduce(
      (balance, transaction) =>
        transaction.direction === 'CREDIT'
          ? balance + toMinorUnits(transaction.amount)
          : balance - toMinorUnits(transaction.amount),
      toMinorUnits(OPENING_BALANCE),
    ),
  );

export const buildStubStatement = (): BankProviderStatement => {
  const transactions = ROWS.map(transactionFor);
  return {
    externalId: STUB_STATEMENT_EXTERNAL_ID,
    accountLabel: 'Operating account',
    periodStart: '2026-01-01',
    periodEnd: '2026-01-31',
    openingBalance: OPENING_BALANCE,
    closingBalance: closingBalanceFor(transactions),
    currency: CURRENCY,
    transactions,
  };
};

export const STUB_BANK_PROVIDER_NAME = 'stub';

export const createStubBankProvider = (): BankProvider => {
  const statement = buildStubStatement();

  return {
    name: STUB_BANK_PROVIDER_NAME,
    fetchStatement() {
      return Promise.resolve(statement);
    },
  };
};
