import type { Request, RequestHandler } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { AuthContext } from '../../common/types/auth-context.js';
import type { RbacService } from '../rbac/service.js';
import type { PermissionScope } from '../rbac/types.js';
import type { OrdersService } from './service.js';
import type { OrderAccess } from './types.js';
import {
  addOrderItemSchema,
  createOrderSchema,
  deleteOrderSchema,
  duplicateOrderSchema,
  getOrderSchema,
  listOrdersSchema,
  removeOrderItemSchema,
  transitionOrderSchema,
  updateOrderItemSchema,
  updateOrderSchema,
} from './validation.js';

export interface OrdersController {
  readonly list: RequestHandler;
  readonly getById: RequestHandler;
  readonly create: RequestHandler;
  readonly duplicate: RequestHandler;
  readonly update: RequestHandler;
  readonly addItem: RequestHandler;
  readonly updateItem: RequestHandler;
  readonly removeItem: RequestHandler;
  readonly transition: RequestHandler;
  readonly delete: RequestHandler;
}

const getAuth = (request: Request): AuthContext => {
  if (!request.auth) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  return request.auth;
};

const getScope = async (
  rbac: RbacService,
  actorId: string,
  action: 'read' | 'write' | 'delete',
): Promise<PermissionScope> => {
  const scope = await rbac.getPermissionScope(actorId, 'orders', action);
  if (!scope) throw new AppError('Forbidden', 403, 'FORBIDDEN');
  return scope;
};

const accessFor = (request: Request, actorId: string, scope: PermissionScope): OrderAccess => ({
  actorId,
  scope,
  ...(request.ip ? { ipAddress: request.ip } : {}),
});

const invalid = (details: unknown): AppError =>
  new AppError('Invalid request', 400, 'VALIDATION_ERROR', details);

export const createOrdersController = (
  service: OrdersService,
  rbac: RbacService,
): OrdersController => ({
  list: async (request, response) => {
    const parsed = listOrdersSchema.safeParse({ query: request.query });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    const scope = await getScope(rbac, auth.userId, 'read');
    response.json({
      data: await service.list(accessFor(request, auth.userId, scope), parsed.data.query),
    });
  },

  getById: async (request, response) => {
    const parsed = getOrderSchema.safeParse({ params: request.params });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    const scope = await getScope(rbac, auth.userId, 'read');
    response.json({
      data: await service.getById(accessFor(request, auth.userId, scope), parsed.data.params.id),
    });
  },

  create: async (request, response) => {
    const parsed = createOrderSchema.safeParse({ body: request.body });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    const scope = await getScope(rbac, auth.userId, 'write');
    response.status(201).json({
      data: await service.create(accessFor(request, auth.userId, scope), parsed.data.body),
    });
  },

  duplicate: async (request, response) => {
    const parsed = duplicateOrderSchema.safeParse({ params: request.params });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    const scope = await getScope(rbac, auth.userId, 'write');
    response.status(201).json({
      data: await service.duplicate(accessFor(request, auth.userId, scope), parsed.data.params.id),
    });
  },

  update: async (request, response) => {
    const parsed = updateOrderSchema.safeParse({ params: request.params, body: request.body });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    const scope = await getScope(rbac, auth.userId, 'write');
    response.json({
      data: await service.update(
        accessFor(request, auth.userId, scope),
        parsed.data.params.id,
        parsed.data.body,
      ),
    });
  },

  addItem: async (request, response) => {
    const parsed = addOrderItemSchema.safeParse({ params: request.params, body: request.body });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    const scope = await getScope(rbac, auth.userId, 'write');
    response.status(201).json({
      data: await service.addItem(
        accessFor(request, auth.userId, scope),
        parsed.data.params.id,
        parsed.data.body,
      ),
    });
  },

  updateItem: async (request, response) => {
    const parsed = updateOrderItemSchema.safeParse({ params: request.params, body: request.body });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    const scope = await getScope(rbac, auth.userId, 'write');
    response.json({
      data: await service.updateItem(
        accessFor(request, auth.userId, scope),
        parsed.data.params.id,
        parsed.data.params.itemId,
        parsed.data.body,
      ),
    });
  },

  removeItem: async (request, response) => {
    const parsed = removeOrderItemSchema.safeParse({
      params: request.params,
      query: request.query,
    });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    const scope = await getScope(rbac, auth.userId, 'write');
    response.json({
      data: await service.removeItem(
        accessFor(request, auth.userId, scope),
        parsed.data.params.id,
        parsed.data.params.itemId,
        parsed.data.query.version,
      ),
    });
  },

  transition: async (request, response) => {
    const parsed = transitionOrderSchema.safeParse({ params: request.params, body: request.body });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    const scope = await getScope(rbac, auth.userId, 'write');
    response.json({
      data: await service.transition(
        accessFor(request, auth.userId, scope),
        parsed.data.params.id,
        parsed.data.body,
      ),
    });
  },

  delete: async (request, response) => {
    const parsed = deleteOrderSchema.safeParse({ params: request.params, query: request.query });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    const scope = await getScope(rbac, auth.userId, 'delete');
    await service.delete(
      accessFor(request, auth.userId, scope),
      parsed.data.params.id,
      parsed.data.query.version,
    );
    response.status(204).end();
  },
});
