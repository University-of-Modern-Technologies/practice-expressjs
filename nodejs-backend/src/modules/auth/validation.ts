import { z } from 'zod';

export const loginSchema = z.object({
  body: z.object({
    email: z
      .string()
      .trim()
      .email()
      .transform((value) => value.toLowerCase()),
    password: z.string().min(8).max(128),
  }),
});

export type LoginInput = z.infer<typeof loginSchema>['body'];
