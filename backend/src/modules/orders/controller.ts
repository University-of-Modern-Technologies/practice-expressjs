import type { Request, RequestHandler, Response } from 'express';
import { AppError, validationError } from '../../common/errors/index.js';
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

type OrderAction = 'read' | 'write' | 'delete';

export interface OrdersController {
  /**
   * Permission guards, one per action. The router mounts the matching guard
   * ahead of request validation, so a caller without the grant is refused with
   * 403 before anything about the request body is reported back.
   */
  readonly authorize: Readonly<Record<OrderAction, RequestHandler>>;
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
  action: OrderAction,
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

/** Where a guard leaves the scope it resolved, so the handler need not ask again. */
const scopeKey = (action: OrderAction): string => `orders:${action}`;

export const createOrdersController = (
  service: OrdersService,
  rbac: RbacService,
): OrdersController => {
  const guard =
    (action: OrderAction): RequestHandler =>
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
    action: OrderAction,
  ): Promise<OrderAccess> => {
    const auth = getAuth(request);
    const resolved = response.locals[scopeKey(action)] as PermissionScope | undefined;
    const scope = resolved ?? (await getScope(rbac, auth.userId, action));
    return accessFor(request, auth.userId, scope);
  };

  return {
    authorize: { read: guard('read'), write: guard('write'), delete: guard('delete') },

    list: async (request, response) => {
      const access = await authorize(request, response, 'read');
      const parsed = listOrdersSchema.safeParse({ query: request.query });
      if (!parsed.success) throw validationError(parsed.error.flatten());
      response.json({ data: await service.list(access, parsed.data.query) });
    },

    getById: async (request, response) => {
      const access = await authorize(request, response, 'read');
      const parsed = getOrderSchema.safeParse({ params: request.params });
      if (!parsed.success) throw validationError(parsed.error.flatten());
      response.json({ data: await service.getById(access, parsed.data.params.id) });
    },

    create: async (request, response) => {
      const access = await authorize(request, response, 'write');
      const parsed = createOrderSchema.safeParse({ body: request.body });
      if (!parsed.success) throw validationError(parsed.error.flatten());
      response.status(201).json({ data: await service.create(access, parsed.data.body) });
    },

    duplicate: async (request, response) => {
      const access = await authorize(request, response, 'write');
      const parsed = duplicateOrderSchema.safeParse({ params: request.params });
      if (!parsed.success) throw validationError(parsed.error.flatten());
      response.status(201).json({ data: await service.duplicate(access, parsed.data.params.id) });
    },

    update: async (request, response) => {
      const access = await authorize(request, response, 'write');
      const parsed = updateOrderSchema.safeParse({ params: request.params, body: request.body });
      if (!parsed.success) throw validationError(parsed.error.flatten());
      response.json({
        data: await service.update(access, parsed.data.params.id, parsed.data.body),
      });
    },

    addItem: async (request, response) => {
      const access = await authorize(request, response, 'write');
      const parsed = addOrderItemSchema.safeParse({ params: request.params, body: request.body });
      if (!parsed.success) throw validationError(parsed.error.flatten());
      response.status(201).json({
        data: await service.addItem(access, parsed.data.params.id, parsed.data.body),
      });
    },

    updateItem: async (request, response) => {
      const access = await authorize(request, response, 'write');
      const parsed = updateOrderItemSchema.safeParse({
        params: request.params,
        body: request.body,
      });
      if (!parsed.success) throw validationError(parsed.error.flatten());
      response.json({
        data: await service.updateItem(
          access,
          parsed.data.params.id,
          parsed.data.params.itemId,
          parsed.data.body,
        ),
      });
    },

    removeItem: async (request, response) => {
      const access = await authorize(request, response, 'write');
      const parsed = removeOrderItemSchema.safeParse({
        params: request.params,
        query: request.query,
      });
      if (!parsed.success) throw validationError(parsed.error.flatten());
      response.json({
        data: await service.removeItem(
          access,
          parsed.data.params.id,
          parsed.data.params.itemId,
          parsed.data.query.version,
        ),
      });
    },

    transition: async (request, response) => {
      const access = await authorize(request, response, 'write');
      const parsed = transitionOrderSchema.safeParse({
        params: request.params,
        body: request.body,
      });
      if (!parsed.success) throw validationError(parsed.error.flatten());
      response.json({
        data: await service.transition(access, parsed.data.params.id, parsed.data.body),
      });
    },

    delete: async (request, response) => {
      const access = await authorize(request, response, 'delete');
      const parsed = deleteOrderSchema.safeParse({ params: request.params, query: request.query });
      if (!parsed.success) throw validationError(parsed.error.flatten());
      await service.delete(access, parsed.data.params.id, parsed.data.query.version);
      response.status(204).end();
    },
  };
};
