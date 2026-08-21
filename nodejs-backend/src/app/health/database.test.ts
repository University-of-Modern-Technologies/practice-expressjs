import { join } from 'node:path';

import { describe, expect, it, jest } from '@jest/globals';

import type { PrismaDatabase } from '../../db/prisma.js';
import { createDatabaseReadinessCheck, readLatestMigrationName } from './database.js';
import { runReadinessChecks } from './readiness.js';

const FIXTURE_PROJECT = join(__dirname, '__fixtures__/schema-check-project');
const LATEST_MIGRATION = '20250101000000_initial';

const fakePrisma = (rows: { migration_name: string }[]): PrismaDatabase =>
  ({
    $queryRaw: jest.fn(() => Promise.resolve(rows)),
  }) as unknown as PrismaDatabase;

describe('readLatestMigrationName', () => {
  it('finds the newest migration folder by walking up to the project root', () => {
    expect(readLatestMigrationName(FIXTURE_PROJECT)).toBe(LATEST_MIGRATION);
  });
});

describe('createDatabaseReadinessCheck', () => {
  it('reports up as a single "database" entry when both sub-checks pass', async () => {
    const prisma = fakePrisma([{ migration_name: LATEST_MIGRATION }]);
    const check = createDatabaseReadinessCheck(prisma, FIXTURE_PROJECT);

    const [result] = await runReadinessChecks([check]);

    expect(result).toMatchObject({ name: 'database', status: 'up', critical: true });
  });

  it('fails as "database" when the connection query rejects', async () => {
    const prisma = {
      $queryRaw: jest.fn(() => Promise.reject(new Error('connect ECONNREFUSED'))),
    } as unknown as PrismaDatabase;
    const check = createDatabaseReadinessCheck(prisma, FIXTURE_PROJECT);

    const [result] = await runReadinessChecks([check]);

    expect(result?.name).toBe('database');
    expect(result?.status).toBe('down');
    // The exact cause never reaches the payload — asserted at the router level
    // already — but the log-only error should still name the piece that broke.
    expect(String(result?.error)).toMatch(/connection|schema/);
  });

  it('fails as "database" when the newest migration was never applied', async () => {
    const prisma = fakePrisma([]);
    const check = createDatabaseReadinessCheck(prisma, FIXTURE_PROJECT);

    const [result] = await runReadinessChecks([check]);

    expect(result?.name).toBe('database');
    expect(result?.status).toBe('down');
    expect(String(result?.error)).toContain('schema');
  });
});
