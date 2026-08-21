import type { RequestHandler } from 'express';
import { AppError } from '../../common/errors/app-error.js';
import type { RbacService } from './service.js';
import type { PermissionRequirement } from './types.js';

export const requirePermission =
  (rbacService: RbacService, requirement: PermissionRequirement): RequestHandler =>
  async (request, _response, next) => {
    if (!request.auth) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');

    const scope = await rbacService.getPermissionScope(
      request.auth.userId,
      requirement.resource,
      requirement.action,
    );
    if (scope === 'ALL') {
      next();
      return;
    }
    if (scope === 'OWN' && requirement.ownerId) {
      const ownerId = await requirement.ownerId(request);
      if (ownerId === request.auth.userId) {
        next();
        return;
      }
    }
    throw new AppError('Forbidden', 403, 'FORBIDDEN');
  };
