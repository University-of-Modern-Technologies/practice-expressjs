import type { Request, RequestHandler } from 'express';

import { AppError, describeValidationIssues, validationError } from '../../common/errors/index.js';
import type { AuthContext } from '../../common/types/auth-context.js';
import type { RbacService } from '../rbac/service.js';
import type { IntegrationsService } from './service.js';
import type { ShipmentAccess } from './types.js';
import { createQuoteSchema, createShipmentSchema, getShipmentSchema } from './validation.js';

/** Resource used for every RBAC check in this module. */
export const INTEGRATIONS_RESOURCE = 'integrations';
/** `integrations:read` — quotes, shipment status and integration health. */
export const INTEGRATIONS_READ_PERMISSION = 'integrations:read';
/** `integrations:write` — creating a shipment with the carrier. */
export const INTEGRATIONS_WRITE_PERMISSION = 'integrations:write';

export interface IntegrationsController {
  readonly createQuote: RequestHandler;
  readonly createShipment: RequestHandler;
  readonly getShipment: RequestHandler;
  readonly health: RequestHandler;
}

const getAuth = (request: Request): AuthContext => {
  if (!request.auth) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  return request.auth;
};

const assertPermission = async (
  rbac: RbacService,
  actorId: string,
  action: 'read' | 'write',
): Promise<void> => {
  const scope = await rbac.getPermissionScope(actorId, INTEGRATIONS_RESOURCE, action);
  if (!scope) throw new AppError('Forbidden', 403, 'FORBIDDEN');
};

/**
 * Which orders the caller may ship. A delivery names an order, so whether it is
 * visible is decided by the caller's `orders:read` grant, at its own breadth.
 */
const shipmentAccess = async (rbac: RbacService, actorId: string): Promise<ShipmentAccess> => ({
  actorId,
  orderScope: await rbac.getPermissionScope(actorId, 'orders', 'read'),
});

export const createIntegrationsController = (
  service: IntegrationsService,
  rbac: RbacService,
): IntegrationsController => ({
  createQuote: async (request, response) => {
    const parsed = createQuoteSchema.safeParse({ body: request.body });
    if (!parsed.success) throw validationError(describeValidationIssues(parsed.error));
    const auth = getAuth(request);
    await assertPermission(rbac, auth.userId, 'read');
    const access = await shipmentAccess(rbac, auth.userId);
    response.json({ data: await service.requestQuote(access, parsed.data.body) });
  },

  createShipment: async (request, response) => {
    const parsed = createShipmentSchema.safeParse({ body: request.body });
    if (!parsed.success) throw validationError(describeValidationIssues(parsed.error));
    const auth = getAuth(request);
    await assertPermission(rbac, auth.userId, 'write');
    const access = await shipmentAccess(rbac, auth.userId);
    response.status(201).json({ data: await service.createShipment(access, parsed.data.body) });
  },

  getShipment: async (request, response) => {
    const parsed = getShipmentSchema.safeParse({ params: request.params });
    if (!parsed.success) throw validationError(describeValidationIssues(parsed.error));
    const auth = getAuth(request);
    await assertPermission(rbac, auth.userId, 'read');
    response.json({ data: await service.getShipment(parsed.data.params.id) });
  },

  // Circuit state is operational detail, so it stays behind the same read
  // permission as the rest of the module rather than being exposed publicly.
  health: async (request, response) => {
    const auth = getAuth(request);
    await assertPermission(rbac, auth.userId, 'read');
    response.json({ data: service.health() });
  },
});
