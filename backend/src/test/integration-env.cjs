// Plain CommonJS for the same reason as the env loader: the integration runner
// is an .mjs script, and the unit suite checks this logic with no storage up.

const { URL } = require('node:url');

const { assembleStorageUrls } = require('../config/load-env.cjs');

/** Used when the shared `.env` names no database; `_test` is appended to them. */
const DEFAULT_POSTGRES_DB = 'practice_crm';
const DEFAULT_MONGO_DB = 'practice_events';
const TEST_DATABASE_SUFFIX = '_test';

/** `test` or `testing` as a separate token: `crm_test` passes, `contest` does not. */
const SAFE_TEST_DATABASE_NAME = /(^|[-_])(test|testing)([-_]|$)/i;

const MAINTENANCE_DATABASE = 'postgres';

/**
 * Settings the test run never takes from `.env`: the suites must not depend on
 * the secrets of whoever runs them, and the cache keys of a run share the Redis
 * server with the development ones only under a prefix of their own.
 */
const FIXED_TEST_SETTINGS = {
  APP_ENV: 'test',
  REDIS_KEY_PREFIX: 'crm-test:',
  SEED_USER_PASSWORD: 'LocalTrainingOnly!2026',
  JWT_ACCESS_SECRET: 'integration-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'integration-refresh-secret-at-least-32-characters',
  LOG_LEVEL: 'silent',
};

/**
 * Each storage URL and the variable that overrides it for a test run. The
 * override has a name of its own on purpose: a working URL written in `.env`
 * must never become the test one by accident.
 */
const TEST_URL_OVERRIDES = [
  ['DATABASE_URL', 'DATABASE_URL_TEST'],
  ['REDIS_URL', 'REDIS_URL_TEST'],
  ['MONGODB_URL', 'MONGODB_URL_TEST'],
];

/** A setting as text, with a blank value treated as absent — the env loader's rule. */
const part = (env, name) => {
  const value = env[name]?.trim();
  return value ? value : undefined;
};

// A regular expression rather than `URL`: a MongoDB address may list several
// hosts, which the URL parser rejects.
const ADDRESS = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/?#]*)(?:\/([^?#]*))?/i;

/** `host:port` of a storage URL, without the credentials. */
const storageAddress = (url) => ADDRESS.exec(url)?.[1] ?? url;

/** The database a storage URL points at; empty when the URL names none. */
const databaseName = (url) => decodeURIComponent(ADDRESS.exec(url)?.[2] ?? '');

/** The same server and credentials, connected to the service database instead. */
const maintenanceDatabaseUrl = (databaseUrl) => {
  const url = new URL(databaseUrl);
  url.pathname = `/${MAINTENANCE_DATABASE}`;
  return url.toString();
};

const assertSafeName = (url, storage, override) => {
  const name = databaseName(url);
  if (!SAFE_TEST_DATABASE_NAME.test(name)) {
    throw new Error(
      `Refusing to run integration tests against the ${storage} database "${name}": ` +
        `its name must contain a separate test or testing token. Check ${override}.`,
    );
  }
};

const assertPostgresTestUrl = (databaseUrl) => {
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL_TEST must use the postgres or postgresql protocol.');
  }

  assertSafeName(databaseUrl, 'PostgreSQL', 'DATABASE_URL_TEST');

  const schema = url.searchParams.get('schema');
  if (schema && schema !== 'public') {
    throw new Error(
      'DATABASE_URL_TEST must use schema=public because the reset helper truncates public tables.',
    );
  }
};

const assertMongoTestUrl = (mongodbUrl) => {
  // A URL with no database lands in the driver's default one, which is `test`.
  if (databaseName(mongodbUrl)) assertSafeName(mongodbUrl, 'MongoDB', 'MONGODB_URL_TEST');
};

/**
 * The settings an integration run puts over the loaded environment `env`.
 *
 * The storage addresses come from the same parts as the application's — host,
 * port, user and password — with `_test` appended to each database name, so
 * the run needs no file of its own. An explicit `*_TEST` URL wins over the
 * assembled one; that is how CI points the run at its own services. A working
 * `DATABASE_URL`, `REDIS_URL` or `MONGODB_URL` in `env` is ignored.
 *
 * Throws when an address cannot be built or names a database the run must not
 * wipe.
 */
const integrationTestEnv = (env) => {
  const assembled = assembleStorageUrls({
    ...env,
    POSTGRES_DB: `${part(env, 'POSTGRES_DB') ?? DEFAULT_POSTGRES_DB}${TEST_DATABASE_SUFFIX}`,
    MONGO_DB: `${part(env, 'MONGO_DB') ?? DEFAULT_MONGO_DB}${TEST_DATABASE_SUFFIX}`,
  });

  const urls = {};
  for (const [name, override] of TEST_URL_OVERRIDES) {
    const url = part(env, override) ?? assembled[name];
    // Only the PostgreSQL address has parts without a default.
    if (!url) {
      throw new Error(
        `Cannot build the test database address: POSTGRES_USER and POSTGRES_PASSWORD are missing ` +
          `from the repository .env (npm run setup creates it), and ${override} is not set.`,
      );
    }
    urls[name] = url;
  }

  assertPostgresTestUrl(urls.DATABASE_URL);
  assertMongoTestUrl(urls.MONGODB_URL);

  return { ...urls, ...FIXED_TEST_SETTINGS };
};

module.exports = {
  databaseName,
  integrationTestEnv,
  maintenanceDatabaseUrl,
  storageAddress,
};
