/* global process */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from 'dotenv';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prismaCli = path.join(projectRoot, 'node_modules', 'prisma', 'build', 'index.js');

// The CLI only reads .env for variables the process does not already have, so
// it is loaded here first: otherwise the placeholder below would win over it.
config({ path: path.join(projectRoot, '.env'), quiet: true });

const environment = {
  ...process.env,
  DATABASE_URL:
    process.env.DATABASE_URL ??
    'postgresql://postgres:postgres@127.0.0.1:5432/practice_crm?schema=public',
};
const result = spawnSync(process.execPath, [prismaCli, ...process.argv.slice(2)], {
  cwd: projectRoot,
  env: environment,
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
