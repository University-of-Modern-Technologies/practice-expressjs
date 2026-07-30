import type { z } from 'zod';

import type { AnalyticsService } from '../service.js';
import type {
  DealFunnelReport,
  DealFunnelStage,
  OwnerPerformanceReport,
  OwnerPerformanceRow,
  SalesSummaryBucket,
  SalesSummaryReport,
  StockHealthReport,
  StockHealthRow,
  TopProductRow,
  TopProductsReport,
} from '../types.js';
import {
  dealFunnelSchema,
  ownerPerformanceSchema,
  salesSummarySchema,
  stockHealthSchema,
  topProductsSchema,
} from '../validation.js';
import type { ErasedExportColumn, ExportColumn } from './types.js';

/**
 * What one report exports, decoupled from how it is rendered. A descriptor
 * names the file, validates the same query the JSON endpoint accepts, and
 * says how to turn the report it gets back into a flat table. Adding a sixth
 * report or a third format never touches this shape, only adds one entry.
 */
export interface AnalyticsExportDescriptor {
  readonly fileStem: string;
  readonly columns: readonly ErasedExportColumn[];
  readonly loadRows: (
    service: AnalyticsService,
    rawQuery: unknown,
  ) => Promise<
    | { readonly ok: true; readonly rows: readonly unknown[] }
    | { readonly ok: false; readonly details: unknown }
  >;
}

interface DescriptorConfig<Query, Report, Row> {
  readonly fileStem: string;
  readonly schema: z.ZodType<{ query: Query }>;
  readonly run: (service: AnalyticsService, query: Query) => Promise<Report>;
  readonly columns: readonly ExportColumn<Row>[];
  readonly rows: (report: Report) => readonly Row[];
}

// The row type of each report is only known here, at the point a descriptor
// is assembled; every descriptor is stored afterwards with that type erased,
// so this is the one place the erasure happens rather than at every call site.
const defineDescriptor = <Query, Report, Row>(
  config: DescriptorConfig<Query, Report, Row>,
): AnalyticsExportDescriptor => ({
  fileStem: config.fileStem,
  columns: config.columns as unknown as readonly ErasedExportColumn[],
  loadRows: async (service, rawQuery) => {
    const parsed = config.schema.safeParse({ query: rawQuery });
    if (!parsed.success) return { ok: false, details: parsed.error.flatten() };
    const report = await config.run(service, parsed.data.query);
    return { ok: true, rows: config.rows(report) };
  },
});

const salesSummaryDescriptor = defineDescriptor<
  z.infer<typeof salesSummarySchema>['query'],
  SalesSummaryReport,
  SalesSummaryBucket
>({
  fileStem: 'sales-summary',
  schema: salesSummarySchema,
  run: (service, query) => service.salesSummary(query),
  rows: (report) => report.series,
  columns: [
    { key: 'bucketStart', get: (row) => row.bucketStart },
    { key: 'orderCount', get: (row) => row.orderCount },
    { key: 'revenue', get: (row) => row.revenue },
  ],
});

const dealFunnelDescriptor = defineDescriptor<
  z.infer<typeof dealFunnelSchema>['query'],
  DealFunnelReport,
  DealFunnelStage
>({
  fileStem: 'deal-funnel',
  schema: dealFunnelSchema,
  run: (service, query) => service.dealFunnel(query),
  rows: (report) => report.stages,
  columns: [
    { key: 'stage', get: (row) => row.stage },
    { key: 'count', get: (row) => row.count },
    { key: 'amount', get: (row) => row.amount },
  ],
});

const topProductsDescriptor = defineDescriptor<
  z.infer<typeof topProductsSchema>['query'],
  TopProductsReport,
  TopProductRow
>({
  fileStem: 'top-products',
  schema: topProductsSchema,
  run: (service, query) => service.topProducts(query),
  rows: (report) => report.items,
  columns: [
    { key: 'productId', get: (row) => row.productId },
    { key: 'sku', get: (row) => row.sku },
    { key: 'name', get: (row) => row.name },
    { key: 'quantity', get: (row) => row.quantity },
    { key: 'revenue', get: (row) => row.revenue },
  ],
});

const ownerPerformanceDescriptor = defineDescriptor<
  z.infer<typeof ownerPerformanceSchema>['query'],
  OwnerPerformanceReport,
  OwnerPerformanceRow
>({
  fileStem: 'owner-performance',
  schema: ownerPerformanceSchema,
  run: (service, query) => service.ownerPerformance(query),
  rows: (report) => report.items,
  columns: [
    { key: 'ownerId', get: (row) => row.ownerId },
    { key: 'name', get: (row) => row.name },
    { key: 'email', get: (row) => row.email },
    { key: 'dealCount', get: (row) => row.dealCount },
    { key: 'dealAmount', get: (row) => row.dealAmount },
    { key: 'wonDealCount', get: (row) => row.wonDealCount },
    { key: 'wonDealAmount', get: (row) => row.wonDealAmount },
    { key: 'winRate', get: (row) => row.winRate },
    { key: 'orderCount', get: (row) => row.orderCount },
    { key: 'orderRevenue', get: (row) => row.orderRevenue },
  ],
});

const stockHealthDescriptor = defineDescriptor<
  z.infer<typeof stockHealthSchema>['query'],
  StockHealthReport,
  StockHealthRow
>({
  fileStem: 'stock-health',
  schema: stockHealthSchema,
  run: (service, query) => service.stockHealth(query),
  rows: (report) => report.items,
  columns: [
    { key: 'productId', get: (row) => row.productId },
    { key: 'sku', get: (row) => row.sku },
    { key: 'name', get: (row) => row.name },
    { key: 'warehouseId', get: (row) => row.warehouseId },
    { key: 'warehouseCode', get: (row) => row.warehouseCode },
    { key: 'quantityOnHand', get: (row) => row.quantityOnHand },
    { key: 'quantityReserved', get: (row) => row.quantityReserved },
    { key: 'quantityAvailable', get: (row) => row.quantityAvailable },
  ],
});

/** Keyed by the same kebab-case segment the JSON routes already use. */
export const analyticsExportDescriptors: Readonly<Record<string, AnalyticsExportDescriptor>> = {
  'sales-summary': salesSummaryDescriptor,
  'deal-funnel': dealFunnelDescriptor,
  'top-products': topProductsDescriptor,
  'owner-performance': ownerPerformanceDescriptor,
  'stock-health': stockHealthDescriptor,
};
