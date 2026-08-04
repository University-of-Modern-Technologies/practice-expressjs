import type { Request, RequestHandler } from 'express';
import { AppError } from '../../common/errors/app-error.js';
import type { UsersService } from './service.js';
import type { CreateUserData, UpdateUserData } from './types.js';

export interface UsersController {
  list: RequestHandler;
  getById: RequestHandler;
  listSessions: RequestHandler;
  revokeSession: RequestHandler;
  create: RequestHandler;
  update: RequestHandler;
  disable: RequestHandler;
}

const requireParam = (request: Request, name: string): string => {
  const value = request.params[name];
  if (typeof value !== 'string')
    throw new AppError(`Missing ${name}`, 400, 'INVALID_PATH_PARAMETER');
  return value;
};

export const createUsersController = (usersService: UsersService): UsersController => ({
  list: async (request, response) => {
    const page = Number(request.query.page ?? 1);
    const pageSize = Number(request.query.pageSize ?? 20);
    response.status(200).json({ data: await usersService.list(page, pageSize) });
  },
  getById: async (request, response) => {
    response.status(200).json({ data: await usersService.getById(requireParam(request, 'id')) });
  },
  listSessions: async (request, response) => {
    response.status(200).json({
      data: await usersService.listSessions(requireParam(request, 'id')),
    });
  },
  revokeSession: async (request, response) => {
    await usersService.revokeSession(
      requireParam(request, 'id'),
      requireParam(request, 'sessionId'),
    );
    response.status(204).send();
  },
  create: async (request, response) => {
    response.status(201).json({ data: await usersService.create(request.body as CreateUserData) });
  },
  update: async (request, response) => {
    response.status(200).json({
      data: await usersService.update(requireParam(request, 'id'), request.body as UpdateUserData),
    });
  },
  disable: async (request, response) => {
    response.status(200).json({ data: await usersService.disable(requireParam(request, 'id')) });
  },
});
