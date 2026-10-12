import { describeApplication, type OpenApiDocument } from './app/index.js';
import { createCompositionRoot } from './composition-root.js';
import { loadConfig } from './config/index.js';

export type { OpenApiDocument };

/**
 * The settings the description is built with. They are read from here and
 * nowhere else, so a developer's `.env` cannot leak into the committed file and
 * every machine writes the same bytes. The addresses are placeholders that are
 * never dialled: `test` is the mode in which the composition root wires its
 * clients without opening a single connection.
 */
const DESCRIPTION_ENVIRONMENT = {
  APP_ENV: 'test',
  LOG_LEVEL: 'silent',
  API_DOCS_ENABLED: 'true',
  DATABASE_URL: 'postgresql://openapi:openapi@127.0.0.1:5432/openapi',
  JWT_ACCESS_SECRET: 'openapi-description-placeholder-secret',
  JWT_REFRESH_SECRET: 'openapi-description-placeholder-secret',
  REDIS_URL: 'redis://127.0.0.1:6379',
  MONGODB_URL: 'mongodb://127.0.0.1:27017/openapi',
} as const;

/**
 * Builds the description the application serves, from the routers the
 * composition root mounts, without a server and without storage.
 */
export const createOpenApiDocument = async (): Promise<OpenApiDocument> => {
  const compositionRoot = createCompositionRoot(loadConfig(DESCRIPTION_ENVIRONMENT));
  try {
    return describeApplication(compositionRoot.routers);
  } finally {
    await compositionRoot.close();
  }
};
