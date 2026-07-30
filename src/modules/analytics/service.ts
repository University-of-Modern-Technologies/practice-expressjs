import { createNoopCacheService, type CacheService } from '../../cache/cache.service.js';
import { Prisma, type PrismaDatabase } from '../../db/prisma.js';
import { dealStages, type DealStage } from '../deals/types.js';
import { analyticsReportKey } from './cache-keys.js';
import {
  averageDecimal,
  compareDecimals,
  formatDecimal,
  ratio,
  sumDecimals,
  type DecimalInput,
} from './decimal.js';
import type {
  DealFunnelConversion,
  DealFunnelQuery,
  DealFunnelReport,
  DealFunnelStage,
  OwnerPerformanceQuery,
  OwnerPerformanceReport,
  OwnerPerformanceRow,
  SalesSummaryBucket,
  SalesSummaryQuery,
  SalesSummaryReport,
  StockHealthQuery,
  StockHealthReport,
  StockHealthRow,
  TopProductsQuery,
  TopProductsReport,
  TopProductRow,
} from './types.js';

/**
 * Read-only reporting over the operational tables. This module never writes:
 * there is no mutating method here and no route that could reach one.
 *
 * Two exclusion rules apply to every report and are repeated at each query so
 * the behaviour is discoverable from the query itself:
 *   1. soft-deleted rows (`deletedAt IS NOT NULL`) are invisible;
 *   2. cancelled orders never contribute to revenue or product rankings.
 *
 * An order is dated by `placedAt` and falls back to `createdAt` while it is
 * still a draft, so a range filter always has a timestamp to work with.
 */

export type AnalyticsDatabase = Pick<
  PrismaDatabase,
  '$queryRaw' | 'deal' | 'order' | 'orderItem' | 'product' | 'user'
>;

export interface AnalyticsService {
  salesSummary(query: SalesSummaryQuery): Promise<SalesSummaryReport>;
  dealFunnel(query: DealFunnelQuery): Promise<DealFunnelReport>;
  topProducts(query: TopProductsQuery): Promise<TopProductsReport>;
  ownerPerformance(query: OwnerPerformanceQuery): Promise<OwnerPerformanceReport>;
  stockHealth(query: StockHealthQuery): Promise<StockHealthReport>;
}

/**
 * These are the slow queries of the system, so every report is cached.
 *
 * Invalidation story, stated honestly: entries are NOT dropped when an order,
 * deal or stock level changes. Doing so would mean invalidating a key space
 * that depends on caller-chosen date ranges, and the write path would have to
 * know about every report. Reports expire on time instead, which means a report
 * may lag behind the database by at most the TTL below. That trade is
 * acceptable for aggregate reporting and unacceptable for anything
 * transactional, which is why nothing transactional is served from here.
 */
const DEFAULT_ANALYTICS_TTL_SECONDS = 60;

const FUNNEL_PIPELINE: readonly DealStage[] = ['LEAD', 'QUALIFIED', 'PROPOSAL', 'WON'];

interface SalesSummaryRow {
  readonly bucket_start: Date | string;
  readonly order_count: number;
  readonly revenue: string;
}

interface StockHealthQueryRow {
  readonly product_id: string;
  readonly sku: string;
  readonly name: string;
  readonly warehouse_id: string;
  readonly warehouse_code: string;
  readonly quantity_on_hand: number;
  readonly quantity_reserved: number;
  readonly quantity_available: number;
}

const toIsoString = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const toCount = (value: number | bigint | null | undefined): number => Number(value ?? 0);

// A draft order has no `placedAt` yet, so it is dated by `createdAt` instead.
const orderDateFilter = (from: Date, to: Date): Prisma.OrderWhereInput => ({
  OR: [{ placedAt: { gte: from, lt: to } }, { placedAt: null, createdAt: { gte: from, lt: to } }],
});

/**
 * @param db          Prisma client, or any object exposing the members used here.
 * @param cache       Injectable so tests need no Redis; the no-op fallback turns
 *                    every read into a miss and discards every write.
 * @param ttlSeconds  Lifetime of a cached report; see the note above.
 */
export const createAnalyticsService = (
  db: AnalyticsDatabase,
  cache: CacheService = createNoopCacheService(),
  ttlSeconds: number = DEFAULT_ANALYTICS_TTL_SECONDS,
): AnalyticsService => {
  // A cache outage must only cost latency. The loader runs at most once, so a
  // genuine database failure still surfaces to the caller.
  const rememberSafely = async <T>(key: string, loader: () => Promise<T>): Promise<T> => {
    let loaderRan = false;
    const guarded = async (): Promise<T> => {
      loaderRan = true;
      return loader();
    };
    try {
      return await cache.remember(key, ttlSeconds, guarded);
    } catch (error) {
      if (loaderRan) throw error;
      return loader();
    }
  };

  return {
    async salesSummary(query) {
      const key = analyticsReportKey('sales-summary', {
        from: query.from,
        to: query.to,
        period: query.period,
        ownerId: query.ownerId,
      });

      return rememberSafely(key, async () => {
        const from = new Date(query.from);
        const to = new Date(query.to);
        // Every value below is bound by Prisma's tagged template, including the
        // bucket width: user input is never concatenated into SQL.
        const ownerFilter = query.ownerId
          ? Prisma.sql`AND o.owner_id = ${query.ownerId}::uuid`
          : Prisma.empty;

        const rows = await db.$queryRaw<SalesSummaryRow[]>(Prisma.sql`
          SELECT date_trunc(${query.period}::text, COALESCE(o.placed_at, o.created_at)) AS bucket_start,
                 COUNT(*)::int AS order_count,
                 COALESCE(SUM(o.total), 0)::text AS revenue
          FROM orders o
          WHERE o.deleted_at IS NULL
            AND o.status <> 'CANCELLED'
            AND COALESCE(o.placed_at, o.created_at) >= ${from}
            AND COALESCE(o.placed_at, o.created_at) < ${to}
            ${ownerFilter}
          GROUP BY 1
          ORDER BY 1 ASC
        `);

        const series: SalesSummaryBucket[] = rows.map((row) => ({
          bucketStart: toIsoString(row.bucket_start),
          orderCount: toCount(row.order_count),
          revenue: formatDecimal(row.revenue),
        }));

        const orderCount = series.reduce((total, bucket) => total + bucket.orderCount, 0);
        const revenue = sumDecimals(series.map((bucket) => bucket.revenue));

        return {
          from: query.from,
          to: query.to,
          period: query.period,
          totals: {
            orderCount,
            revenue,
            averageOrderValue: averageDecimal(revenue, orderCount),
          },
          series,
        } satisfies SalesSummaryReport;
      });
    },

    async dealFunnel(query) {
      const key = analyticsReportKey('deal-funnel', {
        from: query.from,
        to: query.to,
        ownerId: query.ownerId,
      });

      return rememberSafely(key, async () => {
        const groups = await db.deal.groupBy({
          by: ['stage'],
          where: {
            // Soft-deleted deals are excluded from every funnel figure.
            deletedAt: null,
            createdAt: { gte: new Date(query.from), lt: new Date(query.to) },
            ...(query.ownerId ? { ownerId: query.ownerId } : {}),
          },
          _count: { _all: true },
          _sum: { amount: true },
        });

        const byStage = new Map<DealStage, { count: number; amount: DecimalInput }>(
          groups.map((group) => [
            group.stage as DealStage,
            { count: toCount(group._count._all), amount: group._sum.amount },
          ]),
        );

        const stages: DealFunnelStage[] = dealStages.map((stage) => {
          const entry = byStage.get(stage);
          return {
            stage,
            count: entry?.count ?? 0,
            amount: formatDecimal(entry?.amount),
          };
        });
        const countByStage = new Map(stages.map((entry) => [entry.stage, entry.count]));

        // Conversion is measured along the winning pipeline only; LOST is a
        // terminal stage and is reported as a bucket, never as a step.
        const conversions: DealFunnelConversion[] = [];
        for (let index = 0; index < FUNNEL_PIPELINE.length - 1; index += 1) {
          const source = FUNNEL_PIPELINE[index];
          const target = FUNNEL_PIPELINE[index + 1];
          if (!source || !target) continue;
          conversions.push({
            from: source,
            to: target,
            // An empty source stage yields 0 rather than NaN or Infinity.
            rate: ratio(countByStage.get(target) ?? 0, countByStage.get(source) ?? 0),
          });
        }

        return {
          from: query.from,
          to: query.to,
          stages,
          conversions,
        } satisfies DealFunnelReport;
      });
    },

    async topProducts(query) {
      const key = analyticsReportKey('top-products', {
        from: query.from,
        to: query.to,
        limit: query.limit,
      });

      return rememberSafely(key, async () => {
        const groups = await db.orderItem.groupBy({
          by: ['productId'],
          where: {
            order: {
              // Cancelled and soft-deleted orders never count as sales.
              deletedAt: null,
              status: { not: 'CANCELLED' },
              ...orderDateFilter(new Date(query.from), new Date(query.to)),
            },
          },
          _sum: { quantity: true, lineTotal: true },
          orderBy: { _sum: { lineTotal: 'desc' } },
          take: query.limit,
        });

        const productIds = groups.map((group) => group.productId);
        // Products removed from the catalogue after the sale are still labelled,
        // otherwise historic revenue would lose its name.
        const products = productIds.length
          ? await db.product.findMany({
              where: { id: { in: productIds } },
              select: { id: true, sku: true, name: true },
            })
          : [];
        const byId = new Map(products.map((product) => [product.id, product]));

        const items: TopProductRow[] = groups.map((group) => {
          const product = byId.get(group.productId);
          return {
            productId: group.productId,
            sku: product?.sku ?? '',
            name: product?.name ?? '',
            quantity: toCount(group._sum.quantity),
            revenue: formatDecimal(group._sum.lineTotal),
          };
        });

        return {
          from: query.from,
          to: query.to,
          limit: query.limit,
          items,
        } satisfies TopProductsReport;
      });
    },

    async ownerPerformance(query) {
      const key = analyticsReportKey('owner-performance', {
        from: query.from,
        to: query.to,
        limit: query.limit,
      });

      return rememberSafely(key, async () => {
        const from = new Date(query.from);
        const to = new Date(query.to);
        const dealWhere = { deletedAt: null, createdAt: { gte: from, lt: to } };

        const [dealGroups, wonGroups, orderGroups] = await Promise.all([
          db.deal.groupBy({
            by: ['ownerId'],
            where: dealWhere,
            _count: { _all: true },
            _sum: { amount: true },
          }),
          db.deal.groupBy({
            by: ['ownerId'],
            where: { ...dealWhere, stage: 'WON' },
            _count: { _all: true },
            _sum: { amount: true },
          }),
          db.order.groupBy({
            by: ['ownerId'],
            where: {
              deletedAt: null,
              status: { not: 'CANCELLED' },
              ...orderDateFilter(from, to),
            },
            _count: { _all: true },
            _sum: { total: true },
          }),
        ]);

        const ownerIds = [
          ...new Set([
            ...dealGroups.map((group) => group.ownerId),
            ...orderGroups.map((group) => group.ownerId),
          ]),
        ];
        const owners = ownerIds.length
          ? await db.user.findMany({
              where: { id: { in: ownerIds } },
              select: { id: true, name: true, email: true },
            })
          : [];
        const ownerById = new Map(owners.map((owner) => [owner.id, owner]));
        const wonById = new Map(wonGroups.map((group) => [group.ownerId, group]));
        const dealById = new Map(dealGroups.map((group) => [group.ownerId, group]));
        const orderById = new Map(orderGroups.map((group) => [group.ownerId, group]));

        const items: OwnerPerformanceRow[] = ownerIds
          .map((ownerId) => {
            const deals = dealById.get(ownerId);
            const won = wonById.get(ownerId);
            const orders = orderById.get(ownerId);
            const owner = ownerById.get(ownerId);
            const dealCount = toCount(deals?._count._all);
            const wonDealCount = toCount(won?._count._all);
            return {
              ownerId,
              name: owner?.name ?? null,
              email: owner?.email ?? null,
              dealCount,
              dealAmount: formatDecimal(deals?._sum.amount),
              wonDealCount,
              wonDealAmount: formatDecimal(won?._sum.amount),
              winRate: ratio(wonDealCount, dealCount),
              orderCount: toCount(orders?._count._all),
              orderRevenue: formatDecimal(orders?._sum.total),
            };
          })
          .sort((left, right) => compareDecimals(right.orderRevenue, left.orderRevenue))
          .slice(0, query.limit);

        return { from: query.from, to: query.to, items } satisfies OwnerPerformanceReport;
      });
    },

    async stockHealth(query) {
      const key = analyticsReportKey('stock-health', {
        threshold: query.threshold,
        limit: query.limit,
        warehouseId: query.warehouseId,
      });

      return rememberSafely(key, async () => {
        const warehouseFilter = query.warehouseId
          ? Prisma.sql`AND sl.warehouse_id = ${query.warehouseId}::uuid`
          : Prisma.empty;

        // Threshold and limit are bound parameters, never interpolated text.
        const rows = await db.$queryRaw<StockHealthQueryRow[]>(Prisma.sql`
          SELECT p.id AS product_id,
                 p.sku AS sku,
                 p.name AS name,
                 w.id AS warehouse_id,
                 w.code AS warehouse_code,
                 sl.quantity_on_hand AS quantity_on_hand,
                 sl.quantity_reserved AS quantity_reserved,
                 (sl.quantity_on_hand - sl.quantity_reserved) AS quantity_available
          FROM stock_levels sl
          JOIN products p ON p.id = sl.product_id
          JOIN warehouses w ON w.id = sl.warehouse_id
          WHERE p.deleted_at IS NULL
            AND p.is_active = TRUE
            AND (sl.quantity_on_hand - sl.quantity_reserved) <= ${query.threshold}
            ${warehouseFilter}
          ORDER BY quantity_available ASC, p.sku ASC
          LIMIT ${query.limit}
        `);

        const items: StockHealthRow[] = rows.map((row) => ({
          productId: row.product_id,
          sku: row.sku,
          name: row.name,
          warehouseId: row.warehouse_id,
          warehouseCode: row.warehouse_code,
          quantityOnHand: toCount(row.quantity_on_hand),
          quantityReserved: toCount(row.quantity_reserved),
          quantityAvailable: toCount(row.quantity_available),
        }));

        return {
          threshold: query.threshold,
          limit: query.limit,
          items,
        } satisfies StockHealthReport;
      });
    },
  };
};
