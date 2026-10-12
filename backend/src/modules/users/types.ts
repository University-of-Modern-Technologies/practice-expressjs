import { z } from 'zod';

export const userRoleSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
  })
  .meta({ id: 'RoleSummary' });

export type UserRoleDto = z.infer<typeof userRoleSchema>;

export const userSchema = z
  .object({
    id: z.uuid(),
    email: z.email(),
    name: z.string(),
    isActive: z.boolean(),
    roles: z.array(userRoleSchema),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .meta({ id: 'User' });

export type UserDto = z.infer<typeof userSchema>;

export interface UserListResult {
  readonly items: readonly UserDto[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export const userSessionSchema = z
  .object({
    id: z.uuid(),
    userId: z.uuid(),
    expiresAt: z.date(),
    revokedAt: z.date().nullable(),
    ipAddress: z.string().nullable(),
    userAgent: z.string().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .meta({ id: 'UserSession' });

export type UserSessionDto = z.infer<typeof userSessionSchema>;

export interface CreateUserData {
  email: string;
  name: string;
  password: string;
  roleIds: string[];
}

export interface UpdateUserData {
  email?: string;
  name?: string;
  password?: string;
  roleIds?: string[];
}
