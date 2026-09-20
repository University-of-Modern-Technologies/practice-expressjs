import { describe, expect, it, jest } from '@jest/globals';

import { AppError } from '../../common/errors/index.js';
import type { DomainEventNotification, DomainEventPublisher } from '../../common/types/index.js';
import type { AuditService } from '../audit/service.js';
import { bankProviderUnavailableError, type BankProvider } from './provider.js';
import { createFinanceService, type FinanceDatabase } from './service.js';
import { buildStubStatement, createStubBankProvider } from './stub-provider.js';
import type { FinanceAccess, PaymentMatchStatus, TransactionDirection } from './types.js';

const access: FinanceAccess = { actorId: 'actor-1', scope: 'ALL' };

/** A stored statement row, with the amounts as Prisma renders them. */
interface StatementRow {
  id: string;
  externalId: string;
  accountLabel: string;
  periodStart: Date;
  periodEnd: Date;
  openingBalance: string;
  closingBalance: string;
  currency: string;
  importedById: string | null;
  importedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface TransactionRow {
  id: string;
  statementId: string;
  externalId: string;
  bookedAt: Date;
  amount: string;
  currency: string;
  direction: TransactionDirection;
  counterpartyName: string;
  counterpartyAccount: string | null;
  reference: string;
  matchStatus: PaymentMatchStatus;
  matchedOrderId: string | null;
  matchedById: string | null;
  matchedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

interface OrderRow {
  id: string;
  orderNumber: string;
  status: string;
  currency: string;
  total: string;
  contactId: string | null;
  createdAt: Date;
  contact: { firstName: string; lastName: string } | null;
}

// `10000` rather than `10000.00`: this is how Postgres hands a Decimal(14,2)
// back, and putting the scale on again is the service's job.
const statementRow: StatementRow = {
  id: 'stmt-1',
  externalId: 'stub-stmt-2026-01',
  accountLabel: 'Operating account',
  periodStart: new Date('2026-01-01T00:00:00.000Z'),
  periodEnd: new Date('2026-01-31T00:00:00.000Z'),
  openingBalance: '10000',
  closingBalance: '12297.14',
  currency: 'USD',
  importedById: access.actorId,
  importedAt: new Date('2026-02-01T09:00:00.000Z'),
  createdAt: new Date('2026-02-01T09:00:00.000Z'),
  updatedAt: new Date('2026-02-01T09:00:00.000Z'),
};

const unmatchedRow: TransactionRow = {
  id: 'txn-1',
  statementId: statementRow.id,
  externalId: 'stub-txn-0001',
  bookedAt: new Date('2026-01-05T10:00:00.000Z'),
  amount: '1800',
  currency: 'USD',
  direction: 'CREDIT',
  counterpartyName: 'Northwind Workshop',
  counterpartyAccount: 'ACCT-1001',
  reference: 'Payment for order ORD-2026-0001',
  matchStatus: 'UNMATCHED',
  matchedOrderId: null,
  matchedById: null,
  matchedAt: null,
  version: 1,
  createdAt: new Date('2026-02-01T09:00:00.000Z'),
  updatedAt: new Date('2026-02-01T09:00:00.000Z'),
};

const matchedRow: TransactionRow = {
  ...unmatchedRow,
  matchStatus: 'MATCHED',
  matchedOrderId: 'order-1',
  matchedById: access.actorId,
  matchedAt: new Date('2026-02-02T09:00:00.000Z'),
  version: 2,
};

const orderRow: OrderRow = {
  id: 'order-1',
  orderNumber: 'ORD-2026-0001',
  status: 'CONFIRMED',
  currency: 'USD',
  total: '1800',
  contactId: 'contact-1',
  createdAt: new Date('2026-01-02T09:00:00.000Z'),
  contact: { firstName: 'Alex', lastName: 'North' },
};

const stubStatement = buildStubStatement();

interface HarnessOptions {
  readonly statement?: StatementRow | null;
  readonly storedExternalIds?: readonly string[];
  readonly createStatement?: (args: unknown) => Promise<unknown>;
  readonly existing?: TransactionRow | null;
  readonly update?: (args: unknown) => Promise<unknown>;
  readonly order?: OrderRow | null;
  readonly orders?: readonly OrderRow[];
  readonly pending?: readonly TransactionRow[];
  readonly provider?: BankProvider;
  readonly byDirection?: readonly unknown[];
  readonly byStatus?: readonly unknown[];
}

const createHarness = (options: HarnessOptions = {}) => {
  // Stands in for the unique indexes on `external_id`: a second insert of an
  // id already stored fails exactly the way Postgres would.
  const storedExternalIds = new Set<string>(options.storedExternalIds ?? []);
  let statement: StatementRow | null = options.statement ?? null;

  const statementFindFirst = jest.fn(async (_args: unknown) => statement);
  const statementCreate = jest.fn(
    options.createStatement ??
      (async (args: unknown) => {
        const { data } = args as { data: { externalId: string } };
        statement = { ...statementRow, externalId: data.externalId };
        return statement;
      }),
  );
  const transactionCreate = jest.fn(async (args: unknown) => {
    const { data } = args as { data: { externalId: string } };
    if (storedExternalIds.has(data.externalId)) {
      throw { code: 'P2002', meta: { target: ['external_id'] } };
    }
    storedExternalIds.add(data.externalId);
    return { id: `txn-${storedExternalIds.size}` };
  });
  const knownExternalIds = jest.fn(async (args: unknown) => {
    const { where } = args as { where: { externalId: { in: readonly string[] } } };
    return where.externalId.in
      .filter((value) => storedExternalIds.has(value))
      .map((externalId) => ({ externalId }));
  });
  const readTransaction = jest.fn(async (_args: unknown): Promise<TransactionRow | null> =>
    options.existing === undefined ? unmatchedRow : options.existing,
  );
  const updateTransaction = jest.fn(options.update ?? (async (_args: unknown) => matchedRow));
  const findOrder = jest.fn(async (_args: unknown): Promise<OrderRow | null> =>
    options.order === undefined ? orderRow : options.order,
  );
  const findOrders = jest.fn(async (_args: unknown) => options.orders ?? [orderRow]);
  const findTransactions = jest.fn(async (_args: unknown) => options.pending ?? [unmatchedRow]);
  const findStatements = jest.fn(async (_args: unknown) => [statementRow]);
  const groupBy = jest.fn(async (args: unknown) => {
    const { by } = args as { by: readonly string[] };
    return by[0] === 'direction'
      ? (options.byDirection ?? [
          { direction: 'CREDIT', _count: { _all: 9 }, _sum: { amount: '11537.14' } },
          { direction: 'DEBIT', _count: { _all: 3 }, _sum: { amount: '9240.00' } },
        ])
      : (options.byStatus ?? [
          { matchStatus: 'UNMATCHED', _count: { _all: 12 }, _sum: { amount: '20777.14' } },
        ]);
  });

  const transaction = {
    bankStatement: { findFirst: statementFindFirst, create: statementCreate },
    bankTransaction: {
      findFirst: readTransaction,
      findMany: knownExternalIds,
      create: transactionCreate,
      update: updateTransaction,
    },
    order: { findFirst: findOrder },
    auditLog: { create: jest.fn() },
  };
  const db = {
    bankStatement: { findMany: findStatements, count: jest.fn(async () => 1) },
    bankTransaction: {
      findFirst: readTransaction,
      findMany: findTransactions,
      count: jest.fn(async () => 1),
      update: updateTransaction,
      groupBy,
    },
    order: { findMany: findOrders, findFirst: findOrder },
    $transaction: jest.fn(async (callback: (value: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
    ),
  } as unknown as FinanceDatabase;
  const record = jest.fn(async (_transaction: unknown, _event: unknown) => undefined);
  const audit = { record } as unknown as AuditService;
  const publish = jest.fn((_event: DomainEventNotification): void => undefined);
  const events: DomainEventPublisher = { publish };
  const provider = options.provider ?? createStubBankProvider();

  return {
    service: createFinanceService(db, audit, provider, events),
    statementCreate,
    transactionCreate,
    readTransaction,
    updateTransaction,
    findOrder,
    findOrders,
    findTransactions,
    findStatements,
    groupBy,
    record,
    publish,
  };
};

const statementQuery = {
  page: 1,
  pageSize: 20,
  sortBy: 'periodStart' as const,
  sortOrder: 'desc' as const,
};

const transactionQuery = {
  page: 1,
  pageSize: 20,
  sortBy: 'bookedAt' as const,
  sortOrder: 'desc' as const,
};

describe('finance service money on the wire', () => {
  it('renders every amount at full scale, whatever the column returns', async () => {
    const harness = createHarness();

    const statements = await harness.service.listStatements(access, statementQuery);
    const transactions = await harness.service.listTransactions(access, transactionQuery);

    expect(statements.items[0]).toMatchObject({
      openingBalance: '10000.00',
      closingBalance: '12297.14',
    });
    expect(transactions.items[0]?.amount).toBe('1800.00');
  });
});

describe('finance service statement import', () => {
  it('stores the statement and every line it carries', async () => {
    const harness = createHarness();

    await expect(harness.service.importStatement(access)).resolves.toEqual({
      statementId: statementRow.id,
      imported: stubStatement.transactions.length,
      skipped: 0,
    });
    expect(harness.statementCreate).toHaveBeenCalledTimes(1);
    expect(harness.transactionCreate).toHaveBeenCalledTimes(stubStatement.transactions.length);
    expect(harness.transactionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ externalId: 'stub-txn-0001', matchStatus: 'UNMATCHED' }),
      }),
    );
  });

  it('creates nothing when the same statement arrives twice', async () => {
    const harness = createHarness();

    const first = await harness.service.importStatement(access);
    const second = await harness.service.importStatement(access);

    expect(first).toEqual({
      statementId: statementRow.id,
      imported: stubStatement.transactions.length,
      skipped: 0,
    });
    // The external id is the whole idempotency key: the second run reads the
    // same document, recognises every line and writes nothing.
    expect(second).toEqual({
      statementId: statementRow.id,
      imported: 0,
      skipped: stubStatement.transactions.length,
    });
    expect(harness.statementCreate).toHaveBeenCalledTimes(1);
    expect(harness.transactionCreate).toHaveBeenCalledTimes(stubStatement.transactions.length);
  });

  it('keeps importing the lines around one it already knows', async () => {
    const harness = createHarness({ storedExternalIds: ['stub-txn-0001', 'stub-txn-0002'] });

    await expect(harness.service.importStatement(access)).resolves.toEqual({
      statementId: statementRow.id,
      imported: stubStatement.transactions.length - 2,
      skipped: 2,
    });
  });

  it('writes the audit record in the transaction that wrote the statement', async () => {
    const harness = createHarness();

    await harness.service.importStatement(access);

    expect(harness.record).toHaveBeenCalledTimes(1);
    expect(harness.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'statement.imported', entityType: 'statement' }),
    );
    expect(harness.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'statement.imported', entityType: 'statement' }),
    );
  });

  it('reports an unreachable bank as a bad gateway and writes nothing', async () => {
    const harness = createHarness({
      provider: {
        name: 'test',
        fetchStatement: () => Promise.reject(bankProviderUnavailableError()),
      },
    });

    await expect(harness.service.importStatement(access)).rejects.toMatchObject({
      statusCode: 502,
      code: 'BANK_PROVIDER_UNAVAILABLE',
    } satisfies Partial<AppError>);
    expect(harness.statementCreate).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('reports a statement that a concurrent import created first', async () => {
    const harness = createHarness({
      createStatement: async () => {
        throw { code: 'P2002', meta: { target: ['external_id'] } };
      },
    });

    await expect(harness.service.importStatement(access)).rejects.toMatchObject({
      statusCode: 409,
      code: 'STATEMENT_DUPLICATE_EXTERNAL_ID',
    } satisfies Partial<AppError>);
    expect(harness.publish).not.toHaveBeenCalled();
  });
});

describe('finance service listing', () => {
  it('orders by the requested field with the id as the tie-breaker', async () => {
    const harness = createHarness();

    await harness.service.listTransactions(access, { ...transactionQuery, sortBy: 'amount' });

    expect(harness.findTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ amount: 'desc' }, { id: 'asc' }] }),
    );
  });

  it('turns the amount bounds into a range on the column', async () => {
    const harness = createHarness();

    await harness.service.listTransactions(access, {
      ...transactionQuery,
      minAmount: '100.00',
      maxAmount: '2000.00',
      matchStatus: 'UNMATCHED',
    });

    expect(harness.findTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          amount: { gte: '100.00', lte: '2000.00' },
          matchStatus: 'UNMATCHED',
        }),
      }),
    );
  });
});

describe('finance service single transaction', () => {
  it('offers candidates only where the answer is genuinely open', async () => {
    const decided = createHarness();
    await expect(
      decided.service.getTransactionById(access, unmatchedRow.id),
    ).resolves.toMatchObject({ candidates: [] });
    expect(decided.findOrders).not.toHaveBeenCalled();

    const twin: OrderRow = { ...orderRow, id: 'order-2', orderNumber: 'ORD-2026-0007' };
    const open = createHarness({
      existing: { ...unmatchedRow, matchStatus: 'SUGGESTED', reference: 'Bank transfer' },
      orders: [
        { ...orderRow, contact: { firstName: 'Northwind', lastName: 'Workshop' } },
        { ...twin, contact: { firstName: 'Northwind', lastName: 'Workshop' } },
      ],
    });

    const result = await open.service.getTransactionById(access, unmatchedRow.id);

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({ orderId: 'order-1', total: '1800.00' });
  });

  it('reports a transaction nobody stored as not found', async () => {
    const harness = createHarness({ existing: null });

    await expect(harness.service.getTransactionById(access, 'txn-404')).rejects.toMatchObject({
      statusCode: 404,
      code: 'TRANSACTION_NOT_FOUND',
    } satisfies Partial<AppError>);
  });
});

describe('finance service manual matching', () => {
  it('records the order, the person and the moment together', async () => {
    const harness = createHarness();

    const result = await harness.service.match(access, unmatchedRow.id, {
      version: 1,
      orderId: 'order-1',
    });

    expect(result).toMatchObject({ matchStatus: 'MATCHED', matchedOrderId: 'order-1' });
    expect(harness.updateTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: unmatchedRow.id, version: 1 },
        data: expect.objectContaining({
          matchStatus: 'MATCHED',
          matchedOrderId: 'order-1',
          matchedById: access.actorId,
          version: { increment: 1 },
        }),
      }),
    );
    expect(harness.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'transaction.matched', entityType: 'transaction' }),
    );
    expect(harness.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'transaction.matched' }),
    );
  });

  it('refuses to match a transaction that is already matched', async () => {
    const harness = createHarness({ existing: { ...matchedRow, version: 1 } });

    await expect(
      harness.service.match(access, matchedRow.id, { version: 1, orderId: 'order-2' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'TRANSACTION_ALREADY_MATCHED',
    } satisfies Partial<AppError>);
    expect(harness.updateTransaction).not.toHaveBeenCalled();
  });

  it('rejects an order nobody can reach before writing anything', async () => {
    const harness = createHarness({ order: null });

    await expect(
      harness.service.match(access, unmatchedRow.id, { version: 1, orderId: 'order-404' }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'TRANSACTION_ORDER_NOT_FOUND',
    } satisfies Partial<AppError>);
    expect(harness.updateTransaction).not.toHaveBeenCalled();
  });

  it('lets a person override the evidence but never the arithmetic', async () => {
    // The reference, the status and the window are heuristics a human may
    // overrule; an amount that does not add up is not.
    const harness = createHarness({ order: { ...orderRow, total: '1700.00' } });

    await expect(
      harness.service.match(access, unmatchedRow.id, { version: 1, orderId: 'order-1' }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'TRANSACTION_AMOUNT_MISMATCH',
    } satisfies Partial<AppError>);
    expect(harness.updateTransaction).not.toHaveBeenCalled();
  });

  it('accepts an order a cent apart, because the tolerance says so', async () => {
    const harness = createHarness({ order: { ...orderRow, total: '1799.99' } });

    await expect(
      harness.service.match(access, unmatchedRow.id, { version: 1, orderId: 'order-1' }),
    ).resolves.toMatchObject({ matchStatus: 'MATCHED' });
  });

  it('rejects an already stale match before writing', async () => {
    const harness = createHarness();

    await expect(
      harness.service.match(access, unmatchedRow.id, { version: 2, orderId: 'order-1' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'TRANSACTION_CONCURRENT_MODIFICATION',
    } satisfies Partial<AppError>);
    expect(harness.updateTransaction).not.toHaveBeenCalled();
    expect(harness.record).not.toHaveBeenCalled();
  });

  it('returns a conflict when a concurrent write wins first', async () => {
    const harness = createHarness({
      update: async () => {
        throw { code: 'P2025' };
      },
    });

    await expect(
      harness.service.match(access, unmatchedRow.id, { version: 1, orderId: 'order-1' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'TRANSACTION_CONCURRENT_MODIFICATION',
    } satisfies Partial<AppError>);
    expect(harness.record).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
  });
});

describe('finance service unmatching', () => {
  it('withdraws the conclusion and everything that was written with it', async () => {
    const harness = createHarness({
      existing: { ...matchedRow, version: 2 },
      update: async () => ({ ...unmatchedRow, version: 3 }),
    });

    const result = await harness.service.unmatch(access, matchedRow.id, 2);

    expect(result).toMatchObject({ matchStatus: 'UNMATCHED', matchedOrderId: null });
    expect(harness.updateTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          matchStatus: 'UNMATCHED',
          matchedOrderId: null,
          matchedById: null,
          matchedAt: null,
        }),
      }),
    );
    expect(harness.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'transaction.unmatched' }),
    );
  });

  it('refuses to undo a match that was never made', async () => {
    const harness = createHarness();

    await expect(harness.service.unmatch(access, unmatchedRow.id, 1)).rejects.toMatchObject({
      statusCode: 409,
      code: 'TRANSACTION_NOT_MATCHED',
    } satisfies Partial<AppError>);
    expect(harness.updateTransaction).not.toHaveBeenCalled();
  });
});

describe('finance service reconciliation', () => {
  it('settles a transaction that fits exactly one order', async () => {
    const harness = createHarness();

    await expect(harness.service.reconcile(access)).resolves.toEqual({
      examined: 1,
      matched: 1,
      suggested: 0,
      unmatched: 0,
    });
    expect(harness.updateTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ matchStatus: 'MATCHED', matchedOrderId: 'order-1' }),
      }),
    );
    expect(harness.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'transaction.matched' }),
    );
  });

  it('asks instead of deciding when two orders fit equally well', async () => {
    const harness = createHarness({
      pending: [{ ...unmatchedRow, reference: 'Bank transfer' }],
      orders: [
        { ...orderRow, contact: { firstName: 'Northwind', lastName: 'Workshop' } },
        {
          ...orderRow,
          id: 'order-2',
          orderNumber: 'ORD-2026-0007',
          contact: { firstName: 'Northwind', lastName: 'Workshop' },
        },
      ],
    });

    await expect(harness.service.reconcile(access)).resolves.toEqual({
      examined: 1,
      matched: 0,
      suggested: 1,
      unmatched: 0,
    });
    expect(harness.updateTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: unmatchedRow.id, version: 1 },
        data: { matchStatus: 'SUGGESTED', version: { increment: 1 } },
      }),
    );
  });

  it('leaves money that is going out exactly where it is', async () => {
    const harness = createHarness({
      pending: [{ ...unmatchedRow, direction: 'DEBIT', reference: 'Office rent, January' }],
    });

    await expect(harness.service.reconcile(access)).resolves.toEqual({
      examined: 1,
      matched: 0,
      suggested: 0,
      unmatched: 1,
    });
    // Already unmatched and still unmatched: nothing to write, nothing to say.
    expect(harness.updateTransaction).not.toHaveBeenCalled();
    expect(harness.record).not.toHaveBeenCalled();
  });

  it('reconsiders only what is still open', async () => {
    const harness = createHarness();

    await harness.service.reconcile(access);

    expect(harness.findTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { matchStatus: { in: ['UNMATCHED', 'SUGGESTED'] } },
      }),
    );
  });

  it('abandons neither the batch nor the rest of it when one row moves', async () => {
    const harness = createHarness({
      pending: [unmatchedRow, { ...unmatchedRow, id: 'txn-2' }],
      update: jest
        .fn<(args: unknown) => Promise<unknown>>()
        .mockImplementationOnce(() => Promise.reject({ code: 'P2025' }))
        .mockImplementation(() => Promise.resolve(matchedRow)),
    });

    await expect(harness.service.reconcile(access)).resolves.toEqual({
      examined: 2,
      matched: 2,
      suggested: 0,
      unmatched: 0,
    });
    // The decision stands for both, but only the row that held still was
    // written and announced; the other is picked up by the next run.
    expect(harness.publish).toHaveBeenCalledTimes(1);
  });

  it('has nothing to look up when there is nothing pending', async () => {
    const harness = createHarness({ pending: [] });

    await expect(harness.service.reconcile(access)).resolves.toEqual({
      examined: 0,
      matched: 0,
      suggested: 0,
      unmatched: 0,
    });
    expect(harness.findOrders).not.toHaveBeenCalled();
  });
});

describe('finance service summary', () => {
  it('reports the money in both directions and the shares by state', async () => {
    const harness = createHarness();

    const report = await harness.service.summary(access, {
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
    });

    expect(report.totals).toEqual({
      transactionCount: 12,
      inflow: '11537.14',
      outflow: '9240.00',
      // The one figure in this module that may be negative.
      net: '2297.14',
    });
    expect(report.byStatus).toHaveLength(4);
    expect(report.byStatus).toContainEqual({
      matchStatus: 'UNMATCHED',
      count: 12,
      amount: '20777.14',
      share: 1,
    });
    expect(report.byStatus).toContainEqual({
      matchStatus: 'MATCHED',
      count: 0,
      amount: '0.00',
      share: 0,
    });
  });

  it('reports an empty period as zeroes rather than as nothing', async () => {
    const harness = createHarness({ byDirection: [], byStatus: [] });

    const report = await harness.service.summary(access, {
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
    });

    expect(report.totals).toEqual({
      transactionCount: 0,
      inflow: '0.00',
      outflow: '0.00',
      net: '0.00',
    });
    expect(report.byStatus.every((row) => row.count === 0 && row.share === 0)).toBe(true);
  });
});

describe('finance service domain event fan-out', () => {
  it('stays silent when the transaction is rejected', async () => {
    const harness = createHarness({
      update: async () => {
        throw { code: 'P2025' };
      },
    });

    await expect(
      harness.service.match(access, unmatchedRow.id, { version: 1, orderId: 'order-1' }),
    ).rejects.toBeInstanceOf(AppError);
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('keeps the business result when the secondary consumers fail', async () => {
    const harness = createHarness();
    harness.publish.mockImplementation(() => {
      throw new Error('event stream unreachable');
    });

    // The publisher owns its own failures; a broken stream must never turn a
    // committed match into a failed request.
    await expect(
      harness.service.match(access, unmatchedRow.id, { version: 1, orderId: 'order-1' }),
    ).resolves.toMatchObject({ matchStatus: 'MATCHED' });
  });
});
