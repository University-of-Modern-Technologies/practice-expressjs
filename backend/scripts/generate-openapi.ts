import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { serializeOpenApiDocument } from '../src/common/openapi/index.js';
import { createOpenApiDocument } from '../src/openapi.js';

// Builds the description from the routers the application mounts: no server is
// started and no storage is reached, so the command runs on a bare checkout and
// in CI.
const target = resolve(__dirname, '..', 'openapi.json');

const main = async (): Promise<void> => {
  writeFileSync(target, serializeOpenApiDocument(await createOpenApiDocument()));
  console.log(`OpenAPI description written to ${target}`);
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
