import { createCompositionRoot, type CompositionRoot } from '../../../src/composition-root.js';
import { loadConfig } from '../../../src/config/index.js';
import { assertSafeTestDatabaseUrl } from '../../../src/test/db/index.js';

export function createIntegrationApp(): CompositionRoot {
  assertSafeTestDatabaseUrl();
  return createCompositionRoot(loadConfig());
}
