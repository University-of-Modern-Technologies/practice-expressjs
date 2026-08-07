import type { RequestHandler } from 'express';
import { z } from 'zod';
import { createPermissionKey } from './types.js';

const permissionPartSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[a-z][a-z0-9_-]*$/,
    'Must start with a lowercase letter and contain only lowercase letters, digits, underscores, or hyphens',
  );

const permissionAssignmentSchema = z
  .object({
    resource: permissionPartSchema,
    action: permissionPartSchema,
    scope: z.enum(['ALL', 'OWN']),
  })
  .strict()
  .refine(
    ({ resource, action }) => createPermissionKey(resource, action).length <= 100,
    'Permission key must not exceed 100 characters',
  );

const permissionAssignmentsSchema = z
  .array(permissionAssignmentSchema)
  .max(100)
  .superRefine((permissions, context) => {
    const indexesByKey = new Map<string, number>();
    permissions.forEach((permission, index) => {
      const key = createPermissionKey(permission.resource, permission.action);
      const previousIndex = indexesByKey.get(key);
      if (previousIndex !== undefined) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: `Duplicate permission key: ${key}`,
        });
        return;
      }
      indexesByKey.set(key, index);
    });
  });

const roleIdParamsSchema = z.object({ id: z.string().uuid() }).strict();

export const permissionKeySchema = z.object({
  params: z
    .object({
      resource: permissionPartSchema,
      action: permissionPartSchema,
    })
    .strict(),
});

export const createRoleSchema = z.object({
  body: z
    .object({
      name: z.string().trim().min(1).max(64),
      description: z.string().trim().min(1).max(255).nullable().optional(),
      permissions: permissionAssignmentsSchema,
    })
    .strict(),
});

export const replaceRolePermissionsSchema = z.object({
  params: roleIdParamsSchema,
  body: z.object({ permissions: permissionAssignmentsSchema }).strict(),
});

export const permissionScopeSchema = z.enum(['ALL', 'OWN']);

export const validatePermissionKey: RequestHandler = async (request, _response, next) => {
  await permissionKeySchema.parseAsync({ params: request.params });
  next();
};
