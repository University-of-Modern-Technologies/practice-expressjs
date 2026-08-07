import { Router, type RequestHandler } from 'express';

import { validate } from '../../common/middleware/validate.js';
import type { WarehouseController } from './controller.js';
import {
  adjustStockSchema,
  createWarehouseSchema,
  getWarehouseSchema,
  getStockSchema,
  issueStockSchema,
  listMovementsSchema,
  listStockSchema,
  listWarehousesSchema,
  receiveStockSchema,
  releaseStockSchema,
  reserveStockSchema,
  updateWarehouseSchema,
} from './validation.js';

/**
 * Movements are append-only by design: the router exposes no update or delete
 * verb for them, so the ledger can only ever grow. A mistake is corrected by
 * recording a compensating adjustment, never by rewriting history.
 */
export const createWarehouseRouter = (
  controller: WarehouseController,
  authenticate: RequestHandler,
): Router => {
  const router = Router();
  router.use(authenticate);

  router.get('/warehouses', validate(listWarehousesSchema), controller.listWarehouses);
  router.get('/warehouses/:id', validate(getWarehouseSchema), controller.getWarehouse);
  router.post('/warehouses', validate(createWarehouseSchema), controller.createWarehouse);
  router.patch('/warehouses/:id', validate(updateWarehouseSchema), controller.updateWarehouse);

  router.get('/stock', validate(listStockSchema), controller.listStock);
  router.get('/stock/:warehouseId/:productId', validate(getStockSchema), controller.getStock);
  router.post('/stock/receive', validate(receiveStockSchema), controller.receive);
  router.post('/stock/issue', validate(issueStockSchema), controller.issue);
  router.post('/stock/reserve', validate(reserveStockSchema), controller.reserve);
  router.post('/stock/release', validate(releaseStockSchema), controller.release);
  router.post('/stock/adjust', validate(adjustStockSchema), controller.adjust);

  router.get('/movements', validate(listMovementsSchema), controller.listMovements);

  return router;
};
