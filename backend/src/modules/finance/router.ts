import { Router, type RequestHandler } from 'express';

import { validate } from '../../common/middleware/validate.js';
import { describeRoutes, ok, pageOf, refusals } from '../../common/openapi/index.js';
import type { FinanceController } from './controller.js';
import {
  bankStatementSchema,
  bankTransactionDetailSchema,
  bankTransactionSchema,
  financeSummaryReportSchema,
  reconcileResultSchema,
  statementImportResultSchema,
} from './types.js';
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
  const routes = describeRoutes(router, [
    { name: 'Finance', description: 'Виписки та зведення платежів' },
  ]);

  routes.get(
    '/statements',
    {
      summary: 'Переглянути банківські виписки',
      response: ok('Сторінка виписок', pageOf(bankStatementSchema)),
      refusals: refusals(401, 403),
    },
    validate(listStatementsSchema),
    controller.listStatements,
  );
  routes.post(
    '/statements/import',
    {
      summary: 'Імпортувати банківську виписку',
      description:
        'Імпорт ідемпотентний: ключ — externalId, тож повторний виклик з тією самою випискою ' +
        'нічого не дублює й повертає її рядки у skipped. Недоступний банк — 502 ' +
        '`BANK_PROVIDER_UNAVAILABLE`.',
      response: ok('Підсумок імпорту', statementImportResultSchema),
      refusals: refusals(401, 403, 409, 502),
    },
    validate(importStatementSchema),
    controller.importStatement,
  );
  routes.post(
    '/reconcile',
    {
      summary: 'Звести платежі із замовленнями',
      description:
        'Кандидатом є замовлення у статусі CONFIRMED або PAID, чиє призначення платежу або ' +
        'назва контрагента впізнається, сума збігається з допуском ±0.01, а дата проведення ' +
        'лежить у вікні 90 днів від створення замовлення. Один кандидат — MATCHED, кілька — ' +
        'SUGGESTED, жодного — UNMATCHED.',
      response: ok('Підсумок зведення', reconcileResultSchema),
      refusals: refusals(401, 403),
    },
    validate(reconcileSchema),
    controller.reconcile,
  );
  routes.get(
    '/summary',
    {
      summary: 'Підсумок надходжень і списань за період',
      description:
        'За відсутності меж періоду використовується проміжок від 2026-01-01T00:00:00.000Z ' +
        'до кінця поточної доби (UTC); явна межа має пріоритет над значенням за замовчуванням.',
      response: ok('Підсумок за період', financeSummaryReportSchema),
      refusals: refusals(401, 403),
    },
    validate(financeSummarySchema),
    controller.summary,
  );
  routes.get(
    '/transactions',
    {
      summary: 'Переглянути банківські транзакції',
      response: ok('Сторінка транзакцій', pageOf(bankTransactionSchema)),
      refusals: refusals(401, 403),
    },
    validate(listTransactionsSchema),
    controller.listTransactions,
  );
  routes.get(
    '/transactions/:id',
    {
      summary: 'Отримати банківську транзакцію',
      description: 'Для стану SUGGESTED у відповіді є список замовлень-кандидатів.',
      response: ok('Транзакція', bankTransactionDetailSchema),
      refusals: refusals(401, 403, 404),
    },
    validate(getTransactionSchema),
    controller.getTransactionById,
  );
  routes.post(
    '/transactions/:id/match',
    {
      summary: 'Звести транзакцію із замовленням вручну',
      description:
        'Ручне зведення перекриває підказки, але не арифметику: сума має збігатися з ' +
        'підсумком замовлення з допуском ±0.01, інакше 422 `TRANSACTION_AMOUNT_MISMATCH`.',
      response: ok('Транзакцію зведено', bankTransactionSchema),
      refusals: refusals(401, 403, 404, 409, 422),
    },
    validate(matchTransactionSchema),
    controller.match,
  );
  routes.delete(
    '/transactions/:id/match',
    {
      summary: 'Зняти зведення транзакції',
      response: ok('Зведення знято', bankTransactionSchema),
      refusals: refusals(401, 403, 404, 409),
    },
    validate(unmatchTransactionSchema),
    controller.unmatch,
  );
  return router;
};
