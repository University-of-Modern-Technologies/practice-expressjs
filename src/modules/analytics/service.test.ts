import { describe, expect, it, jest } from '@jest/globals';

import type { CacheService } from '../../cache/cache.service.js';
import type { Prisma } from '../../db/prisma.js';
import { analyticsReportKey } from './cache-keys.js';
import { createAnalyticsService, type AnalyticsDatabase } from './service.js';

interface RecordingCache extends CacheService {
  readonly store: Map<string, unknown>;
  readonly keys: string[];
}

const createRecordingCache = (): RecordingCache => {
  const store = new Map<string, unknown>();
  const keys: string[] = [];

  const cache: RecordingCache = {
    store,
    keys,
    async get<T>(key: string) {
      keys.push(key);
      return store.has(key) ? (store.get(key) as T) : null;
    },
    async set<T>(key: string, value: T) {
      store.set(key, value);
    },
    async remember<T>(key: string, _ttlSeconds: number, loader: () => Promise<T>) {
      const cached = await cache.get<T>(key);
      if (cached !== null) return cached;
      const value = await loader();
      await cache.set(key, value);
      return value;
    },
    async del() {
      // Not used by a read-only module.
    },
    async invalidatePrefix() {
      store.clear();
    },
  };

  return cache;
};

const createBrokenCache = (): CacheService => ({
  async get() {
    throw new Error('redis down');
  },
  async set() {
    throw new Error('redis down');
  },
  async remember() {
    throw new Error('redis down');
  },
  async del() {
    throw new Error('redis down');
  },
  async invalidatePrefix() {
    throw new Error('redis down');
  },
});

interface Harness {
  readonly db: AnalyticsDatabase;
  readonly queryRaw: jest.Mock;
  readonly dealGroupBy: jest.Mock;
  readonly orderGroupBy: jest.Mock;
  readonly orderItemGroupBy: jest.Mock;
  readonly productFindMany: jest.Mock;
  readonly userFindMany: jest.Mock;
}

const createHarness = (): Harness => {
  // Every mock takes `unknown[]` so it matches the loose `jest.Mock` shape the
  // harness exposes; the arguments are narrowed at the point of use.
  const empty = async (...args: unknown[]): Promise<unknown[]> => {
    void args;
    return [];
  };
  const queryRaw = jest.fn(empty);
  const dealGroupBy = jest.fn(empty);
  const orderGroupBy = jest.fn(empty);
  const orderItemGroupBy = jest.fn(empty);
  const productFindMany = jest.fn(empty);
  const userFindMany = jest.fn(empty);

  const db = {
    $queryRaw: queryRaw,
    deal: { groupBy: dealGroupBy },
    order: { groupBy: orderGroupBy },
    orderItem: { groupBy: orderItemGroupBy },
    product: { findMany: productFindMany },
    user: { findMany: userFindMany },
  } as unknown as AnalyticsDatabase;

  return {
    db,
    queryRaw,
    dealGroupBy,
    orderGroupBy,
    orderItemGroupBy,
    productFindMany,
    userFindMany,
  };
};

const range = { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' };
const decimal = (text: string): { toString(): string } => ({ toString: () => text });

const lastSql = (mock: jest.Mock): Prisma.Sql => mock.mock.calls.at(-1)?.[0] as Prisma.Sql;

describe('analytics sales summary', () => {
  it('maps buckets and aggregates the totals as decimal strings', async () => {
    const harness = createHarness();
    harness.queryRaw.mockImplementation(async () => [
      {
        bucket_start: new Date('2026-01-01T00:00:00.000Z'),
        order_count: 2,
        revenue: '100.10',
      },
      {
        bucket_start: new Date('2026-01-02T00:00:00.000Z'),
        order_count: 3,
        revenue: '49.9',
      },
    ]);
    const service = createAnalyticsService(harness.db, createRecordingCache());

    const report = await service.salesSummary({ ...range, period: 'day' });

    expect(report.series).toEqual([
      { bucketStart: '2026-01-01T00:00:00.000Z', orderCount: 2, revenue: '100.10' },
      { bucketStart: '2026-01-02T00:00:00.000Z', orderCount: 3, revenue: '49.90' },
    ]);
    expect(report.totals).toEqual({
      orderCount: 5,
      revenue: '150.00',
      averageOrderValue: '30.00',
    });
    expect(report.period).toBe('day');
  });

  it('returns zeroed totals for an empty period', async () => {
    const harness = createHarness();
    const service = createAnalyticsService(harness.db, createRecordingCache());

    const report = await service.salesSummary({ ...range, period: 'month' });
    expect(report.series).toEqual([]);
    expect(report.totals).toEqual({
      orderCount: 0,
      revenue: '0.00',
      averageOrderValue: '0.00',
    });
  });

  it('binds every value as a SQL parameter instead of concatenating it', async () => {
    const harness = createHarness();
    const service = createAnalyticsService(harness.db, createRecordingCache());
    const ownerId = '10000000-0000-4000-8000-000000000001';

    await service.salesSummary({ ...range, period: 'week', ownerId });

    const sql = lastSql(harness.queryRaw);
    const text = sql.strings.join('');
    expect(text).not.toContain(ownerId);
    expect(text).not.toContain('week');
    expect(sql.values).toContain('week');
    expect(sql.values).toContain(ownerId);
    expect(sql.values.some((value) => value instanceof Date)).toBe(true);
  });

  it('excludes cancelled and soft-deleted orders in the query itself', async () => {
    const harness = createHarness();
    const service = createAnalyticsService(harness.db, createRecordingCache());

    await service.salesSummary({ ...range, period: 'day' });

    const text = lastSql(harness.queryRaw).strings.join('');
    expect(text).toContain('o.deleted_at IS NULL');
    expect(text).toContain("o.status <> 'CANCELLED'");
  });

  it('caches by the normalised parameters and reuses the entry', async () => {
    const harness = createHarness();
    const cache = createRecordingCache();
    const service = createAnalyticsService(harness.db, cache);

    await service.salesSummary({ ...range, period: 'day' });
    await service.salesSummary({ ...range, period: 'day' });
    expect(harness.queryRaw).toHaveBeenCalledTimes(1);

    // A different period is a different report and misses the cache.
    await service.salesSummary({ ...range, period: 'month' });
    expect(harness.queryRaw).toHaveBeenCalledTimes(2);

    expect(
      cache.store.has(
        analyticsReportKey('sales-summary', { from: range.from, to: range.to, period: 'day' }),
      ),
    ).toBe(true);
  });

  it('still answers when the cache is unavailable', async () => {
    const harness = createHarness();
    const service = createAnalyticsService(harness.db, createBrokenCache());

    await expect(service.salesSummary({ ...range, period: 'day' })).resolves.toMatchObject({
      totals: { orderCount: 0 },
    });
    expect(harness.queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('analytics deal funnel', () => {
  it('reports every stage and the conversion between pipeline steps', async () => {
    const harness = createHarness();
    harness.dealGroupBy.mockImplementation(async () => [
      { stage: 'LEAD', _count: { _all: 100 }, _sum: { amount: decimal('1000') } },
      { stage: 'QUALIFIED', _count: { _all: 50 }, _sum: { amount: decimal('900.5') } },
      { stage: 'PROPOSAL', _count: { _all: 20 }, _sum: { amount: decimal('800') } },
      { stage: 'WON', _count: { _all: 5 }, _sum: { amount: decimal('400') } },
      { stage: 'LOST', _count: { _all: 15 }, _sum: { amount: decimal('300') } },
    ]);
    const service = createAnalyticsService(harness.db, createRecordingCache());

    const report = await service.dealFunnel(range);

    expect(report.stages).toEqual([
      { stage: 'LEAD', count: 100, amount: '1000.00' },
      { stage: 'QUALIFIED', count: 50, amount: '900.50' },
      { stage: 'PROPOSAL', count: 20, amount: '800.00' },
      { stage: 'WON', count: 5, amount: '400.00' },
      { stage: 'LOST', count: 15, amount: '300.00' },
    ]);
    expect(report.conversions).toEqual([
      { from: 'LEAD', to: 'QUALIFIED', rate: 0.5 },
      { from: 'QUALIFIED', to: 'PROPOSAL', rate: 0.4 },
      { from: 'PROPOSAL', to: 'WON', rate: 0.25 },
    ]);
  });

  it('reports a zero rate instead of dividing by zero', async () => {
    const harness = createHarness();
    harness.dealGroupBy.mockImplementation(async () => [
      { stage: 'WON', _count: { _all: 3 }, _sum: { amount: null } },
    ]);
    const service = createAnalyticsService(harness.db, createRecordingCache());

    const report = await service.dealFunnel(range);

    expect(report.stages).toEqual([
      { stage: 'LEAD', count: 0, amount: '0.00' },
      { stage: 'QUALIFIED', count: 0, amount: '0.00' },
      { stage: 'PROPOSAL', count: 0, amount: '0.00' },
      { stage: 'WON', count: 3, amount: '0.00' },
      { stage: 'LOST', count: 0, amount: '0.00' },
    ]);
    // Every denominator is zero here, so no rate is NaN or Infinity.
    expect(report.conversions.map((entry) => entry.rate)).toEqual([0, 0, 0]);
  });

  it('excludes soft-deleted deals', async () => {
    const harness = createHarness();
    const service = createAnalyticsService(harness.db, createRecordingCache());

    await service.dealFunnel({ ...range, ownerId: '10000000-0000-4000-8000-000000000001' });

    const args = harness.dealGroupBy.mock.calls[0]?.[0] as {
      where: { deletedAt: null; ownerId: string; createdAt: { gte: Date; lt: Date } };
    };
    expect(args.where.deletedAt).toBeNull();
    expect(args.where.ownerId).toBe('10000000-0000-4000-8000-000000000001');
    expect(args.where.createdAt.gte).toEqual(new Date(range.from));
    expect(args.where.createdAt.lt).toEqual(new Date(range.to));
  });
});

describe('analytics top products', () => {
  it('joins the catalogue labels onto the aggregated rows', async () => {
    const harness = createHarness();
    harness.orderItemGroupBy.mockImplementation(async () => [
      { productId: 'p1', _sum: { quantity: 12, lineTotal: decimal('1200.5') } },
      { productId: 'p2', _sum: { quantity: 3, lineTotal: null } },
    ]);
    harness.productFindMany.mockImplementation(async () => [
      { id: 'p1', sku: 'SKU-1', name: 'Widget' },
    ]);
    const service = createAnalyticsService(harness.db, createRecordingCache());

    const report = await service.topProducts({ ...range, limit: 5 });

    expect(report.items).toEqual([
      { productId: 'p1', sku: 'SKU-1', name: 'Widget', quantity: 12, revenue: '1200.50' },
      { productId: 'p2', sku: '', name: '', quantity: 3, revenue: '0.00' },
    ]);
    expect(report.limit).toBe(5);
  });

  it('passes the bounded limit and the exclusion rules to Prisma', async () => {
    const harness = createHarness();
    const service = createAnalyticsService(harness.db, createRecordingCache());

    await service.topProducts({ ...range, limit: 7 });

    const args = harness.orderItemGroupBy.mock.calls[0]?.[0] as {
      take: number;
      where: { order: { deletedAt: null; status: { not: string } } };
    };
    expect(args.take).toBe(7);
    expect(args.where.order.deletedAt).toBeNull();
    expect(args.where.order.status).toEqual({ not: 'CANCELLED' });
  });

  it('skips the catalogue lookup when nothing was sold', async () => {
    const harness = createHarness();
    const service = createAnalyticsService(harness.db, createRecordingCache());

    const report = await service.topProducts({ ...range, limit: 10 });
    expect(report.items).toEqual([]);
    expect(harness.productFindMany).not.toHaveBeenCalled();
  });
});

describe('analytics owner performance', () => {
  it('merges deal and order totals per owner', async () => {
    const harness = createHarness();
    harness.dealGroupBy
      .mockImplementationOnce(async () => [
        { ownerId: 'u1', _count: { _all: 8 }, _sum: { amount: decimal('4000') } },
        { ownerId: 'u2', _count: { _all: 2 }, _sum: { amount: decimal('500') } },
      ])
      .mockImplementationOnce(async () => [
        { ownerId: 'u1', _count: { _all: 2 }, _sum: { amount: decimal('1000') } },
      ]);
    harness.orderGroupBy.mockImplementation(async () => [
      { ownerId: 'u1', _count: { _all: 3 }, _sum: { total: decimal('300.25') } },
      { ownerId: 'u2', _count: { _all: 4 }, _sum: { total: decimal('900.75') } },
    ]);
    harness.userFindMany.mockImplementation(async () => [
      { id: 'u1', name: 'Ann', email: 'ann@example.com' },
    ]);
    const service = createAnalyticsService(harness.db, createRecordingCache());

    const report = await service.ownerPerformance({ ...range, limit: 10 });

    // Ordered by order revenue, so the unnamed owner comes first.
    expect(report.items).toEqual([
      {
        ownerId: 'u2',
        name: null,
        email: null,
        dealCount: 2,
        dealAmount: '500.00',
        wonDealCount: 0,
        wonDealAmount: '0.00',
        winRate: 0,
        orderCount: 4,
        orderRevenue: '900.75',
      },
      {
        ownerId: 'u1',
        name: 'Ann',
        email: 'ann@example.com',
        dealCount: 8,
        dealAmount: '4000.00',
        wonDealCount: 2,
        wonDealAmount: '1000.00',
        winRate: 0.25,
        orderCount: 3,
        orderRevenue: '300.25',
      },
    ]);
  });

  it('applies the limit after merging', async () => {
    const harness = createHarness();
    harness.dealGroupBy.mockImplementation(async () => [
      { ownerId: 'u1', _count: { _all: 1 }, _sum: { amount: null } },
      { ownerId: 'u2', _count: { _all: 1 }, _sum: { amount: null } },
    ]);
    const service = createAnalyticsService(harness.db, createRecordingCache());

    const report = await service.ownerPerformance({ ...range, limit: 1 });
    expect(report.items).toHaveLength(1);
  });
});

describe('analytics stock health', () => {
  it('maps the rows and binds the threshold and limit as parameters', async () => {
    const harness = createHarness();
    harness.queryRaw.mockImplementation(async () => [
      {
        product_id: 'p1',
        sku: 'SKU-1',
        name: 'Widget',
        warehouse_id: 'w1',
        warehouse_code: 'CENTRAL',
        quantity_on_hand: 4,
        quantity_reserved: 3,
        quantity_available: 1,
      },
    ]);
    const service = createAnalyticsService(harness.db, createRecordingCache());

    const report = await service.stockHealth({ threshold: 5, limit: 20 });

    expect(report.items).toEqual([
      {
        productId: 'p1',
        sku: 'SKU-1',
        name: 'Widget',
        warehouseId: 'w1',
        warehouseCode: 'CENTRAL',
        quantityOnHand: 4,
        quantityReserved: 3,
        quantityAvailable: 1,
      },
    ]);

    const sql = lastSql(harness.queryRaw);
    expect(sql.values).toEqual(expect.arrayContaining([5, 20]));
    expect(sql.strings.join('')).toContain('p.deleted_at IS NULL');
  });

  it('binds an optional warehouse filter instead of interpolating it', async () => {
    const harness = createHarness();
    const service = createAnalyticsService(harness.db, createRecordingCache());
    const warehouseId = '20000000-0000-4000-8000-000000000001';

    await service.stockHealth({ threshold: 0, limit: 10, warehouseId });

    const sql = lastSql(harness.queryRaw);
    expect(sql.strings.join('')).not.toContain(warehouseId);
    expect(sql.values).toContain(warehouseId);
  });
});
