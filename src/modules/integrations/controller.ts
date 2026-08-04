import type { Request, RequestHandler } from 'express';

import { AppError } from '../../common/errors/index.js';
import type { AuthContext } from '../../common/types/auth-context.js';
import type { RbacService } from '../rbac/service.js';
import type { IntegrationsService } from './service.js';
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

const invalid = (details: unknown): AppError =>
  new AppError('Invalid request', 400, 'VALIDATION_ERROR', details);

export const createIntegrationsController = (
  service: IntegrationsService,
  rbac: RbacService,
): IntegrationsController => ({
  createQuote: async (request, response) => {
    const parsed = createQuoteSchema.safeParse({ body: request.body });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    await assertPermission(rbac, auth.userId, 'read');
    response.json({ data: await service.requestQuote(parsed.data.body) });
  },

  createShipment: async (request, response) => {
    const parsed = createShipmentSchema.safeParse({ body: request.body });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    await assertPermission(rbac, auth.userId, 'write');
    response.status(201).json({ data: await service.createShipment(parsed.data.body) });
  },

  getShipment: async (request, response) => {
    const parsed = getShipmentSchema.safeParse({ params: request.params });
    if (!parsed.success) throw invalid(parsed.error.flatten());
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
