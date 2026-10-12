import type { Request, RequestHandler, Response } from 'express';

import { AppError, describeValidationIssues, validationError } from '../../common/errors/index.js';
import type { AuthContext } from '../../common/types/auth-context.js';
import type { RbacService } from '../rbac/service.js';
import type { PermissionScope } from '../rbac/types.js';
import type { WarehouseService } from './service.js';
import { WAREHOUSE_RESOURCE, type WarehouseAccess } from './types.js';
import {
  adjustStockSchema,
  createWarehouseSchema,
  getStockSchema,
  issueStockSchema,
  listMovementsSchema,
  listStockSchema,
  getWarehouseSchema,
  listWarehousesSchema,
  receiveStockSchema,
  releaseStockSchema,
  reserveStockSchema,
  updateWarehouseSchema,
} from './validation.js';

type WarehouseAction = 'read' | 'write';

export interface WarehouseController {
  /**
   * Permission guards, one per action. The router mounts the matching guard
   * ahead of request validation, so a caller without the grant is refused with
   * 403 before anything about the request is reported back.
   */
  readonly authorize: Readonly<Record<WarehouseAction, RequestHandler>>;
  readonly listWarehouses: RequestHandler;
  readonly getWarehouse: RequestHandler;
  readonly createWarehouse: RequestHandler;
  readonly updateWarehouse: RequestHandler;
  readonly listStock: RequestHandler;
  readonly getStock: RequestHandler;
  readonly receive: RequestHandler;
  readonly issue: RequestHandler;
  readonly reserve: RequestHandler;
  readonly release: RequestHandler;
  readonly adjust: RequestHandler;
  readonly listMovements: RequestHandler;
}

const getAuth = (request: Request): AuthContext => {
  if (!request.auth) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  return request.auth;
};

const getScope = async (
  rbac: RbacService,
  actorId: string,
  action: WarehouseAction,
): Promise<PermissionScope> => {
  const scope = await rbac.getPermissionScope(actorId, WAREHOUSE_RESOURCE, action);
  if (!scope) throw new AppError('Forbidden', 403, 'FORBIDDEN');
  return scope;
};

const accessFor = (request: Request, actorId: string, scope: PermissionScope): WarehouseAccess => ({
  actorId,
  scope,
  ...(request.ip ? { ipAddress: request.ip } : {}),
});

export const createWarehouseController = (
  service: WarehouseService,
  rbac: RbacService,
): WarehouseController => {
  /** Where a guard leaves the scope it resolved, so the handler need not ask again. */
  const scopeKey = (action: WarehouseAction): string => `warehouse:${action}`;

  const guard =
    (action: WarehouseAction): RequestHandler =>
    async (request, response, next) => {
      const auth = getAuth(request);
      response.locals[scopeKey(action)] = await getScope(rbac, auth.userId, action);
      next();
    };

  /**
   * The caller's grant for `action`: the one the guard already resolved, or —
   * when a handler is mounted without its guard — resolved here, still before
   * the request is validated.
   */
  const authorize = async (
    request: Request,
    response: Response,
    action: WarehouseAction,
  ): Promise<WarehouseAccess> => {
    const auth = getAuth(request);
    const resolved = response.locals[scopeKey(action)] as PermissionScope | undefined;
    const scope = resolved ?? (await getScope(rbac, auth.userId, action));
    return accessFor(request, auth.userId, scope);
  };

  return {
    authorize: { read: guard('read'), write: guard('write') },

    listWarehouses: async (request, response) => {
      const access = await authorize(request, response, 'read');
      const parsed = listWarehousesSchema.safeParse({ query: request.query });
      if (!parsed.success) throw validationError(describeValidationIssues(parsed.error));
      response.json({ data: await service.listWarehouses(access, parsed.data.query) });
    },

    getWarehouse: async (request, response) => {
      const access = await authorize(request, response, 'read');
      const parsed = getWarehouseSchema.safeParse({ params: request.params });
      if (!parsed.success) throw validationError(describeValidationIssues(parsed.error));
      response.json({ data: await service.getWarehouse(access, parsed.data.params.id) });
    },

    createWarehouse: async (request, response) => {
      const access = await authorize(request, response, 'write');
      const parsed = createWarehouseSchema.safeParse({ body: request.body });
      if (!parsed.success) throw validationError(describeValidationIssues(parsed.error));
      response.status(201).json({ data: await service.createWarehouse(access, parsed.data.body) });
    },

    updateWarehouse: async (request, response) => {
      const access = await authorize(request, response, 'write');
      const parsed = updateWarehouseSchema.safeParse({
        params: request.params,
        body: request.body,
      });
      if (!parsed.success) throw validationError(describeValidationIssues(parsed.error));
      response.json({
        data: await service.updateWarehouse(access, parsed.data.params.id, parsed.data.body),
      });
    },

    listStock: async (request, response) => {
      const access = await authorize(request, response, 'read');
      const parsed = listStockSchema.safeParse({ query: request.query });
      if (!parsed.success) throw validationError(describeValidationIssues(parsed.error));
      response.json({ data: await service.listStock(access, parsed.data.query) });
    },

    getStock: async (request, response) => {
      const access = await authorize(request, response, 'read');
      const parsed = getStockSchema.safeParse({ params: request.params });
      if (!parsed.success) throw validationError(describeValidationIssues(parsed.error));
      response.json({
        data: await service.getStock(
          access,
          parsed.data.params.warehouseId,
          parsed.data.params.productId,
        ),
      });
    },

    receive: async (request, response) => {
      const access = await authorize(request, response, 'write');
      const parsed = receiveStockSchema.safeParse({ body: request.body });
      if (!parsed.success) throw validationError(describeValidationIssues(parsed.error));
      response.json({ data: await service.receive(access, parsed.data.body) });
    },

    issue: async (request, response) => {
      const access = await authorize(request, response, 'write');
      const parsed = issueStockSchema.safeParse({ body: request.body });
      if (!parsed.success) throw validationError(describeValidationIssues(parsed.error));
      response.json({ data: await service.issue(access, parsed.data.body) });
    },

    reserve: async (request, response) => {
      const access = await authorize(request, response, 'write');
      const parsed = reserveStockSchema.safeParse({ body: request.body });
      if (!parsed.success) throw validationError(describeValidationIssues(parsed.error));
      response.json({ data: await service.reserve(access, parsed.data.body) });
    },

    release: async (request, response) => {
      const access = await authorize(request, response, 'write');
      const parsed = releaseStockSchema.safeParse({ body: request.body });
      if (!parsed.success) throw validationError(describeValidationIssues(parsed.error));
      response.json({ data: await service.release(access, parsed.data.body) });
    },

    adjust: async (request, response) => {
      const access = await authorize(request, response, 'write');
      const parsed = adjustStockSchema.safeParse({ body: request.body });
      if (!parsed.success) throw validationError(describeValidationIssues(parsed.error));
      response.json({ data: await service.adjust(access, parsed.data.body) });
    },

    listMovements: async (request, response) => {
      const access = await authorize(request, response, 'read');
      const parsed = listMovementsSchema.safeParse({ query: request.query });
      if (!parsed.success) throw validationError(describeValidationIssues(parsed.error));
      response.json({ data: await service.listMovements(access, parsed.data.query) });
    },
  };
};
