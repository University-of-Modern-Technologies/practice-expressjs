import type { Request, RequestHandler } from 'express';
import { AppError } from '../../common/errors/app-error.js';
import type { RbacService } from './service.js';
import type { PermissionRequirement, PermissionScope } from './types.js';

const unauthorized = (): AppError => new AppError('Unauthorized', 401, 'UNAUTHORIZED');
const forbidden = (): AppError => new AppError('Forbidden', 403, 'FORBIDDEN');

/** Whether a grant of this breadth covers the record the request addresses. */
const covers = async (
  scope: PermissionScope,
  requirement: PermissionRequirement,
  request: Request,
): Promise<boolean> => {
  if (scope === 'ALL') return true;
  if (!requirement.ownerId || !request.auth) return false;
  const ownerId = await requirement.ownerId(request);
  // Identifiers are compared without regard to case, as the database does.
  return ownerId !== undefined && ownerId.toLowerCase() === request.auth.userId.toLowerCase();
};

export const requirePermission =
  (rbacService: RbacService, requirement: PermissionRequirement): RequestHandler =>
  async (request, _response, next) => {
    if (!request.auth) throw unauthorized();

    const scope = await rbacService.getPermissionScope(
      request.auth.userId,
      requirement.resource,
      requirement.action,
    );
    if (scope === null || !(await covers(scope, requirement, request))) throw forbidden();
    next();
  };

/**
 * `requirePermission` split around request validation.
 *
 * `held` goes before `validate()` and refuses only a caller who holds the
 * permission at no breadth, so a caller without it learns nothing about what a
 * valid request looks like. `breadth` goes after `validate()` and applies the
 * breadth, so an owner read from the request is read from validated input. A
 * request is therefore refused in this order: 401, 403 for a missing
 * permission, 400, 403 for a grant too narrow for the addressed record.
 */
export interface PermissionGate {
  readonly held: RequestHandler;
  readonly breadth: RequestHandler;
}

export const permissionGate = (
  rbacService: RbacService,
  requirement: PermissionRequirement,
): PermissionGate => {
  const scopes = new WeakMap<Request, PermissionScope>();

  return {
    held: async (request, _response, next) => {
      if (!request.auth) throw unauthorized();
      const scope = await rbacService.getPermissionScope(
        request.auth.userId,
        requirement.resource,
        requirement.action,
      );
      if (scope === null) throw forbidden();
      scopes.set(request, scope);
      next();
    },
    breadth: async (request, _response, next) => {
      const scope = scopes.get(request);
      if (scope === undefined || !(await covers(scope, requirement, request))) throw forbidden();
      next();
    },
  };
};
