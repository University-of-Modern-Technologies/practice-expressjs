// The pre-commit hook: format and lint only what is staged, with each package's
// own tools and config. Tests stay in `npm run check` and CI — a hook has to be
// fast enough that nobody is tempted to skip it.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

// lint-staged hands over absolute paths; the helper wants them from the root.
const quoted = (files) =>
  files.map((file) => `"${path.relative(root, file).split(path.sep).join('/')}"`).join(' ');

const run = (pkg, tool, args) => (files) =>
  `node scripts/hooks/run-in.mjs ${pkg} ${tool} ${args} -- ${quoted(files)}`;

const code = (pkg) => [
  run(pkg, 'eslint', '--fix --no-warn-ignored'),
  run(pkg, 'prettier', '--write --ignore-unknown'),
];
const text = (pkg) => run(pkg, 'prettier', '--write --ignore-unknown');

export default {
  'backend/**/*.{ts,cts,mts,js,cjs,mjs}': code('backend'),
  'backend/**/*.{json,md,yml,yaml}': text('backend'),
  'frontend/**/*.{ts,tsx,js,jsx,cjs,mjs}': code('frontend'),
  'frontend/**/*.{json,md,css,yml,yaml}': text('frontend'),
};
