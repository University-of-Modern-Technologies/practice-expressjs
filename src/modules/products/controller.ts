import type { Request, RequestHandler } from 'express';
import { AppError } from '../../common/errors/index.js';
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

export interface ProductsController {
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
  action: 'read' | 'write' | 'delete',
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

const invalid = (details: unknown): AppError =>
  new AppError('Invalid request', 400, 'VALIDATION_ERROR', details);

export const createProductsController = (
  service: ProductsService,
  rbac: RbacService,
): ProductsController => ({
  list: async (request, response) => {
    const parsed = listProductsSchema.safeParse({ query: request.query });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    const scope = await getScope(rbac, auth.userId, 'read');
    response.json({
      data: await service.list(accessFor(request, auth.userId, scope), parsed.data.query),
    });
  },

  getById: async (request, response) => {
    const parsed = getProductSchema.safeParse({ params: request.params });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    const scope = await getScope(rbac, auth.userId, 'read');
    response.json({
      data: await service.getById(accessFor(request, auth.userId, scope), parsed.data.params.id),
    });
  },

  create: async (request, response) => {
    const parsed = createProductSchema.safeParse({ body: request.body });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    const scope = await getScope(rbac, auth.userId, 'write');
    response.status(201).json({
      data: await service.create(accessFor(request, auth.userId, scope), parsed.data.body),
    });
  },

  update: async (request, response) => {
    const parsed = updateProductSchema.safeParse({ params: request.params, body: request.body });
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

  delete: async (request, response) => {
    const parsed = deleteProductSchema.safeParse({ params: request.params, query: request.query });
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
