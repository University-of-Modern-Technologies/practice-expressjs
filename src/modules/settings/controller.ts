import type { Request, RequestHandler } from 'express';

import { AppError } from '../../common/errors/app-error.js';
import type { AuthContext } from '../../common/types/auth-context.js';
import type { SettingsService } from './service.js';
import type { SettingsAccess } from './types.js';
import { deleteSettingSchema, getSettingSchema, upsertSettingSchema } from './validation.js';

export interface SettingsController {
  readonly list: RequestHandler;
  readonly getByKey: RequestHandler;
  readonly upsert: RequestHandler;
  readonly remove: RequestHandler;
}

const getAuth = (request: Request): AuthContext => {
  if (!request.auth) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  return request.auth;
};

const accessFor = (request: Request, actorId: string): SettingsAccess => ({
  actorId,
  ...(request.ip ? { ipAddress: request.ip } : {}),
});

const invalid = (details: unknown): AppError =>
  new AppError('Invalid request', 400, 'VALIDATION_ERROR', details);

export const createSettingsController = (service: SettingsService): SettingsController => ({
  list: async (_request, response) => {
    response.json({ data: await service.list() });
  },

  getByKey: async (request, response) => {
    const parsed = getSettingSchema.safeParse({ params: request.params });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    response.json({ data: await service.getByKey(parsed.data.params.key) });
  },

  upsert: async (request, response) => {
    const parsed = upsertSettingSchema.safeParse({
      params: request.params,
      body: request.body,
    });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    const { value, description } = parsed.data.body;
    response.json({
      data: await service.upsert(accessFor(request, auth.userId), parsed.data.params.key, {
        value,
        ...(description === undefined ? {} : { description }),
      }),
    });
  },

  remove: async (request, response) => {
    const parsed = deleteSettingSchema.safeParse({ params: request.params });
    if (!parsed.success) throw invalid(parsed.error.flatten());
    const auth = getAuth(request);
    await service.remove(accessFor(request, auth.userId), parsed.data.params.key);
    response.status(204).end();
  },
});
