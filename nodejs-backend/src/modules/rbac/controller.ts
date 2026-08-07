import type { Request, RequestHandler } from 'express';
import { AppError } from '../../common/errors/app-error.js';
import type { RbacAdminService } from './service.js';
import type { CreateRoleData, ReplaceRolePermissionsData } from './types.js';

export interface RbacController {
  check: RequestHandler;
  listRoles: RequestHandler;
  createRole: RequestHandler;
  replaceRolePermissions: RequestHandler;
}

const requireParam = (request: Request, name: string): string => {
  const value = request.params[name];
  if (typeof value !== 'string')
    throw new AppError(`Missing ${name}`, 400, 'INVALID_PATH_PARAMETER');
  return value;
};

export const createRbacController = (rbacService: RbacAdminService): RbacController => ({
  check: async (request, response) => {
    if (!request.auth) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
    const scope = await rbacService.getPermissionScope(
      request.auth.userId,
      requireParam(request, 'resource'),
      requireParam(request, 'action'),
    );
    response.status(200).json({ data: { allowed: scope !== null, scope } });
  },
  listRoles: async (_request, response) => {
    response.status(200).json({ data: await rbacService.listRoles() });
  },
  createRole: async (request, response) => {
    response
      .status(201)
      .json({ data: await rbacService.createRole(request.body as CreateRoleData) });
  },
  replaceRolePermissions: async (request, response) => {
    response.status(200).json({
      data: await rbacService.replaceRolePermissions(
        requireParam(request, 'id'),
        request.body as ReplaceRolePermissionsData,
      ),
    });
  },
});
