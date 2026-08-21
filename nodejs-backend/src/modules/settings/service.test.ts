import { describe, expect, it, jest } from '@jest/globals';

import type { CacheService } from '../../cache/cache.service.js';
import { AppError } from '../../common/errors/app-error.js';
import type { AuditService } from '../audit/service.js';
import { settingValueKey, settingsListKey } from './cache-keys.js';
import { createSettingsService, type SettingsDatabase } from './service.js';

interface StoredRow {
  id: string;
  key: string;
  value: unknown;
  description: string | null;
  updatedById: string | null;
  updatedAt: Date;
}

interface RecordingCache extends CacheService {
  readonly store: Map<string, unknown>;
  readonly deleted: string[];
  readonly reads: string[];
}

// In-memory stand-in that records what the service asks of the cache.
const createRecordingCache = (): RecordingCache => {
  const store = new Map<string, unknown>();
  const deleted: string[] = [];
  const reads: string[] = [];

  const cache: RecordingCache = {
    store,
    deleted,
    reads,
    async get<T>(key: string) {
      reads.push(key);
      return store.has(key) ? (store.get(key) as T) : null;
    },
    async set<T>(key: string, value: T) {
      store.set(key, value);
    },
    async remember<T>(key: string, _ttlSeconds: number, loader: () => Promise<T>) {
      const cached = await cache.get<T>(key);
      if (cached !== null) return cached;
      const value = await loader();
      await cache.set(key, value);
      return value;
    },
    async del(keys: string | readonly string[]) {
      for (const key of typeof keys === 'string' ? [keys] : keys) {
        deleted.push(key);
        store.delete(key);
      }
    },
    async invalidatePrefix() {
      store.clear();
    },
  };

  return cache;
};

// A cache that is completely unavailable: every operation rejects.
const createBrokenCache = (): CacheService => ({
  async get() {
    throw new Error('redis down');
  },
  async set() {
    throw new Error('redis down');
  },
  async remember() {
    throw new Error('redis down');
  },
  async del() {
    throw new Error('redis down');
  },
  async invalidatePrefix() {
    throw new Error('redis down');
  },
});

const row = (overrides: Partial<StoredRow> = {}): StoredRow => ({
  id: '90000000-0000-4000-8000-000000000001',
  key: 'organization.name',
  value: 'Stored Name',
  description: 'Display name of the organization.',
  updatedById: '10000000-0000-4000-8000-000000000001',
  updatedAt: new Date('2026-05-01T10:00:00.000Z'),
  ...overrides,
});

interface Harness {
  readonly db: SettingsDatabase;
  readonly audit: AuditService;
  readonly auditRecord: jest.Mock;
  readonly findUnique: jest.Mock;
  readonly findMany: jest.Mock;
  readonly upsert: jest.Mock;
  readonly remove: jest.Mock;
}

const createHarness = (rows: StoredRow[]): Harness => {
  const state = new Map(rows.map((entry) => [entry.key, entry]));

  // Every mock takes `unknown[]` so it matches the loose `jest.Mock` shape the
  // harness exposes; the arguments are narrowed at the point of use.
  const findUnique = jest.fn(async (...args: unknown[]) => {
    const { where } = args[0] as { where: { key: string } };
    return state.get(where.key) ?? null;
  });
  const findMany = jest.fn(async (...args: unknown[]) => {
    void args;
    return [...state.values()];
  });
  const upsert = jest.fn(async (...args: unknown[]) => {
    const options = args[0] as {
      where: { key: string };
      create: { key: string; value: unknown; description: string | null; updatedById: string };
    };
    const next = row({
      key: options.where.key,
      value: options.create.value,
      description: options.create.description,
      updatedById: options.create.updatedById,
    });
    state.set(options.where.key, next);
    return next;
  });
  const remove = jest.fn(async (...args: unknown[]) => {
    const { where } = args[0] as { where: { key: string } };
    const existing = state.get(where.key);
    state.delete(where.key);
    return existing ?? null;
  });

  const organizationSetting = { findUnique, findMany, upsert, delete: remove };
  const auditRecord = jest.fn(async (...args: unknown[]) => {
    void args;
    return {};
  });

  const db = {
    organizationSetting,
    $transaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
      callback({ organizationSetting, auditLog: { create: auditRecord } }),
  } as unknown as SettingsDatabase;

  return {
    db,
    audit: { record: auditRecord } as unknown as AuditService,
    auditRecord,
    findUnique,
    findMany,
    upsert,
    remove,
  };
};

const access = { actorId: '10000000-0000-4000-8000-000000000001', ipAddress: '10.0.0.1' };

describe('settings service', () => {
  it('reads from the database on a cache miss and serves the cache afterwards', async () => {
    const harness = createHarness([row()]);
    const cache = createRecordingCache();
    const service = createSettingsService(harness.db, harness.audit, cache);

    const first = await service.getByKey('organization.name');
    expect(first.value).toBe('Stored Name');
    expect(first.source).toBe('database');
    expect(first.updatedAt).toBe('2026-05-01T10:00:00.000Z');
    expect(harness.findUnique).toHaveBeenCalledTimes(1);

    const second = await service.getByKey('organization.name');
    expect(second).toEqual(first);
    // The second read was served from the cache, not from Postgres.
    expect(harness.findUnique).toHaveBeenCalledTimes(1);
    expect(cache.store.has(settingValueKey('organization.name'))).toBe(true);
  });

  it('falls back to the registry default when no row exists', async () => {
    const harness = createHarness([]);
    const service = createSettingsService(harness.db, harness.audit, createRecordingCache());

    const dto = await service.getByKey('warehouse.defaultCode');
    expect(dto.value).toBe('CENTRAL');
    expect(dto.source).toBe('default');
    expect(dto.updatedAt).toBeNull();
    expect(dto.updatedById).toBeNull();

    await expect(service.get('orders.numberPrefix')).resolves.toBe('ORD');
  });

  it('returns the typed value through get()', async () => {
    const harness = createHarness([row({ key: 'orders.numberPrefix', value: 'INV' })]);
    const service = createSettingsService(harness.db, harness.audit, createRecordingCache());

    const prefix: string = await service.get('orders.numberPrefix');
    expect(prefix).toBe('INV');
  });

  it('serves reads from the database when the cache is unavailable', async () => {
    const harness = createHarness([row()]);
    const service = createSettingsService(harness.db, harness.audit, createBrokenCache());

    await expect(service.getByKey('organization.name')).resolves.toMatchObject({
      value: 'Stored Name',
    });
    expect(harness.findUnique).toHaveBeenCalledTimes(1);
  });

  it('surfaces a database failure instead of retrying the loader', async () => {
    const harness = createHarness([]);
    harness.findUnique.mockImplementation(async () => {
      throw new Error('database down');
    });
    const service = createSettingsService(harness.db, harness.audit, createBrokenCache());

    await expect(service.getByKey('organization.name')).rejects.toThrow('database down');
    expect(harness.findUnique).toHaveBeenCalledTimes(1);
  });

  it('lists every declared key, mixing stored rows with defaults', async () => {
    const harness = createHarness([row()]);
    const service = createSettingsService(harness.db, harness.audit, createRecordingCache());

    const list = await service.list();
    expect(list).toHaveLength(4);
    expect(list.map((entry) => entry.source).sort()).toEqual([
      'database',
      'default',
      'default',
      'default',
    ]);
  });

  it('validates the value, records an audit entry and invalidates the cache on write', async () => {
    const harness = createHarness([row()]);
    const cache = createRecordingCache();
    const service = createSettingsService(harness.db, harness.audit, cache);

    await service.getByKey('organization.name');
    expect(cache.store.has(settingValueKey('organization.name'))).toBe(true);

    const dto = await service.upsert(access, 'organization.name', { value: '  Acme  ' });
    expect(dto.value).toBe('Acme');
    expect(harness.upsert).toHaveBeenCalledTimes(1);
    expect(harness.auditRecord).toHaveBeenCalledTimes(1);

    const auditEvent = harness.auditRecord.mock.calls[0]?.[1] as {
      action: string;
      entityType: string;
      actorId: string;
      ipAddress?: string;
    };
    expect(auditEvent.action).toBe('setting.updated');
    expect(auditEvent.entityType).toBe('organization_setting');
    expect(auditEvent.actorId).toBe(access.actorId);
    expect(auditEvent.ipAddress).toBe('10.0.0.1');

    expect(cache.deleted).toEqual([settingValueKey('organization.name'), settingsListKey()]);
    expect(cache.store.has(settingValueKey('organization.name'))).toBe(false);

    // The next read reloads from the database and sees the new value.
    await expect(service.getByKey('organization.name')).resolves.toMatchObject({
      value: 'Acme',
    });
  });

  it('records who changed a setting', async () => {
    const harness = createHarness([]);
    const service = createSettingsService(harness.db, harness.audit, createRecordingCache());

    const dto = await service.upsert(access, 'organization.defaultCurrency', { value: 'eur' });
    expect(dto.value).toBe('EUR');
    expect(dto.updatedById).toBe(access.actorId);
    const upsertArgs = harness.upsert.mock.calls[0]?.[0] as {
      create: { updatedById: string; value: unknown };
    };
    expect(upsertArgs.create.updatedById).toBe(access.actorId);
    // The normalised value is stored, not the raw request body.
    expect(upsertArgs.create.value).toBe('EUR');
  });

  it('rejects an unknown key on write without touching the database', async () => {
    const harness = createHarness([]);
    const service = createSettingsService(harness.db, harness.audit, createRecordingCache());

    await expect(service.upsert(access, 'organization.unknown', { value: 'x' })).rejects.toThrow(
      AppError,
    );
    expect(harness.upsert).not.toHaveBeenCalled();
  });

  it('rejects an invalid value on write without touching the database', async () => {
    const harness = createHarness([]);
    const service = createSettingsService(harness.db, harness.audit, createRecordingCache());

    await expect(
      service.upsert(access, 'organization.defaultCurrency', { value: 'EURO' }),
    ).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' });
    expect(harness.upsert).not.toHaveBeenCalled();
  });

  it('deletes a stored setting and falls back to the default afterwards', async () => {
    const harness = createHarness([row()]);
    const cache = createRecordingCache();
    const service = createSettingsService(harness.db, harness.audit, cache);

    await service.getByKey('organization.name');
    await service.remove(access, 'organization.name');

    expect(harness.remove).toHaveBeenCalledTimes(1);
    expect(cache.deleted).toEqual([settingValueKey('organization.name'), settingsListKey()]);

    const after = await service.getByKey('organization.name');
    expect(after.source).toBe('default');
    expect(after.value).toBe('Training CRM');
  });

  it('reports a missing row on delete as a 404', async () => {
    const harness = createHarness([]);
    const service = createSettingsService(harness.db, harness.audit, createRecordingCache());

    await expect(service.remove(access, 'organization.name')).rejects.toMatchObject({
      code: 'SETTING_NOT_FOUND',
      statusCode: 404,
    });
  });
});
