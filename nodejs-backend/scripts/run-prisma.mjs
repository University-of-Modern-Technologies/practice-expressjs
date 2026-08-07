/* global process */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prismaCli = path.join(projectRoot, 'node_modules', 'prisma', 'build', 'index.js');
const environment = {
  ...process.env,
  DATABASE_URL:
    process.env.DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5432/practice_crm?schema=public',
};
const result = spawnSync(process.execPath, [prismaCli, ...process.argv.slice(2)], {
  cwd: projectRoot,
  env: environment,
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
