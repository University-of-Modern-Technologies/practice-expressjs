import { z } from 'zod';

// The key is only shape-checked here; whether it is a declared key, and whether
// the value fits that key, is decided by the registry inside the service.
const settingKeyParams = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'Invalid setting key'),
});

export const getSettingSchema = z.object({ params: settingKeyParams });

export const upsertSettingSchema = z.object({
  params: settingKeyParams,
  body: z
    .object({
      value: z.unknown(),
      description: z.string().trim().max(255).nullable().optional(),
    })
    .refine((body) => 'value' in body, {
      message: 'A value is required',
      path: ['value'],
    }),
});

export const deleteSettingSchema = z.object({ params: settingKeyParams });
