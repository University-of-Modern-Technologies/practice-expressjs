import type { RequestHandler } from 'express';
import { z } from 'zod';

import { AppError } from '../../common/errors/app-error.js';
import { renderCsv } from './export/csv.js';
import { analyticsExportDescriptors } from './export/descriptors.js';
import { exportFormats } from './export/types.js';
import type { AnalyticsService } from './service.js';
import {
  dealFunnelSchema,
  ownerPerformanceSchema,
  salesSummarySchema,
  stockHealthSchema,
  topProductsSchema,
} from './validation.js';

export interface AnalyticsController {
  readonly salesSummary: RequestHandler;
  readonly dealFunnel: RequestHandler;
  readonly topProducts: RequestHandler;
  readonly ownerPerformance: RequestHandler;
  readonly stockHealth: RequestHandler;
  readonly exportReport: RequestHandler;
}

const invalid = (details: unknown): AppError =>
  new AppError('Invalid request', 400, 'VALIDATION_ERROR', details);

// `format` defaults to csv, matching the export contract; anything else that
// is not one of the two known formats is a validation error like any other
// rejected query parameter.
const exportFormatSchema = z.enum(exportFormats).default('csv');

// Reporting is read-only: every handler parses the query, runs one report and
// returns it. There is deliberately no mutating handler in this module.
export const createAnalyticsController = (service: AnalyticsService): AnalyticsController => ({
  salesSummary: async (request, response) => {
    const parsed = salesSummarySchema.safeParse({ query: request.query });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    response.json({ data: await service.salesSummary(parsed.data.query) });
  },

  dealFunnel: async (request, response) => {
    const parsed = dealFunnelSchema.safeParse({ query: request.query });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    response.json({ data: await service.dealFunnel(parsed.data.query) });
  },

  topProducts: async (request, response) => {
    const parsed = topProductsSchema.safeParse({ query: request.query });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    response.json({ data: await service.topProducts(parsed.data.query) });
  },

  ownerPerformance: async (request, response) => {
    const parsed = ownerPerformanceSchema.safeParse({ query: request.query });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    response.json({ data: await service.ownerPerformance(parsed.data.query) });
  },

  stockHealth: async (request, response) => {
    const parsed = stockHealthSchema.safeParse({ query: request.query });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    response.json({ data: await service.stockHealth(parsed.data.query) });
  },

  // One handler for all five reports: the descriptor named by `:report`
  // supplies the query schema, the service call and the column list, so a
  // sixth report needs a new descriptor entry and nothing here.
  exportReport: async (request, response) => {
    const reportName = typeof request.params.report === 'string' ? request.params.report : '';
    const descriptor = analyticsExportDescriptors[reportName];
    if (!descriptor) {
      throw invalid({ report: [`Unknown report "${reportName}"`] });
    }

    const formatParsed = exportFormatSchema.safeParse(request.query.format);
    if (!formatParsed.success) throw invalid(formatParsed.error.flatten());

    const outcome = await descriptor.loadRows(service, request.query);
    if (!outcome.ok) throw invalid(outcome.details);

    if (formatParsed.data === 'json') {
      response.json({ data: outcome.rows });
      return;
    }

    response
      .status(200)
      .set('Content-Type', 'text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="${descriptor.fileStem}.csv"`)
      .send(renderCsv(descriptor.columns, outcome.rows));
  },
});
