import { z } from 'zod';

/**
 * bcrypt reads at most this many bytes of its input. A longer password is
 * refused at the boundary rather than silently cut, which would make every
 * password sharing the first 72 bytes equivalent.
 */
export const MAX_PASSWORD_BYTES = 72;

/**
 * A password as every endpoint accepts it. The character limit is what the
 * contract publishes; the byte limit underneath it is bcrypt's.
 */
export const passwordSchema = z
  .string()
  .min(8)
  .max(128)
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= MAX_PASSWORD_BYTES,
    `Password must not exceed ${MAX_PASSWORD_BYTES} bytes`,
  )
  .meta({ format: 'password' });

export const loginSchema = z.object({
  body: z.object({
    email: z
      .string()
      .trim()
      .email()
      .transform((value) => value.toLowerCase()),
    password: passwordSchema,
  }),
});

export type LoginInput = z.infer<typeof loginSchema>['body'];
