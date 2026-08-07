import type { PrismaClient } from '@prisma/client';

import { assertSafeTestDatabaseUrl } from './database-url.js';

const TABLES_IN_DELETE_ORDER = [
  'audit_logs',
  'deals',
  'contacts',
  'role_permissions',
  'user_roles',
  'sessions',
  'permissions',
  'roles',
  'users',
] as const;

export async function resetDatabase(client: PrismaClient): Promise<void> {
  assertSafeTestDatabaseUrl();

  const quotedTables = TABLES_IN_DELETE_ORDER.map((table) => `"public"."${table}"`).join(', ');

  await client.$executeRawUnsafe(`TRUNCATE TABLE ${quotedTables} RESTART IDENTITY CASCADE`);
}
