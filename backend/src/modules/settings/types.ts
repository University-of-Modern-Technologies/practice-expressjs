import { z } from 'zod';

import { settingKeys } from './registry.js';

export const settingKeySchema = z.enum(settingKeys).meta({ id: 'SettingKey' });

/**
 * Where the value in a DTO came from. `default` means no row exists yet and
 * the registry default is being served.
 */
export const settingSourceSchema = z.enum(['database', 'default']).meta({
  description: '`default` означає, що рядка ще немає і віддано значення з реєстру.',
});

export type SettingSource = z.infer<typeof settingSourceSchema>;

export const settingSchema = z
  .object({
    key: settingKeySchema,
    value: z.unknown().meta({
      description: 'Тип значення визначає реєстр налаштувань для конкретного ключа.',
    }),
    description: z.string(),
    updatedById: z.uuid().nullable(),
    // An ISO 8601 string so the DTO survives a JSON round trip through the cache.
    updatedAt: z.iso.datetime().nullable(),
    source: settingSourceSchema,
  })
  .meta({ id: 'Setting' });

export type SettingDto = Readonly<z.infer<typeof settingSchema>>;

export interface SettingsAccess {
  readonly actorId: string;
  readonly ipAddress?: string;
}

export interface UpsertSettingData {
  readonly value: unknown;
  readonly description?: string | null | undefined;
}
