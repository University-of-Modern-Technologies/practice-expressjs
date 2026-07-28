import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const safeDatabaseName = /(^|[-_])(test|testing)([-_]|$)/i;
const suites = [
  'tests/integration/auth.integration.test.ts',
  'tests/integration/contacts.integration.test.ts',
  'tests/integration/deals.integration.test.ts',
  'tests/integration/audit.integration.test.ts',
  'tests/integration/canonical-flow.integration.test.ts',
];

const commandExample = [
  "$env:RUN_DB_TESTS = 'true'",
  "$env:DATABASE_URL_TEST = 'postgresql://postgres:postgres@localhost:5432/practice_crm_test?schema=public'",
  'node .\\scripts\\test\\run-integration.mjs',
].join('\n');

if (process.env.RUN_DB_TESTS !== 'true') {
  console.log('Database integration tests skipped because RUN_DB_TESTS is not true.');
  console.log('Run them from the project root with:');
  console.log(commandExample);
  process.exit(0);
}

const databaseUrl = process.env.DATABASE_URL_TEST;
if (!databaseUrl) {
  throw new Error(`DATABASE_URL_TEST is required when RUN_DB_TESTS=true.\n\n${commandExample}`);
}

const parsedDatabaseUrl = new URL(databaseUrl);
if (!['postgres:', 'postgresql:'].includes(parsedDatabaseUrl.protocol)) {
  throw new Error('DATABASE_URL_TEST must use the postgres or postgresql protocol.');
}

const databaseName = decodeURIComponent(parsedDatabaseUrl.pathname.replace(/^\//, ''));
if (!safeDatabaseName.test(databaseName)) {
  throw new Error(
    `Refusing to run database tests against "${databaseName}": the database name must contain a separate test or testing token.`,
  );
}

const schema = parsedDatabaseUrl.searchParams.get('schema');
if (schema && schema !== 'public') {
  throw new Error(
    'DATABASE_URL_TEST must use schema=public because the reset helper truncates public tables.',
  );
}

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const mongodbUrl =
  process.env.MONGODB_URL ?? 'mongodb://localhost:27017/practice_events_test?authSource=admin';

const mongoDatabaseName = decodeURIComponent(new URL(mongodbUrl).pathname.replace(/^\//, ''));
if (mongoDatabaseName && !safeDatabaseName.test(mongoDatabaseName)) {
  throw new Error(
    `Refusing to run event store tests against "${mongoDatabaseName}": the database name must contain a separate test or testing token.`,
  );
}

const childEnv = {
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  MONGODB_URL: mongodbUrl,
  SEED_USER_PASSWORD: 'LocalTrainingOnly!2026',
  JWT_ACCESS_SECRET: 'integration-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'integration-refresh-secret-at-least-32-characters',
  LOG_LEVEL: 'silent',
};

const tsxCli = require.resolve('tsx/cli');
const jestCli = require.resolve('jest/bin/jest');

function run(label, entrypoint, args) {
  console.log(`\n> ${label}`);
  const result = spawnSync(process.execPath, [entrypoint, ...args], {
    cwd: projectRoot,
    env: childEnv,
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('Apply test database migrations', path.join(projectRoot, 'scripts/run-prisma.mjs'), [
  'migrate',
  'deploy',
]);

for (const suite of suites) {
  run(`Reset database before ${suite}`, tsxCli, ['scripts/test/reset-test-database.ts']);
  run(`Seed database before ${suite}`, tsxCli, ['prisma/seed.ts']);
  run(`Run ${suite}`, jestCli, [
    '--config',
    'tests/integration/jest.config.mjs',
    '--runInBand',
    '--runTestsByPath',
    suite,
  ]);
}
