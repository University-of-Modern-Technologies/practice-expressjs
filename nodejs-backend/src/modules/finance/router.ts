import { Router, type RequestHandler } from 'express';

import { validate } from '../../common/middleware/validate.js';
import type { FinanceController } from './controller.js';
import {
  financeSummarySchema,
  getTransactionSchema,
  importStatementSchema,
  listStatementsSchema,
  listTransactionsSchema,
  matchTransactionSchema,
  reconcileSchema,
  unmatchTransactionSchema,
} from './validation.js';

/**
 * Two collections under one mount: statements are the documents the bank sent,
 * transactions are the lines on them. Neither has a `POST /`, because nothing
 * here is authored in this system — a statement is imported and a transaction
 * arrives on one.
 *
 * The fixed segments (`import`, `reconcile`, `summary`) are registered before
 * the `:id` routes so that none of them is ever read as an identifier.
 */
export const createFinanceRouter = (
  controller: FinanceController,
  authenticate: RequestHandler,
): Router => {
  const router = Router();
  router.use(authenticate);
  router.get('/statements', validate(listStatementsSchema), controller.listStatements);
  router.post('/statements/import', validate(importStatementSchema), controller.importStatement);
  router.post('/reconcile', validate(reconcileSchema), controller.reconcile);
  router.get('/summary', validate(financeSummarySchema), controller.summary);
  router.get('/transactions', validate(listTransactionsSchema), controller.listTransactions);
  router.get('/transactions/:id', validate(getTransactionSchema), controller.getTransactionById);
  router.post('/transactions/:id/match', validate(matchTransactionSchema), controller.match);
  router.delete('/transactions/:id/match', validate(unmatchTransactionSchema), controller.unmatch);
  return router;
};
