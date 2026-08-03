import type { Request, RequestHandler } from 'express';

import { AppError } from '../../common/errors/index.js';
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

export interface WarehouseController {
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
  action: 'read' | 'write',
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

const invalid = (details: unknown): AppError =>
  new AppError('Invalid request', 400, 'VALIDATION_ERROR', details);

export const createWarehouseController = (
  service: WarehouseService,
  rbac: RbacService,
): WarehouseController => {
  /** Resolves the caller's grant for the requested action, or refuses. */
  const authorize = async (
    request: Request,
    action: 'read' | 'write',
  ): Promise<WarehouseAccess> => {
    const auth = getAuth(request);
    const scope = await getScope(rbac, auth.userId, action);
    return accessFor(request, auth.userId, scope);
  };

  return {
    listWarehouses: async (request, response) => {
      const parsed = listWarehousesSchema.safeParse({ query: request.query });
      if (!parsed.success) throw invalid(parsed.error.flatten());
      const access = await authorize(request, 'read');
      response.json({ data: await service.listWarehouses(access, parsed.data.query) });
    },

    getWarehouse: async (request, response) => {
      const parsed = getWarehouseSchema.safeParse({ params: request.params });
      if (!parsed.success) throw invalid(parsed.error.flatten());
      const access = await authorize(request, 'read');
      response.json({ data: await service.getWarehouse(access, parsed.data.params.id) });
    },

    createWarehouse: async (request, response) => {
      const parsed = createWarehouseSchema.safeParse({ body: request.body });
      if (!parsed.success) throw invalid(parsed.error.flatten());
      const access = await authorize(request, 'write');
      response.status(201).json({ data: await service.createWarehouse(access, parsed.data.body) });
    },

    updateWarehouse: async (request, response) => {
      const parsed = updateWarehouseSchema.safeParse({
        params: request.params,
        body: request.body,
      });
      if (!parsed.success) throw invalid(parsed.error.flatten());
      const access = await authorize(request, 'write');
      response.json({
        data: await service.updateWarehouse(access, parsed.data.params.id, parsed.data.body),
      });
    },

    listStock: async (request, response) => {
      const parsed = listStockSchema.safeParse({ query: request.query });
      if (!parsed.success) throw invalid(parsed.error.flatten());
      const access = await authorize(request, 'read');
      response.json({ data: await service.listStock(access, parsed.data.query) });
    },

    getStock: async (request, response) => {
      const parsed = getStockSchema.safeParse({ params: request.params });
      if (!parsed.success) throw invalid(parsed.error.flatten());
      const access = await authorize(request, 'read');
      response.json({
        data: await service.getStock(
          access,
          parsed.data.params.warehouseId,
          parsed.data.params.productId,
        ),
      });
    },

    receive: async (request, response) => {
      const parsed = receiveStockSchema.safeParse({ body: request.body });
      if (!parsed.success) throw invalid(parsed.error.flatten());
      const access = await authorize(request, 'write');
      response.json({ data: await service.receive(access, parsed.data.body) });
    },

    issue: async (request, response) => {
      const parsed = issueStockSchema.safeParse({ body: request.body });
      if (!parsed.success) throw invalid(parsed.error.flatten());
      const access = await authorize(request, 'write');
      response.json({ data: await service.issue(access, parsed.data.body) });
    },

    reserve: async (request, response) => {
      const parsed = reserveStockSchema.safeParse({ body: request.body });
      if (!parsed.success) throw invalid(parsed.error.flatten());
      const access = await authorize(request, 'write');
      response.json({ data: await service.reserve(access, parsed.data.body) });
    },

    release: async (request, response) => {
      const parsed = releaseStockSchema.safeParse({ body: request.body });
      if (!parsed.success) throw invalid(parsed.error.flatten());
      const access = await authorize(request, 'write');
      response.json({ data: await service.release(access, parsed.data.body) });
    },

    adjust: async (request, response) => {
      const parsed = adjustStockSchema.safeParse({ body: request.body });
      if (!parsed.success) throw invalid(parsed.error.flatten());
      const access = await authorize(request, 'write');
      response.json({ data: await service.adjust(access, parsed.data.body) });
    },

    listMovements: async (request, response) => {
      const parsed = listMovementsSchema.safeParse({ query: request.query });
      if (!parsed.success) throw invalid(parsed.error.flatten());
      const access = await authorize(request, 'read');
      response.json({ data: await service.listMovements(access, parsed.data.query) });
    },
  };
};
