import type { Request, RequestHandler } from 'express';

import { AppError } from '../../common/errors/index.js';
import type { AuthContext } from '../../common/types/auth-context.js';
import type { RbacService } from '../rbac/service.js';
import type { AiService } from './service.js';
import { classifyInquirySchema, summariseDealSchema } from './validation.js';

/** Resource used for every RBAC check in this module. */
export const AI_RESOURCE = 'ai';
/** `ai:use` — the single permission guarding every assistant feature. */
export const AI_USE_PERMISSION = 'ai:use';

export interface AiController {
  readonly summariseDeal: RequestHandler;
  readonly classifyInquiry: RequestHandler;
}

const getAuth = (request: Request): AuthContext => {
  if (!request.auth) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  return request.auth;
};

const assertPermission = async (rbac: RbacService, actorId: string): Promise<void> => {
  const scope = await rbac.getPermissionScope(actorId, AI_RESOURCE, 'use');
  if (!scope) throw new AppError('Forbidden', 403, 'FORBIDDEN');
};

const invalid = (details: unknown): AppError =>
  new AppError('Invalid request', 400, 'VALIDATION_ERROR', details);

export const createAiController = (service: AiService, rbac: RbacService): AiController => ({
  summariseDeal: async (request, response) => {
    // Parsing strips every field that is not on the allow-list, so nothing the
    // caller invents can travel further into the prompt.
    const parsed = summariseDealSchema.safeParse({ body: request.body });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    await assertPermission(rbac, auth.userId);
    response.json({ data: await service.summariseDeal(parsed.data.body) });
  },

  classifyInquiry: async (request, response) => {
    const parsed = classifyInquirySchema.safeParse({ body: request.body });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    await assertPermission(rbac, auth.userId);
    response.json({ data: await service.classifyInquiry(parsed.data.body) });
  },
});
