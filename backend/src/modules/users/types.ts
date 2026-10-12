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

/** Machine codes of the refusals this module adds on top of the shared ones. */
export const CANNOT_DISABLE_SELF = 'CANNOT_DISABLE_SELF';
export const LAST_ACTIVE_ADMIN = 'LAST_ACTIVE_ADMIN';

/**
 * The role whose last active holder may not be disabled or stripped of it:
 * without one, nobody is left who can administer accounts.
 */
export const ADMIN_ROLE_NAME = 'admin';

/** Audit vocabulary of this module. */
export const USER_ENTITY_TYPE = 'user';
export const SESSION_ENTITY_TYPE = 'session';
export const USER_CREATED = 'user.created';
export const USER_UPDATED = 'user.updated';
export const USER_DISABLED = 'user.disabled';
export const SESSION_REVOKED = 'session.revoked';
