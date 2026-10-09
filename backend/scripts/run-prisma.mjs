/* global process */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv } from '../src/config/load-env.cjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prismaCli = path.join(projectRoot, 'node_modules', 'prisma', 'build', 'index.js');

// Loaded the same way the application loads it, so the CLI reaches the same
// database. It has to happen first: otherwise the placeholder below would win.
loadEnv();

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
