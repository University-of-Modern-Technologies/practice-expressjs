import {
  databaseName,
  integrationTestEnv,
  maintenanceDatabaseUrl,
  storageAddress,
} from './integration-env.cjs';

/** The shared `.env` as `npm run setup` writes it, with non-default ports. */
const PARTS: NodeJS.ProcessEnv = {
  POSTGRES_PORT: '15432',
  REDIS_PORT: '16379',
  MONGO_PORT: '27018',
  POSTGRES_DB: 'practice_crm',
  POSTGRES_USER: 'practice_crm',
  POSTGRES_PASSWORD: 'local-password',
  MONGO_DB: 'practice_events',
  MONGO_USER: 'practice_crm',
  MONGO_PASSWORD: 'local-password',
};

describe('integrationTestEnv', () => {
  it('builds the test addresses from the same parts, with _test databases', () => {
    const env = integrationTestEnv(PARTS);

    expect(env.DATABASE_URL).toBe(
      'postgresql://practice_crm:local-password@127.0.0.1:15432/practice_crm_test?schema=public',
    );
    expect(env.REDIS_URL).toBe('redis://127.0.0.1:16379');
    expect(env.MONGODB_URL).toBe(
      'mongodb://practice_crm:local-password@127.0.0.1:27018/practice_events_test?authSource=admin',
    );
  });

  it('falls back to the default database names when .env names none', () => {
    const env = integrationTestEnv({ POSTGRES_USER: 'crm', POSTGRES_PASSWORD: 'crm' });

    expect(databaseName(env.DATABASE_URL)).toBe('practice_crm_test');
    expect(databaseName(env.MONGODB_URL)).toBe('practice_events_test');
  });

  it('ignores the working URLs, so they never become the test ones', () => {
    const env = integrationTestEnv({
      ...PARTS,
      DATABASE_URL: 'postgresql://app:app@db.internal:5432/practice_crm?schema=public',
      REDIS_URL: 'redis://cache.internal:6379',
      MONGODB_URL: 'mongodb://events.internal:27017/practice_events',
    });

    expect(storageAddress(env.DATABASE_URL)).toBe('127.0.0.1:15432');
    expect(env.REDIS_URL).toBe('redis://127.0.0.1:16379');
    expect(storageAddress(env.MONGODB_URL)).toBe('127.0.0.1:27018');
  });

  it('lets an explicit *_TEST URL win over the assembled one', () => {
    const env = integrationTestEnv({
      ...PARTS,
      DATABASE_URL_TEST: 'postgresql://ci:secret@localhost:5432/crm_ci_test?schema=public',
      REDIS_URL_TEST: 'redis://localhost:6379',
      MONGODB_URL_TEST: 'mongodb://ci:secret@localhost:27017/events_test?authSource=admin',
    });

    expect(env.DATABASE_URL).toBe(
      'postgresql://ci:secret@localhost:5432/crm_ci_test?schema=public',
    );
    expect(env.REDIS_URL).toBe('redis://localhost:6379');
    expect(env.MONGODB_URL).toBe(
      'mongodb://ci:secret@localhost:27017/events_test?authSource=admin',
    );
  });

  it('treats a blank *_TEST URL as absent', () => {
    const env = integrationTestEnv({ ...PARTS, DATABASE_URL_TEST: ' ' });

    expect(databaseName(env.DATABASE_URL)).toBe('practice_crm_test');
  });

  it('fixes the test-only settings whatever .env says', () => {
    const env = integrationTestEnv({
      ...PARTS,
      APP_ENV: 'development',
      REDIS_KEY_PREFIX: 'crm:',
      JWT_ACCESS_SECRET: 'the-developer-secret-that-must-not-leak',
      LOG_LEVEL: 'debug',
    });

    expect(env).toMatchObject({
      APP_ENV: 'test',
      REDIS_KEY_PREFIX: 'crm-test:',
      JWT_ACCESS_SECRET: 'integration-access-secret-at-least-32-characters',
      LOG_LEVEL: 'silent',
    });
  });

  it('asks for the PostgreSQL credentials when the address cannot be built', () => {
    expect(() => integrationTestEnv({ POSTGRES_DB: 'crm' })).toThrow(
      /POSTGRES_USER and POSTGRES_PASSWORD.*DATABASE_URL_TEST/s,
    );
  });

  it.each([
    ['postgresql://ci:ci@localhost:5432/practice_crm?schema=public'],
    ['postgresql://ci:ci@localhost:5432/contest?schema=public'],
    ['postgresql://ci:ci@localhost:5432/testcrm?schema=public'],
  ])('refuses a PostgreSQL database without a test token: %s', (url) => {
    expect(() => integrationTestEnv({ ...PARTS, DATABASE_URL_TEST: url })).toThrow(
      /Refusing to run integration tests against the PostgreSQL database/,
    );
  });

  it('accepts the testing token and either protocol spelling', () => {
    const env = integrationTestEnv({
      ...PARTS,
      DATABASE_URL_TEST: 'postgres://ci:ci@localhost:5432/crm-testing',
    });

    expect(databaseName(env.DATABASE_URL)).toBe('crm-testing');
  });

  it('refuses a PostgreSQL URL with another protocol or schema', () => {
    expect(() =>
      integrationTestEnv({ ...PARTS, DATABASE_URL_TEST: 'mysql://ci:ci@localhost/crm_test' }),
    ).toThrow(/postgres or postgresql protocol/);
    expect(() =>
      integrationTestEnv({
        ...PARTS,
        DATABASE_URL_TEST: 'postgresql://ci:ci@localhost:5432/crm_test?schema=sales',
      }),
    ).toThrow(/schema=public/);
  });

  it('refuses a MongoDB database without a test token', () => {
    expect(() =>
      integrationTestEnv({
        ...PARTS,
        MONGODB_URL_TEST: 'mongodb://localhost:27017/practice_events',
      }),
    ).toThrow(/Refusing to run integration tests against the MongoDB database/);
  });

  it("accepts a MongoDB URL without a database, which lands in the driver's test one", () => {
    const env = integrationTestEnv({ ...PARTS, MONGODB_URL_TEST: 'mongodb://localhost:27017' });

    expect(env.MONGODB_URL).toBe('mongodb://localhost:27017');
  });
});

describe('storage URL helpers', () => {
  it('describes an address without the credentials', () => {
    expect(storageAddress('postgresql://u:p%40ss@db:5432/crm_test?schema=public')).toBe('db:5432');
    expect(storageAddress('redis://127.0.0.1:6379')).toBe('127.0.0.1:6379');
    expect(storageAddress('mongodb://u:p@m1:27017,m2:27017/events_test?replicaSet=rs')).toBe(
      'm1:27017,m2:27017',
    );
  });

  it('reads the database name, decoding it', () => {
    expect(databaseName('postgresql://u:p@db:5432/crm%5Ftest?schema=public')).toBe('crm_test');
    expect(databaseName('mongodb://m:27017/?authSource=admin')).toBe('');
  });

  it('points the same server and credentials at the service database', () => {
    expect(maintenanceDatabaseUrl('postgresql://u:p%40ss@db:5432/crm_test?schema=public')).toBe(
      'postgresql://u:p%40ss@db:5432/postgres?schema=public',
    );
  });
});
