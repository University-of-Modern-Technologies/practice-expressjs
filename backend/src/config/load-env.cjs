// Plain CommonJS on purpose: the compiled application, the seeds run by tsx and
// the .mjs maintenance scripts all load the environment through this one file.

const path = require('node:path');
const process = require('node:process');

const dotenv = require('dotenv');

/** `src/config` and `dist/config` both sit two levels below the backend folder. */
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

const DEFAULT_APP_ENV = 'development';

// An IPv4 literal rather than `localhost`: on Windows the name resolves to IPv6
// first, and every connection to a storage listening on IPv4 only waits two
// seconds for that attempt to time out.
const DEFAULT_STORAGE_HOST = '127.0.0.1';
const DEFAULT_POSTGRES_PORT = '5432';
const DEFAULT_REDIS_PORT = '6379';
const DEFAULT_MONGO_PORT = '27017';

/** A setting as text, with a blank value treated as absent. */
const part = (env, name) => {
  const value = env[name]?.trim();
  return value ? value : undefined;
};

const credentials = (user, password) =>
  `${encodeURIComponent(user)}:${encodeURIComponent(password)}@`;

const postgresUrl = (env) => {
  const user = part(env, 'POSTGRES_USER');
  const password = part(env, 'POSTGRES_PASSWORD');
  const database = part(env, 'POSTGRES_DB');
  if (!user || !password || !database) return undefined;

  const host = part(env, 'POSTGRES_HOST') ?? DEFAULT_STORAGE_HOST;
  const port = part(env, 'POSTGRES_PORT') ?? DEFAULT_POSTGRES_PORT;
  return `postgresql://${credentials(user, password)}${host}:${port}/${encodeURIComponent(database)}?schema=public`;
};

const redisUrl = (env) => {
  const host = part(env, 'REDIS_HOST') ?? DEFAULT_STORAGE_HOST;
  const port = part(env, 'REDIS_PORT') ?? DEFAULT_REDIS_PORT;
  return `redis://${host}:${port}`;
};

const mongodbUrl = (env) => {
  const database = part(env, 'MONGO_DB');
  if (!database) return undefined;

  const host = part(env, 'MONGO_HOST') ?? DEFAULT_STORAGE_HOST;
  const port = part(env, 'MONGO_PORT') ?? DEFAULT_MONGO_PORT;
  const address = `${host}:${port}/${encodeURIComponent(database)}`;
  const user = part(env, 'MONGO_USER');
  const password = part(env, 'MONGO_PASSWORD');
  if (!user || !password) return `mongodb://${address}`;
  return `mongodb://${credentials(user, password)}${address}?authSource=admin`;
};

const ASSEMBLERS = [
  ['DATABASE_URL', postgresUrl],
  ['REDIS_URL', redisUrl],
  ['MONGODB_URL', mongodbUrl],
];

/**
 * Fills `env` from three layers, highest priority first: the variables the
 * process already has, the backend's own `.env`, and the repository's shared
 * `.env` one level up. A missing file is skipped.
 *
 * Afterwards `APP_ENV` is settled and copied into `NODE_ENV`, so libraries see
 * the same environment as the application, and every storage URL that was not
 * given in full is assembled from its parts. An explicit URL always wins; when
 * a required part is missing the URL stays unset, so configuration validation
 * names it instead of a connection failing later against a half-built address.
 */
const loadEnv = (options = {}) => {
  const env = options.env ?? process.env;
  const backendRoot = options.backendRoot ?? BACKEND_ROOT;

  // Captured before the files are read: an environment the process was started
  // with outranks anything a file says, even when it arrives only as the legacy
  // `NODE_ENV` (Jest sets `NODE_ENV=test` and nothing else).
  const givenAppEnv = part(env, 'APP_ENV') ?? part(env, 'NODE_ENV');

  dotenv.config({
    path: [path.join(backendRoot, '.env'), path.join(backendRoot, '..', '.env')],
    processEnv: env,
    quiet: true,
  });

  const appEnv = givenAppEnv ?? part(env, 'APP_ENV') ?? part(env, 'NODE_ENV') ?? DEFAULT_APP_ENV;
  env.APP_ENV = appEnv;
  env.NODE_ENV = appEnv;

  for (const [name, assemble] of ASSEMBLERS) {
    if (part(env, name)) continue;

    const url = assemble(env);
    if (url) env[name] = url;
    else delete env[name];
  }

  return env;
};

module.exports = { loadEnv };
