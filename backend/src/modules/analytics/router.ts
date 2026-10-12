import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import { validate } from '../../common/middleware/validate.js';
import { describeRoutes, ok, okWith, refusals } from '../../common/openapi/index.js';
import {
  DEFAULT_REPORT_WINDOW_LABEL,
  MAX_REPORT_WINDOW_DAYS,
} from '../../common/reporting/index.js';
import { requirePermission } from '../rbac/middleware.js';
import type { RbacService } from '../rbac/service.js';
import { exportFormatSchema, type AnalyticsController } from './controller.js';
import { analyticsExportDescriptors } from './export/index.js';
import {
  dealFunnelReportSchema,
  ownerPerformanceReportSchema,
  salesSummaryReportSchema,
  stockHealthReportSchema,
  topProductsReportSchema,
} from './types.js';
import {
  dealFunnelSchema,
  ownerPerformanceSchema,
  salesSummarySchema,
  stockHealthSchema,
  topProductsSchema,
} from './validation.js';

const rangeNote =
  `Проміжок за замовчуванням — ${DEFAULT_REPORT_WINDOW_LABEL}; межі доби — за київським часом; ` +
  `\`from\` має бути раніше за \`to\`, ` +
  `а вікно не може перевищувати ${String(MAX_REPORT_WINDOW_DAYS)} днів.`;

const salesSummaryQuery = salesSummarySchema.shape.query.in.shape;
const stockHealthQuery = stockHealthSchema.shape.query.shape;

// One row of whichever report the path names, exactly as that report sends it.
const exportRowSchema = z.union(
  Object.values(analyticsExportDescriptors).map(({ rowSchema }) => rowSchema),
);

/**
 * The export route validates in the controller, against the schema of the
 * report its path names, so it has no single request schema of its own. The
 * parameters it accepts are the union of the reports' parameters plus `format`.
 */
const exportRequestSchema = z.object({
  params: z.object({ report: z.enum(Object.keys(analyticsExportDescriptors)) }),
  query: z.object({
    format: exportFormatSchema,
    from: salesSummaryQuery.from,
    to: salesSummaryQuery.to,
    period: salesSummaryQuery.period.meta({
      description: 'Застосовується лише до sales-summary.',
    }),
    limit: stockHealthQuery.limit,
    threshold: stockHealthQuery.threshold.meta({
      description: 'Застосовується лише до stock-health.',
    }),
    ownerId: salesSummaryQuery.ownerId.meta({
      description: 'Застосовується до sales-summary та deal-funnel.',
    }),
    warehouseId: stockHealthQuery.warehouseId.meta({
      description: 'Застосовується лише до stock-health.',
    }),
  }),
});

export const createAnalyticsRouter = (
  controller: AnalyticsController,
  authenticate: RequestHandler,
  rbacService: RbacService,
): Router => {
  const router = Router();
  router.use(authenticate);
  // Applied to the router rather than to each route, so a report added later
  // cannot accidentally be published without a permission check.
  router.use(requirePermission(rbacService, { resource: 'analytics', action: 'read' }));
  const routes = describeRoutes(router, [{ name: 'Analytics', description: 'Аналітичні звіти' }]);

  routes.get(
    '/sales-summary',
    {
      summary: 'Звіт про продажі за періодами',
      description:
        'Потребує дозволу `analytics:read`. Виторг і кількість замовлень, згруповані по днях, ' +
        `тижнях або місяцях. ${rangeNote}`,
      response: ok('Звіт про продажі', salesSummaryReportSchema),
      refusals: refusals(401, 403),
    },
    validate(salesSummarySchema),
    controller.salesSummary,
  );
  routes.get(
    '/deal-funnel',
    {
      summary: 'Воронка угод',
      description:
        'Потребує дозволу `analytics:read`. Кількість і сума угод за stage та конверсії між ' +
        `сусідніми stage. ${rangeNote}`,
      response: ok('Звіт по воронці угод', dealFunnelReportSchema),
      refusals: refusals(401, 403),
    },
    validate(dealFunnelSchema),
    controller.dealFunnel,
  );
  routes.get(
    '/top-products',
    {
      summary: 'Найпродаваніші товари',
      description: `Потребує дозволу \`analytics:read\`. Товари з найбільшим виторгом за проміжок. ${rangeNote}`,
      response: ok('Звіт по товарах', topProductsReportSchema),
      refusals: refusals(401, 403),
    },
    validate(topProductsSchema),
    controller.topProducts,
  );
  routes.get(
    '/owner-performance',
    {
      summary: 'Результати відповідальних',
      description:
        'Потребує дозволу `analytics:read`. Угоди, виграші та виторг у розрізі відповідальних. ' +
        rangeNote,
      response: ok('Звіт по відповідальних', ownerPerformanceReportSchema),
      refusals: refusals(401, 403),
    },
    validate(ownerPerformanceSchema),
    controller.ownerPerformance,
  );
  routes.get(
    '/stock-health',
    {
      summary: 'Стан запасів',
      description:
        'Потребує дозволу `analytics:read`. Позиції, доступний залишок яких не перевищує поріг. ' +
        'Значення `threshold` понад 1 000 000 обрізається. Проміжок дат не застосовується.',
      response: ok('Звіт про стан запасів', stockHealthReportSchema),
      refusals: refusals(401, 403),
    },
    validate(stockHealthSchema),
    controller.stockHealth,
  );

  // `:report` covers all five reports at once, so the permission above already
  // guards the export the same way it guards the report itself; the query is
  // validated inside the controller, per report, since the schema to apply
  // depends on which report the path segment names.
  routes.get(
    '/:report/export',
    {
      summary: 'Вивантаження звіту у CSV або JSON',
      description:
        'Потребує дозволу `analytics:read`. Приймає ті самі параметри, що й відповідний звіт, ' +
        'плюс `format`. `format=csv` (за замовчуванням) повертає `text/csv` з ' +
        '`Content-Disposition: attachment`; `format=json` повертає той самий набір рядків як масив.',
      request: exportRequestSchema,
      response: okWith({
        description: 'Рядки звіту у форматі CSV або JSON',
        content: {
          'text/csv': { schema: z.string() },
          'application/json': { schema: z.object({ data: z.array(exportRowSchema) }) },
        },
      }),
      refusals: refusals(401, 403),
    },
    controller.exportReport,
  );

  return router;
};
