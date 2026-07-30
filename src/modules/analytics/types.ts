import type { DealStage } from '../deals/types.js';

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

export interface SalesSummaryBucket {
  readonly bucketStart: string;
  readonly orderCount: number;
  readonly revenue: string;
}

export interface SalesSummaryReport {
  readonly from: string;
  readonly to: string;
  readonly period: AnalyticsPeriod;
  readonly totals: {
    readonly orderCount: number;
    readonly revenue: string;
    readonly averageOrderValue: string;
  };
  readonly series: readonly SalesSummaryBucket[];
}

export interface DealFunnelQuery extends DateRange {
  readonly ownerId?: string | undefined;
}

export interface DealFunnelStage {
  readonly stage: DealStage;
  readonly count: number;
  readonly amount: string;
}

export interface DealFunnelConversion {
  readonly from: DealStage;
  readonly to: DealStage;
  /** Ratio in `[0, 1]`, rounded to four decimals; 0 when the source is empty. */
  readonly rate: number;
}

export interface DealFunnelReport {
  readonly from: string;
  readonly to: string;
  readonly stages: readonly DealFunnelStage[];
  readonly conversions: readonly DealFunnelConversion[];
}

export interface TopProductsQuery extends DateRange {
  readonly limit: number;
}

export interface TopProductRow {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly quantity: number;
  readonly revenue: string;
}

export interface TopProductsReport {
  readonly from: string;
  readonly to: string;
  readonly limit: number;
  readonly items: readonly TopProductRow[];
}

export interface OwnerPerformanceQuery extends DateRange {
  readonly limit: number;
}

export interface OwnerPerformanceRow {
  readonly ownerId: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly dealCount: number;
  readonly dealAmount: string;
  readonly wonDealCount: number;
  readonly wonDealAmount: string;
  readonly winRate: number;
  readonly orderCount: number;
  readonly orderRevenue: string;
}

export interface OwnerPerformanceReport {
  readonly from: string;
  readonly to: string;
  readonly items: readonly OwnerPerformanceRow[];
}

export interface StockHealthQuery {
  readonly threshold: number;
  readonly limit: number;
  readonly warehouseId?: string | undefined;
}

export interface StockHealthRow {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly warehouseId: string;
  readonly warehouseCode: string;
  readonly quantityOnHand: number;
  readonly quantityReserved: number;
  readonly quantityAvailable: number;
}

export interface StockHealthReport {
  readonly threshold: number;
  readonly limit: number;
  readonly items: readonly StockHealthRow[];
}
