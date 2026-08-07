import { createNoopCacheService, type CacheService } from '../../cache/cache.service.js';
import { AppError } from '../../common/errors/app-error.js';
import type { Prisma, PrismaDatabase } from '../../db/prisma.js';
import type { AuditService } from '../audit/service.js';
import { settingValueKey, settingsListKey } from './cache-keys.js';
import {
  ensureSettingKey,
  parseSettingValue,
  readStoredValue,
  settingDefinition,
  settingKeys,
  type SettingKey,
  type SettingValue,
} from './registry.js';
import type { SettingDto, SettingsAccess, UpsertSettingData } from './types.js';

interface SettingRow {
  readonly id: string;
  readonly key: string;
  readonly value: unknown;
  readonly description: string | null;
  readonly updatedById: string | null;
  readonly updatedAt: Date;
}

export type SettingsDatabase = Pick<PrismaDatabase, '$transaction' | 'organizationSetting'>;

export interface SettingsService {
  list(): Promise<readonly SettingDto[]>;
  getByKey(key: string): Promise<SettingDto>;
  /** Typed accessor for other modules; falls back to the registry default. */
  get<K extends SettingKey>(key: K): Promise<SettingValue<K>>;
  upsert(access: SettingsAccess, key: string, data: UpsertSettingData): Promise<SettingDto>;
  remove(access: SettingsAccess, key: string): Promise<void>;
}

const DEFAULT_SETTINGS_TTL_SECONDS = 300;

const settingSelection = {
  id: true,
  key: true,
  value: true,
  description: true,
  updatedById: true,
  updatedAt: true,
};

const toDto = (key: SettingKey, row: SettingRow | null): SettingDto => {
  const definition = settingDefinition(key);
  if (!row) {
    return {
      key,
      value: definition.defaultValue,
      description: definition.description,
      updatedById: null,
      updatedAt: null,
      source: 'default',
    };
  }
  return {
    key,
    value: readStoredValue(key, row.value),
    description: row.description ?? definition.description,
    updatedById: row.updatedById,
    updatedAt: row.updatedAt.toISOString(),
    source: 'database',
  };
};

/**
 * @param db      Prisma client (or any object exposing the two members used).
 * @param audit   Writes the audit entry inside the same transaction as the change.
 * @param cache   Injectable so tests need no Redis; the no-op fallback makes
 *                every read a miss and discards every write.
 * @param ttlSeconds Lifetime of a cached settings entry.
 */
export const createSettingsService = (
  db: SettingsDatabase,
  audit: AuditService,
  cache: CacheService = createNoopCacheService(),
  ttlSeconds: number = DEFAULT_SETTINGS_TTL_SECONDS,
): SettingsService => {
  /**
   * `CacheService` already fails open, but the dependency is injectable and a
   * different implementation might not: a cache outage must degrade latency,
   * never turn a read into an error. The loader is never run twice, so a real
   * database failure still surfaces.
   */
  const rememberSafely = async <T>(key: string, loader: () => Promise<T>): Promise<T> => {
    let loaderRan = false;
    const guarded = async (): Promise<T> => {
      loaderRan = true;
      return loader();
    };
    try {
      return await cache.remember(key, ttlSeconds, guarded);
    } catch (error) {
      if (loaderRan) throw error;
      return loader();
    }
  };

  // Every write drops the entry for the key and the list entry that contains
  // it. Cache failures are swallowed: the entries expire on their own.
  const invalidate = async (key: SettingKey): Promise<void> => {
    try {
      await cache.del([settingValueKey(key), settingsListKey()]);
    } catch {
      // Intentionally ignored; see above.
    }
  };

  const findRow = async (key: SettingKey): Promise<SettingRow | null> =>
    db.organizationSetting.findUnique({ where: { key }, select: settingSelection });

  const service: SettingsService = {
    async list() {
      return rememberSafely(settingsListKey(), async () => {
        const rows = await db.organizationSetting.findMany({
          where: { key: { in: [...settingKeys] } },
          select: settingSelection,
        });
        const byKey = new Map(rows.map((row) => [row.key, row]));
        // Declared keys without a row are still listed, showing their default.
        return settingKeys.map((key) => toDto(key, byKey.get(key) ?? null));
      });
    },

    async getByKey(rawKey) {
      const key = ensureSettingKey(rawKey);
      return rememberSafely(settingValueKey(key), async () => toDto(key, await findRow(key)));
    },

    async get(key) {
      const dto = await service.getByKey(key);
      return dto.value as SettingValue<typeof key>;
    },

    async upsert(access, rawKey, data) {
      const key = ensureSettingKey(rawKey);
      const value = parseSettingValue(key, data.value) as Prisma.InputJsonValue;
      const description = data.description ?? settingDefinition(key).description;

      const dto = await db.$transaction(async (transaction) => {
        const before = await transaction.organizationSetting.findUnique({
          where: { key },
          select: settingSelection,
        });
        const row = await transaction.organizationSetting.upsert({
          where: { key },
          create: { key, value, description, updatedById: access.actorId },
          update: { value, description, updatedById: access.actorId },
          select: settingSelection,
        });
        const after = toDto(key, row);
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'setting.updated',
          entityType: 'organization_setting',
          entityId: row.id,
          changes: { before: before ? toDto(key, before) : null, after },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
        return after;
      });

      await invalidate(key);
      return dto;
    },

    async remove(access, rawKey) {
      const key = ensureSettingKey(rawKey);

      await db.$transaction(async (transaction) => {
        const existing = await transaction.organizationSetting.findUnique({
          where: { key },
          select: settingSelection,
        });
        if (!existing) throw new AppError('Setting not found', 404, 'SETTING_NOT_FOUND', { key });
        await transaction.organizationSetting.delete({ where: { key } });
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'setting.deleted',
          entityType: 'organization_setting',
          entityId: existing.id,
          // Removing a row restores the registry default rather than erasing
          // the setting, which is what `after` reflects.
          changes: { before: toDto(key, existing), after: toDto(key, null) },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
      });

      await invalidate(key);
    },
  };

  return service;
};
