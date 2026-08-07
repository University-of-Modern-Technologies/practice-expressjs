/**
 * Composite readiness probe for the primary database.
 *
 * Splits the single opaque "database" failure into what actually broke: the
 * network path to Postgres, or a deploy that forgot to run
 * `prisma migrate deploy`. Those are different incidents for whoever is
 * paged, even though the public payload still reports one `database` entry,
 * exactly as every consumer of this probe already expects.
 */

import { readdirSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

import type { PrismaDatabase } from '../../db/prisma.js';
import { createCompositeReadinessCheck } from './composite.js';
import type { ReadinessCheck } from './readiness.js';

export class SchemaNotUpToDateError extends Error {
  constructor(expected: string, actual: string | undefined) {
    super(
      `Database schema is behind: migration "${expected}" is not applied ` +
        `(latest recorded: ${actual ?? 'none'})`,
    );
    this.name = 'SchemaNotUpToDateError';
  }
}

/**
 * Walks up from `startDirectory` until a `prisma/migrations` directory is
 * found. The compiled layout (`dist/app/health`) and the source layout
 * (`src/app/health`) both resolve to the project root this way, mirroring how
 * `service-info.ts` locates `package.json`.
 */
const findMigrationsDir = (startDirectory: string): string | undefined => {
  const { root } = parse(startDirectory);
  let current = startDirectory;

  for (;;) {
    const candidate = join(current, 'prisma', 'migrations');
    try {
      if (readdirSync(candidate).length > 0) return candidate;
    } catch {
      // Not the project root yet (or migrations were never generated); keep walking upwards.
    }

    if (current === root) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
};

/** The newest migration shipped with this build, read straight off disk. */
export const readLatestMigrationName = (startDirectory: string = __dirname): string | undefined => {
  const migrationsDir = findMigrationsDir(startDirectory);
  if (migrationsDir === undefined) return undefined;

  const names = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  // Migration folder names are timestamp-prefixed, so lexicographic order is
  // chronological order; the last one is the newest.
  return names.at(-1);
};

const checkSchemaApplied = async (
  prisma: PrismaDatabase,
  migrationsStartDirectory: string,
): Promise<void> => {
  const expected = readLatestMigrationName(migrationsStartDirectory);
  // Nothing shipped to check against — a checkout without any migration is
  // not this probe's problem to report.
  if (expected === undefined) return;

  const rows = await prisma.$queryRaw<{ migration_name: string }[]>`
    SELECT migration_name FROM "_prisma_migrations"
    WHERE migration_name = ${expected} AND finished_at IS NOT NULL AND rolled_back_at IS NULL
  `;

  if (rows.length === 0) {
    const latest = await prisma.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY finished_at DESC
      LIMIT 1
    `;
    throw new SchemaNotUpToDateError(expected, latest[0]?.migration_name);
  }
};

/**
 * Reports the database as one entry, backed by two independent probes: the
 * connection, and whether the schema on disk has actually been applied.
 *
 * @param migrationsStartDirectory Where to start walking for `prisma/migrations`;
 *   overridden by tests only, so they can point at a fixture instead of this
 *   repository's real migration history.
 */
export const createDatabaseReadinessCheck = (
  prisma: PrismaDatabase,
  migrationsStartDirectory: string = __dirname,
): ReadinessCheck =>
  createCompositeReadinessCheck({
    name: 'database',
    checks: [
      {
        name: 'connection',
        async check() {
          await prisma.$queryRaw`SELECT 1`;
        },
      },
      { name: 'schema', check: () => checkSchemaApplied(prisma, migrationsStartDirectory) },
    ],
  });
