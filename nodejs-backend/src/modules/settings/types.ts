import type { SettingKey } from './registry.js';

/**
 * Where the value in a DTO came from. `default` means no row exists yet and
 * the registry default is being served.
 */
export type SettingSource = 'database' | 'default';

export interface SettingDto {
  readonly key: SettingKey;
  readonly value: unknown;
  readonly description: string;
  readonly updatedById: string | null;
  /** ISO 8601 string so the DTO survives a JSON round trip through the cache. */
  readonly updatedAt: string | null;
  readonly source: SettingSource;
}

export interface SettingsAccess {
  readonly actorId: string;
  readonly ipAddress?: string;
}

export interface UpsertSettingData {
  readonly value: unknown;
  readonly description?: string | null | undefined;
}
