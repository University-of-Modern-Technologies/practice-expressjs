import { describe, expect, it, jest } from '@jest/globals';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import request from 'supertest';

import { AppError } from '../../common/errors/app-error.js';
import { createAnalyticsController } from './controller.js';
import { createAnalyticsRouter } from './router.js';
import type { AnalyticsService } from './service.js';
import type {
  DealFunnelReport,
  OwnerPerformanceReport,
  SalesSummaryReport,
  StockHealthReport,
  TopProductsReport,
} from './types.js';

const emptySalesSummary: SalesSummaryReport = {
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-01-31T00:00:00.000Z',
  period: 'day',
  totals: { orderCount: 0, revenue: '0.00', averageOrderValue: '0.00' },
  series: [],
};

const salesSummaryWithRows: SalesSummaryReport = {
  ...emptySalesSummary,
  series: [
    { bucketStart: '2026-01-01T00:00:00.000Z', orderCount: 2, revenue: '1234.50' },
    // Exercises quoting: a comma inside a value and a name carrying a quote.
    { bucketStart: '2026-01-02T00:00:00.000Z', orderCount: 1, revenue: '0.00' },
  ],
};

const dealFunnelReport: DealFunnelReport = {
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-01-31T00:00:00.000Z',
  stages: [
    { stage: 'LEAD', count: 3, amount: '900.00' },
    { stage: 'QUALIFIED', count: 2, amount: '600.00' },
    { stage: 'PROPOSAL', count: 1, amount: '300.00' },
    { stage: 'WON', count: 1, amount: '300.00' },
    { stage: 'LOST', count: 0, amount: '0.00' },
  ],
  conversions: [
    { from: 'LEAD', to: 'QUALIFIED', rate: 0.6667 },
    { from: 'QUALIFIED', to: 'PROPOSAL', rate: 0.5 },
    { from: 'PROPOSAL', to: 'WON', rate: 1 },
  ],
};

const topProductsReport: TopProductsReport = {
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-01-31T00:00:00.000Z',
  limit: 10,
  items: [
    {
      productId: 'p-1',
      sku: 'SKU-1',
      // A comma and a double quote, both of which need RFC 4180 quoting.
      name: 'Widget, "Deluxe"',
      quantity: 5,
      revenue: '499.99',
    },
  ],
};

const ownerPerformanceReport: OwnerPerformanceReport = {
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-01-31T00:00:00.000Z',
  items: [
    {
      ownerId: 'o-1',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      dealCount: 4,
      dealAmount: '1000.00',
      wonDealCount: 2,
      wonDealAmount: '500.00',
      winRate: 0.5,
      orderCount: 3,
      orderRevenue: '750.25',
    },
  ],
};

const stockHealthReport: StockHealthReport = {
  threshold: 5,
  limit: 10,
  items: [
    {
      productId: 'p-1',
      sku: 'SKU-1',
      name: 'Widget',
      warehouseId: 'w-1',
      warehouseCode: 'MAIN',
      quantityOnHand: 3,
      quantityReserved: 1,
      quantityAvailable: 2,
    },
  ],
};

const createHarness = () => {
  const service: AnalyticsService = {
    salesSummary: jest.fn(async () => salesSummaryWithRows),
    dealFunnel: jest.fn(async () => dealFunnelReport),
    topProducts: jest.fn(async () => topProductsReport),
    ownerPerformance: jest.fn(async () => ownerPerformanceReport),
    stockHealth: jest.fn(async () => stockHealthReport),
  };

  const rbacService = { getPermissionScope: jest.fn(async () => 'ALL' as const) };
  const authenticate: RequestHandler = (req, _response, next) => {
    req.auth = { userId: '10000000-0000-4000-8000-000000000001', sessionId: 'session-1' };
    next();
  };
  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof AppError) {
      response
        .status(error.statusCode)
        .json({ error: { code: error.code, details: error.details } });
      return;
    }
    response.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR' } });
  };

  const controller = createAnalyticsController(service);
  const app = express()
    .use(
      '/api/v1/analytics',
      createAnalyticsRouter(
        controller,
        authenticate,
        // Only the one method the router calls is exercised here.
        rbacService as unknown as Parameters<typeof createAnalyticsRouter>[2],
      ),
    )
    .use(errorHandler);

  return { app, service };
};

describe('analytics report export', () => {
  it('exports sales-summary as CSV with money exactly as the JSON report renders it', async () => {
    const { app } = createHarness();

    const response = await request(app).get('/api/v1/analytics/sales-summary/export');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="sales-summary.csv"',
    );
    expect(response.text).toBe(
      'bucketStart,orderCount,revenue\r\n' +
        '2026-01-01T00:00:00.000Z,2,1234.50\r\n' +
        '2026-01-02T00:00:00.000Z,1,0.00\r\n',
    );
  });

  it('defaults to csv when format is not given', async () => {
    const { app } = createHarness();
    const response = await request(app).get('/api/v1/analytics/deal-funnel/export');
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
  });

  it('escapes a comma and a double quote per RFC 4180', async () => {
    const { app } = createHarness();

    const response = await request(app).get('/api/v1/analytics/top-products/export');

    expect(response.status).toBe(200);
    expect(response.text).toBe(
      'productId,sku,name,quantity,revenue\r\n' + 'p-1,SKU-1,"Widget, ""Deluxe""",5,499.99\r\n',
    );
  });

  it('produces only the header row for an empty report', async () => {
    const { app, service } = createHarness();
    jest.mocked(service.salesSummary).mockResolvedValueOnce(emptySalesSummary);

    const response = await request(app).get('/api/v1/analytics/sales-summary/export');

    expect(response.status).toBe(200);
    expect(response.text).toBe('bucketStart,orderCount,revenue\r\n');
  });

  it('exports as JSON, with the same money strings as the report, when format=json', async () => {
    const { app } = createHarness();

    const response = await request(app)
      .get('/api/v1/analytics/owner-performance/export')
      .query({ format: 'json' });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toEqual({
      data: [
        {
          ownerId: 'o-1',
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          dealCount: 4,
          dealAmount: '1000.00',
          wonDealCount: 2,
          wonDealAmount: '500.00',
          winRate: 0.5,
          orderCount: 3,
          orderRevenue: '750.25',
        },
      ],
    });
  });

  it('rejects an unknown report name in the existing validation envelope', async () => {
    const { app } = createHarness();

    const response = await request(app).get('/api/v1/analytics/not-a-report/export');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an unknown format in the existing validation envelope', async () => {
    const { app } = createHarness();

    const response = await request(app)
      .get('/api/v1/analytics/stock-health/export')
      .query({ format: 'xml' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('still validates the report-specific query, e.g. an out-of-range limit', async () => {
    const { app } = createHarness();

    const response = await request(app)
      .get('/api/v1/analytics/top-products/export')
      .query({ limit: 0 });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it.each([
    ['sales-summary', 'sales-summary.csv'],
    ['deal-funnel', 'deal-funnel.csv'],
    ['top-products', 'top-products.csv'],
    ['owner-performance', 'owner-performance.csv'],
    ['stock-health', 'stock-health.csv'],
  ])('exports %s as a downloadable CSV named %s', async (report, fileName) => {
    const { app } = createHarness();

    const response = await request(app).get(`/api/v1/analytics/${report}/export`);

    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toBe(`attachment; filename="${fileName}"`);
    expect(response.text.split('\r\n')[0]?.length).toBeGreaterThan(0);
  });

  it('carries stage rows for the deal funnel, not the derived conversions', async () => {
    const { app } = createHarness();

    const response = await request(app).get('/api/v1/analytics/deal-funnel/export');

    expect(response.text).toBe(
      'stage,count,amount\r\n' +
        'LEAD,3,900.00\r\n' +
        'QUALIFIED,2,600.00\r\n' +
        'PROPOSAL,1,300.00\r\n' +
        'WON,1,300.00\r\n' +
        'LOST,0,0.00\r\n',
    );
  });

  it('carries stock-health rows including the null-free quantity columns', async () => {
    const { app } = createHarness();

    const response = await request(app).get('/api/v1/analytics/stock-health/export');

    expect(response.text).toBe(
      'productId,sku,name,warehouseId,warehouseCode,quantityOnHand,quantityReserved,quantityAvailable\r\n' +
        'p-1,SKU-1,Widget,w-1,MAIN,3,1,2\r\n',
    );
  });
});
