import type { Request, RequestHandler, Response } from 'express';
import { AppError, describeValidationIssues, validationError } from '../../common/errors/index.js';
import type { AuthContext } from '../../common/types/auth-context.js';
import type { RbacService } from '../rbac/service.js';
import type { PermissionScope } from '../rbac/types.js';
import type { ProductsService } from './service.js';
import type { ProductAccess } from './types.js';
import {
  createProductSchema,
  deleteProductSchema,
  getProductSchema,
  listProductsSchema,
  updateProductSchema,
} from './validation.js';

type ProductAction = 'read' | 'write' | 'delete';

export interface ProductsController {
  /**
   * Permission guards, one per action. The router mounts the matching guard
   * ahead of request validation, so a caller without the grant is refused with
   * 403 before anything about the request is reported back.
   */
  readonly authorize: Readonly<Record<ProductAction, RequestHandler>>;
  readonly list: RequestHandler;
  readonly getById: RequestHandler;
  readonly create: RequestHandler;
  readonly update: RequestHandler;
  readonly delete: RequestHandler;
}

const getAuth = (request: Request): AuthContext => {
  if (!request.auth) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  return request.auth;
};

const getScope = async (
  rbac: RbacService,
  actorId: string,
  action: ProductAction,
): Promise<PermissionScope> => {
  const scope = await rbac.getPermissionScope(actorId, 'products', action);
  if (!scope) throw new AppError('Forbidden', 403, 'FORBIDDEN');
  return scope;
};

const accessFor = (request: Request, actorId: string, scope: PermissionScope): ProductAccess => ({
  actorId,
  scope,
  ...(request.ip ? { ipAddress: request.ip } : {}),
});

/** Where a guard leaves the scope it resolved, so the handler need not ask again. */
const scopeKey = (action: ProductAction): string => `products:${action}`;

export const createProductsController = (
  service: ProductsService,
  rbac: RbacService,
): ProductsController => {
  const guard =
    (action: ProductAction): RequestHandler =>
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
    action: ProductAction,
  ): Promise<ProductAccess> => {
    const auth = getAuth(request);
    const resolved = response.locals[scopeKey(action)] as PermissionScope | undefined;
    const scope = resolved ?? (await getScope(rbac, auth.userId, action));
    return accessFor(request, auth.userId, scope);
  };

  return {
    authorize: { read: guard('read'), write: guard('write'), delete: guard('delete') },

    list: async (request, response) => {
      const access = await authorize(request, response, 'read');
      const parsed = listProductsSchema.safeParse({ query: request.query });
      if (!parsed.success) throw validationError(describeValidationIssues(parsed.error));
      response.json({ data: await service.list(access, parsed.data.query) });
    },

    getById: async (request, response) => {
      const access = await authorize(request, response, 'read');
      const parsed = getProductSchema.safeParse({ params: request.params });
      if (!parsed.success) throw validationError(describeValidationIssues(parsed.error));
      response.json({ data: await service.getById(access, parsed.data.params.id) });
    },

    create: async (request, response) => {
      const access = await authorize(request, response, 'write');
      const parsed = createProductSchema.safeParse({ body: request.body });
      if (!parsed.success) throw validationError(describeValidationIssues(parsed.error));
      response.status(201).json({ data: await service.create(access, parsed.data.body) });
    },

    update: async (request, response) => {
      const access = await authorize(request, response, 'write');
      const parsed = updateProductSchema.safeParse({ params: request.params, body: request.body });
      if (!parsed.success) throw validationError(describeValidationIssues(parsed.error));
      response.json({
        data: await service.update(access, parsed.data.params.id, parsed.data.body),
      });
    },

    delete: async (request, response) => {
      const access = await authorize(request, response, 'delete');
      const parsed = deleteProductSchema.safeParse({
        params: request.params,
        query: request.query,
      });
      if (!parsed.success) throw validationError(describeValidationIssues(parsed.error));
      await service.delete(access, parsed.data.params.id, parsed.data.query.version);
      response.status(204).end();
    },
  };
};
