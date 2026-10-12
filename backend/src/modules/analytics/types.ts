import { z } from 'zod';

import { decimalStringSchema } from '../../common/openapi/index.js';
import { dealStageSchema } from '../deals/types.js';

export const analyticsPeriods = ['day', 'week', 'month'] as const;
export type AnalyticsPeriod = (typeof analyticsPeriods)[number];

/** Half-open interval `[from, to)`, both normalised to ISO 8601 UTC strings. */
export interface DateRange {
  readonly from: string;
  readonly to: string;
}

export interface SalesSummaryQuery extends DateRange {
  readonly period: AnalyticsPeriod;
  readonly ownerId?: string | undefined;
}

// Report bounds and bucket starts are ISO 8601 strings, not dates: a report is
// cached as JSON and must read back exactly as it was produced.
const instant = z.iso.datetime();
const count = z.int().min(0);

export const salesSummaryBucketSchema = z.object({
  bucketStart: instant,
  orderCount: count,
  revenue: decimalStringSchema,
});

export type SalesSummaryBucket = Readonly<z.infer<typeof salesSummaryBucketSchema>>;

export const salesSummaryReportSchema = z
  .object({
    from: instant,
    to: instant,
    period: z.enum(analyticsPeriods),
    totals: z.object({
      orderCount: count,
      revenue: decimalStringSchema,
      averageOrderValue: decimalStringSchema,
    }),
    series: z.array(salesSummaryBucketSchema),
  })
  .meta({ id: 'SalesSummaryReport' });

export type SalesSummaryReport = Readonly<z.infer<typeof salesSummaryReportSchema>>;

export interface DealFunnelQuery extends DateRange {
  readonly ownerId?: string | undefined;
}

export const dealFunnelStageSchema = z.object({
  stage: dealStageSchema,
  count,
  amount: decimalStringSchema,
});

export type DealFunnelStage = Readonly<z.infer<typeof dealFunnelStageSchema>>;

const dealFunnelConversionSchema = z.object({
  from: dealStageSchema,
  to: dealStageSchema,
  // 0 when the source stage is empty.
  rate: z
    .number()
    .min(0)
    .max(1)
    .meta({ description: 'Частка в діапазоні [0, 1], округлена до чотирьох знаків.' }),
});

export type DealFunnelConversion = Readonly<z.infer<typeof dealFunnelConversionSchema>>;

export const dealFunnelReportSchema = z
  .object({
    from: instant,
    to: instant,
    stages: z.array(dealFunnelStageSchema),
    conversions: z.array(dealFunnelConversionSchema),
  })
  .meta({ id: 'DealFunnelReport' });

export type DealFunnelReport = Readonly<z.infer<typeof dealFunnelReportSchema>>;

export interface TopProductsQuery extends DateRange {
  readonly limit: number;
}

export const topProductRowSchema = z.object({
  productId: z.uuid(),
  sku: z.string(),
  name: z.string(),
  quantity: count,
  revenue: decimalStringSchema,
});

export type TopProductRow = Readonly<z.infer<typeof topProductRowSchema>>;

export const topProductsReportSchema = z
  .object({
    from: instant,
    to: instant,
    limit: z.int().min(1),
    items: z.array(topProductRowSchema),
  })
  .meta({ id: 'TopProductsReport' });

export type TopProductsReport = Readonly<z.infer<typeof topProductsReportSchema>>;

export interface OwnerPerformanceQuery extends DateRange {
  readonly limit: number;
}

export const ownerPerformanceRowSchema = z.object({
  ownerId: z.uuid(),
  name: z.string().nullable(),
  email: z.email().nullable(),
  dealCount: count,
  dealAmount: decimalStringSchema,
  wonDealCount: count,
  wonDealAmount: decimalStringSchema,
  winRate: z.number().min(0).max(1),
  orderCount: count,
  orderRevenue: decimalStringSchema,
});

export type OwnerPerformanceRow = Readonly<z.infer<typeof ownerPerformanceRowSchema>>;

export const ownerPerformanceReportSchema = z
  .object({
    from: instant,
    to: instant,
    items: z.array(ownerPerformanceRowSchema),
  })
  .meta({ id: 'OwnerPerformanceReport' });

export type OwnerPerformanceReport = Readonly<z.infer<typeof ownerPerformanceReportSchema>>;

export interface StockHealthQuery {
  readonly threshold: number;
  readonly limit: number;
  readonly warehouseId?: string | undefined;
}

export const stockHealthRowSchema = z.object({
  productId: z.uuid(),
  sku: z.string(),
  name: z.string(),
  warehouseId: z.uuid(),
  warehouseCode: z.string(),
  quantityOnHand: z.int(),
  quantityReserved: z.int(),
  quantityAvailable: z.int(),
});

export type StockHealthRow = Readonly<z.infer<typeof stockHealthRowSchema>>;

export const stockHealthReportSchema = z
  .object({
    threshold: count,
    limit: z.int().min(1),
    items: z.array(stockHealthRowSchema),
  })
  .meta({ id: 'StockHealthReport' });

export type StockHealthReport = Readonly<z.infer<typeof stockHealthReportSchema>>;
