import type { Request, RequestHandler } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { AuthContext } from '../../common/types/auth-context.js';
import type { RbacService } from '../rbac/service.js';
import type { PermissionScope } from '../rbac/types.js';
import type { AuditService } from './service.js';
import { auditHistorySchema, getAuditSchema, listAuditSchema } from './validation.js';

export interface AuditController {
  readonly list: RequestHandler;
  readonly history: RequestHandler;
  readonly getById: RequestHandler;
}

const authContext = (request: Request): AuthContext => {
  if (!request.auth) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  return request.auth;
};

const permissionScope = async (rbac: RbacService, actorId: string): Promise<PermissionScope> => {
  const scope = await rbac.getPermissionScope(actorId, 'audit', 'read');
  if (!scope) throw new AppError('Forbidden', 403, 'FORBIDDEN');
  return scope;
};

const validationError = (details: unknown): AppError =>
  new AppError('Invalid request', 400, 'VALIDATION_ERROR', details);

export const createAuditController = (
  service: AuditService,
  rbac: RbacService,
): AuditController => ({
  list: async (request, response) => {
    const parsed = listAuditSchema.safeParse({ query: request.query });
    if (!parsed.success) throw validationError(parsed.error.flatten());
    const auth = authContext(request);
    const scope = await permissionScope(rbac, auth.userId);
    const { actorId, action, entityType, entityId, createdFrom, createdTo, page, pageSize } =
      parsed.data.query;
    response.json({
      data: await service.list(auth.userId, scope, {
        page,
        pageSize,
        ...(actorId ? { actorId } : {}),
        ...(action ? { action } : {}),
        ...(entityType ? { entityType } : {}),
        ...(entityId ? { entityId } : {}),
        ...(createdFrom ? { createdFrom: new Date(createdFrom) } : {}),
        ...(createdTo ? { createdTo: new Date(createdTo) } : {}),
      }),
    });
  },

  history: async (request, response) => {
    const parsed = auditHistorySchema.safeParse({ params: request.params, query: request.query });
    if (!parsed.success) throw validationError(parsed.error.flatten());
    const auth = authContext(request);
    const scope = await permissionScope(rbac, auth.userId);
    const { resource, resourceId } = parsed.data.params;
    const { action, createdFrom, createdTo, page, pageSize } = parsed.data.query;
    response.json({
      data: await service.history(auth.userId, scope, resource, resourceId, {
        page,
        pageSize,
        ...(action ? { action } : {}),
        ...(createdFrom ? { createdFrom: new Date(createdFrom) } : {}),
        ...(createdTo ? { createdTo: new Date(createdTo) } : {}),
      }),
    });
  },

  getById: async (request, response) => {
    const parsed = getAuditSchema.safeParse({ params: request.params });
    if (!parsed.success) throw validationError(parsed.error.flatten());
    const auth = authContext(request);
    const scope = await permissionScope(rbac, auth.userId);
    response.json({ data: await service.getById(auth.userId, scope, parsed.data.params.id) });
  },
});
