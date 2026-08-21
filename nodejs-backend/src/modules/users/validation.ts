import { z } from 'zod';

const userIdParams = z.object({ id: z.string().uuid() });
const roleIdsSchema = z.array(z.string().uuid()).min(1).max(20);

export const listUsersSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  }),
});

export const getUserSchema = z.object({ params: userIdParams });

export const listUserSessionsSchema = z.object({ params: userIdParams });

export const revokeUserSessionSchema = z.object({
  params: userIdParams.extend({ sessionId: z.string().uuid() }),
});

export const createUserSchema = z.object({
  body: z.object({
    email: z
      .string()
      .trim()
      .email()
      .transform((value) => value.toLowerCase()),
    name: z.string().trim().min(1).max(120),
    password: z.string().min(8).max(128),
    roleIds: roleIdsSchema,
  }),
});

export const updateUserSchema = z.object({
  params: userIdParams,
  body: z
    .object({
      email: z
        .string()
        .trim()
        .email()
        .transform((value) => value.toLowerCase())
        .optional(),
      name: z.string().trim().min(1).max(120).optional(),
      password: z.string().min(8).max(128).optional(),
      roleIds: roleIdsSchema.optional(),
    })
    .refine((value) => Object.keys(value).length > 0, 'At least one field is required'),
});

export const disableUserSchema = z.object({ params: userIdParams });
