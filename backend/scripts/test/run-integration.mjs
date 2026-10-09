import { spawnSync } from 'node:child_process';
import console from 'node:console';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadEnv } from '../../src/config/load-env.cjs';
import {
  databaseName,
  integrationTestEnv,
  maintenanceDatabaseUrl,
  storageAddress,
} from '../../src/test/integration-env.cjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const startStorageHint = 'Start the storage from the repository root: npm run start:infra';
// Long enough for a storage that is up, short enough not to keep a student
// waiting on one that is not.
const responseTimeoutMs = 3_000;
// Read from disk rather than kept by hand: a suite that is written but not
// listed does not fail, it simply never runs, and the summary says nothing
// about it. The directory is the list.
const suiteDirectory = 'tests/integration';
const suites = fs
  .readdirSync(path.join(projectRoot, suiteDirectory))
  .filter((name) => name.endsWith('.integration.test.ts'))
  .sort()
  .map((name) => `${suiteDirectory}/${name}`);

/** The first meaningful line: driver errors carry a paragraph of advice after it. */
const reasonOf = (error) =>
  String(error instanceof Error ? error.message : error)
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('Invalid `')) ?? 'no response';

function fail(lines) {
  console.error(`\n${lines.join('\n')}`);
  process.exit(1);
}

// The same layers the application reads, loaded into a copy: the working
// addresses stay out of the run, only their parts are used.
let testEnv;
try {
  testEnv = integrationTestEnv(loadEnv({ env: { ...process.env } }));
} catch (error) {
  fail([reasonOf(error)]);
}

const storages = [
  {
    name: 'PostgreSQL',
    address: `${storageAddress(testEnv.DATABASE_URL)}/${databaseName(testEnv.DATABASE_URL)}`,
    prepare: () => preparePostgres(testEnv.DATABASE_URL),
  },
  {
    name: 'Redis',
    address: `${storageAddress(testEnv.REDIS_URL)} (keys under ${testEnv.REDIS_KEY_PREFIX})`,
    prepare: () => pingRedis(testEnv.REDIS_URL),
  },
  {
    name: 'MongoDB',
    address: `${storageAddress(testEnv.MONGODB_URL)}/${databaseName(testEnv.MONGODB_URL)}`,
    prepare: () => pingMongo(testEnv.MONGODB_URL),
  },
];

/**
 * Reaches the test database and creates it when the server does not have it
 * yet. Only then is the service database touched: a server that already holds
 * the test database needs no rights beyond it.
 */
async function preparePostgres(databaseUrl) {
  const { PrismaClient } = require('@prisma/client');
  const connect = async (url) => {
    const client = new PrismaClient({ datasourceUrl: url });
    await client.$connect();
    return client;
  };

  try {
    await (await connect(databaseUrl)).$disconnect();
    return;
  } catch (error) {
    // P1003: the server answered, the database does not exist.
    if (error?.errorCode !== 'P1003') throw error;
  }

  const name = databaseName(databaseUrl);
  const admin = await connect(maintenanceDatabaseUrl(databaseUrl));
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
    console.log(`Created the test database "${name}".`);
  } finally {
    await admin.$disconnect();
  }
}

async function pingRedis(url) {
  const { Redis } = require('ioredis');
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: responseTimeoutMs,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  // `connect` rejects with a bare "Connection is closed."; the cause arrives
  // as an error event, and without a listener it would go unhandled.
  let cause;
  client.on('error', (error) => {
    cause = error;
  });

  try {
    await client.connect();
    await client.ping();
  } catch (error) {
    throw cause ?? error;
  } finally {
    client.disconnect();
  }
}

/** MongoDB creates the test database on the first write, so a ping is enough. */
async function pingMongo(url) {
  const mongoose = require('mongoose');
  const connection = mongoose.createConnection(url, {
    serverSelectionTimeoutMS: responseTimeoutMs,
  });
  connection.on('error', () => {});

  try {
    await connection.asPromise();
    await connection.db.admin().ping();
  } finally {
    await connection.close().catch(() => {});
  }
}

console.log('Integration tests use:');
for (const storage of storages) console.log(`  ${storage.name.padEnd(10)} ${storage.address}`);

const results = await Promise.allSettled(storages.map((storage) => storage.prepare()));
const failures = storages.flatMap((storage, index) => {
  const result = results[index];
  return result.status === 'rejected'
    ? [`  ${storage.name} at ${storage.address}: ${reasonOf(result.reason)}`]
    : [];
});

if (failures.length > 0) {
  fail([
    'Integration tests need PostgreSQL, Redis and MongoDB running. Not responding:',
    ...failures,
    '',
    startStorageHint,
  ]);
}

const childEnv = { ...process.env, ...testEnv };
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
