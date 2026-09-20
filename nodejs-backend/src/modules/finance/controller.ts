import type { Request, RequestHandler } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { AuthContext } from '../../common/types/auth-context.js';
import type { RbacService } from '../rbac/service.js';
import type { PermissionScope } from '../rbac/types.js';
import type { FinanceService } from './service.js';
import type { FinanceAccess } from './types.js';
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

export interface FinanceController {
  readonly listStatements: RequestHandler;
  readonly importStatement: RequestHandler;
  readonly listTransactions: RequestHandler;
  readonly getTransactionById: RequestHandler;
  readonly match: RequestHandler;
  readonly unmatch: RequestHandler;
  readonly reconcile: RequestHandler;
  readonly summary: RequestHandler;
}

const getAuth = (request: Request): AuthContext => {
  if (!request.auth) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  return request.auth;
};

/**
 * A role may hold no `finance` permission at all — the viewer holds none — and
 * that is an ordinary answer, not an exceptional one: the scope lookup returns
 * nothing and the request is refused with 403 before the service is built or
 * the database is touched.
 */
const getScope = async (
  rbac: RbacService,
  actorId: string,
  action: 'read' | 'write' | 'delete',
): Promise<PermissionScope> => {
  const scope = await rbac.getPermissionScope(actorId, 'finance', action);
  if (!scope) throw new AppError('Forbidden', 403, 'FORBIDDEN');
  return scope;
};

const accessFor = (request: Request, actorId: string, scope: PermissionScope): FinanceAccess => ({
  actorId,
  scope,
  ...(request.ip ? { ipAddress: request.ip } : {}),
});

const invalid = (details: unknown): AppError =>
  new AppError('Invalid request', 400, 'VALIDATION_ERROR', details);

export const createFinanceController = (
  service: FinanceService,
  rbac: RbacService,
): FinanceController => ({
  listStatements: async (request, response) => {
    const parsed = listStatementsSchema.safeParse({ query: request.query });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    const scope = await getScope(rbac, auth.userId, 'read');
    response.json({
      data: await service.listStatements(accessFor(request, auth.userId, scope), parsed.data.query),
    });
  },

  importStatement: async (request, response) => {
    const parsed = importStatementSchema.safeParse({ body: request.body ?? {} });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    const scope = await getScope(rbac, auth.userId, 'write');
    response.json({
      data: await service.importStatement(accessFor(request, auth.userId, scope)),
    });
  },

  listTransactions: async (request, response) => {
    const parsed = listTransactionsSchema.safeParse({ query: request.query });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    const scope = await getScope(rbac, auth.userId, 'read');
    response.json({
      data: await service.listTransactions(
        accessFor(request, auth.userId, scope),
        parsed.data.query,
      ),
    });
  },

  getTransactionById: async (request, response) => {
    const parsed = getTransactionSchema.safeParse({ params: request.params });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    const scope = await getScope(rbac, auth.userId, 'read');
    response.json({
      data: await service.getTransactionById(
        accessFor(request, auth.userId, scope),
        parsed.data.params.id,
      ),
    });
  },

  match: async (request, response) => {
    const parsed = matchTransactionSchema.safeParse({
      params: request.params,
      body: request.body,
    });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    const scope = await getScope(rbac, auth.userId, 'write');
    response.json({
      data: await service.match(
        accessFor(request, auth.userId, scope),
        parsed.data.params.id,
        parsed.data.body,
      ),
    });
  },

  unmatch: async (request, response) => {
    const parsed = unmatchTransactionSchema.safeParse({
      params: request.params,
      query: request.query,
    });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    // Undoing a match is a write, not a deletion: the transaction stays, only
    // the conclusion about it is withdrawn.
    const scope = await getScope(rbac, auth.userId, 'write');
    response.json({
      data: await service.unmatch(
        accessFor(request, auth.userId, scope),
        parsed.data.params.id,
        parsed.data.query.version,
      ),
    });
  },

  reconcile: async (request, response) => {
    const parsed = reconcileSchema.safeParse({ body: request.body ?? {} });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    const scope = await getScope(rbac, auth.userId, 'write');
    response.json({ data: await service.reconcile(accessFor(request, auth.userId, scope)) });
  },

  summary: async (request, response) => {
    const parsed = financeSummarySchema.safeParse({ query: request.query });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    const scope = await getScope(rbac, auth.userId, 'read');
    response.json({
      data: await service.summary(accessFor(request, auth.userId, scope), parsed.data.query),
    });
  },
});
