import { PrismaClient } from '@prisma/client';

import { assertSafeTestDatabaseUrl } from './database-url.js';

export function createTestPrismaClient(): PrismaClient {
  assertSafeTestDatabaseUrl();

  return new PrismaClient({
    log: process.env.DEBUG_DB_TESTS ? ['query', 'info', 'warn', 'error'] : ['warn', 'error'],
  });
}
