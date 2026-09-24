import type { Request, RequestHandler } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { AuthContext } from '../../common/types/auth-context.js';
import type { RbacService } from '../rbac/service.js';
import type { PermissionScope } from '../rbac/types.js';
import type { CallsService } from './service.js';
import type { CallAccess } from './types.js';
import {
  deleteCallSchema,
  getCallRecordingSchema,
  getCallSchema,
  linkCallSchema,
  listCallsSchema,
  syncCallsSchema,
  updateCallSchema,
} from './validation.js';

export interface CallsController {
  readonly list: RequestHandler;
  readonly getById: RequestHandler;
  readonly sync: RequestHandler;
  readonly update: RequestHandler;
  readonly link: RequestHandler;
  readonly getRecording: RequestHandler;
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
  const scope = await rbac.getPermissionScope(actorId, 'calls', action);
  if (!scope) throw new AppError('Forbidden', 403, 'FORBIDDEN');
  return scope;
};

const accessFor = (request: Request, actorId: string, scope: PermissionScope): CallAccess => ({
  actorId,
  scope,
  ...(request.ip ? { ipAddress: request.ip } : {}),
});

const invalid = (details: unknown): AppError =>
  new AppError('Invalid request', 400, 'VALIDATION_ERROR', details);

export const createCallsController = (
  service: CallsService,
  rbac: RbacService,
): CallsController => ({
  list: async (request, response) => {
    const parsed = listCallsSchema.safeParse({ query: request.query });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    const scope = await getScope(rbac, auth.userId, 'read');
    response.json({
      data: await service.list(accessFor(request, auth.userId, scope), parsed.data.query),
    });
  },

  getById: async (request, response) => {
    const parsed = getCallSchema.safeParse({ params: request.params });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    const scope = await getScope(rbac, auth.userId, 'read');
    response.json({
      data: await service.getById(accessFor(request, auth.userId, scope), parsed.data.params.id),
    });
  },

  sync: async (request, response) => {
    const parsed = syncCallsSchema.safeParse({ body: request.body ?? {} });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    const scope = await getScope(rbac, auth.userId, 'write');
    response.json({ data: await service.sync(accessFor(request, auth.userId, scope)) });
  },

  update: async (request, response) => {
    const parsed = updateCallSchema.safeParse({ params: request.params, body: request.body });
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

  link: async (request, response) => {
    const parsed = linkCallSchema.safeParse({ params: request.params, body: request.body });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    const scope = await getScope(rbac, auth.userId, 'write');
    response.json({
      data: await service.link(
        accessFor(request, auth.userId, scope),
        parsed.data.params.id,
        parsed.data.body,
      ),
    });
  },

  getRecording: async (request, response) => {
    const parsed = getCallRecordingSchema.safeParse({ params: request.params });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    const scope = await getScope(rbac, auth.userId, 'read');
    response.json({
      data: await service.getRecording(
        accessFor(request, auth.userId, scope),
        parsed.data.params.id,
      ),
    });
  },

  delete: async (request, response) => {
    const parsed = deleteCallSchema.safeParse({ params: request.params, query: request.query });
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
