import type { Request } from 'express';
import { z } from 'zod';

export const permissionScopes = ['ALL', 'OWN'] as const;
export type PermissionScope = (typeof permissionScopes)[number];

export interface PermissionKeyParts {
  readonly resource: string;
  readonly action: string;
}

export const createPermissionKey = (resource: string, action: string): string =>
  `${resource}:${action}`;

export const parsePermissionKey = (key: string): PermissionKeyParts | null => {
  const separator = key.indexOf(':');
  if (separator < 1 || separator === key.length - 1 || key.indexOf(':', separator + 1) !== -1) {
    return null;
  }
  return { resource: key.slice(0, separator), action: key.slice(separator + 1) };
};

/** Who is changing users or roles, as the audit trail records it. */
export interface Actor {
  readonly actorId: string;
  readonly ipAddress: string | null;
}

/** Audit vocabulary of role administration. */
export const ROLE_ENTITY_TYPE = 'role';
export const ROLE_CREATED = 'role.created';
export const ROLE_PERMISSIONS_REPLACED = 'role.permissions_replaced';

export interface PermissionRequirement {
  resource: string;
  action: string;
  ownerId?: (request: Request) => string | undefined | Promise<string | undefined>;
}

export const permissionSchema = z
  .object({
    resource: z.string(),
    action: z.string(),
    scope: z.enum(permissionScopes),
  })
  .meta({ id: 'Permission' });

export type PermissionRecord = z.infer<typeof permissionSchema>;

export interface CreateRoleData {
  name: string;
  description?: string | null;
  permissions: PermissionRecord[];
}

export interface ReplaceRolePermissionsData {
  permissions: PermissionRecord[];
}

export const roleSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    description: z.string().nullable(),
    permissions: z.array(permissionSchema),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .meta({ id: 'Role' });

export type RoleDto = z.infer<typeof roleSchema>;
