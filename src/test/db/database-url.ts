const SAFE_TEST_DATABASE_NAMES = /(^|[-_])(test|testing)([-_]|$)/i;

export function assertSafeTestDatabaseUrl(databaseUrl = process.env.DATABASE_URL): string {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Database test helpers require NODE_ENV=test.');
  }

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for database tests.');
  }

  const parsed = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));

  if (!SAFE_TEST_DATABASE_NAMES.test(databaseName)) {
    throw new Error(
      `Refusing to reset database "${databaseName}": its name must contain test or testing.`,
    );
  }

  return databaseUrl;
}
