import console from 'node:console';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Names the tier this run did not touch.
 *
 * `testMatch` only collects the unit suites under `src/`, so the integration
 * tests are not skipped here — they are invisible. A green summary then reads
 * as "everything passed" when a whole tier never ran, which is the one reading
 * a test report must never allow.
 */
const INTEGRATION_DIR = path.resolve(__dirname, '../../tests/integration');

export default function reportIntegrationTier(): void {
  let pending = 0;

  try {
    pending = fs.readdirSync(INTEGRATION_DIR).filter((name) => name.endsWith('.test.ts')).length;
  } catch {
    // The directory is optional: a checkout without it simply has no tier to report.
    return;
  }

  if (pending === 0) return;

  console.log(
    `\nNot in this run: ${pending} integration suites (live PostgreSQL, Redis and MongoDB).` +
      `\nRun them with: npm run test:integration  (needs RUN_DB_TESTS=true)`,
  );
}
