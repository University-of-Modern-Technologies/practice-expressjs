import { Router, type RequestHandler } from 'express';

import { validate } from '../../common/middleware/validate.js';
import { requirePermission } from '../rbac/middleware.js';
import type { RbacService } from '../rbac/service.js';
import type { AnalyticsController } from './controller.js';
import {
  dealFunnelSchema,
  ownerPerformanceSchema,
  salesSummarySchema,
  stockHealthSchema,
  topProductsSchema,
} from './validation.js';

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

  router.get('/sales-summary', validate(salesSummarySchema), controller.salesSummary);
  router.get('/deal-funnel', validate(dealFunnelSchema), controller.dealFunnel);
  router.get('/top-products', validate(topProductsSchema), controller.topProducts);
  router.get('/owner-performance', validate(ownerPerformanceSchema), controller.ownerPerformance);
  router.get('/stock-health', validate(stockHealthSchema), controller.stockHealth);

  // `:report` covers all five reports at once, so the permission above already
  // guards the export the same way it guards the report itself; the query is
  // validated inside the controller, per report, since the schema to apply
  // depends on which report the path segment names.
  router.get('/:report/export', controller.exportReport);

  return router;
};
