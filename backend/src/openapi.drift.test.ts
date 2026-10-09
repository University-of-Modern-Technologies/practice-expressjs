import { afterAll, describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import request from 'supertest';

import { serializeOpenApiDocument } from './common/openapi/index.js';
import { createCompositionRoot } from './composition-root.js';
import { createOpenApiDocument } from './openapi.js';
import { createTestConfig } from './test/config.js';

const COMMITTED_FILE = resolve(__dirname, '..', 'openapi.json');

describe('committed openapi.json', () => {
  it('matches the description the code builds', async () => {
    // A checkout on Windows may carry CRLF line endings; the content is what counts.
    const committed = readFileSync(COMMITTED_FILE, 'utf8').replace(/\r\n/g, '\n');

    // On failure: run `npm run openapi:generate` and commit openapi.json with the change.
    expect(committed).toBe(serializeOpenApiDocument(await createOpenApiDocument()));
  });
});

describe('served /api/openapi.json', () => {
  const compositionRoot = createCompositionRoot(createTestConfig({ apiDocsEnabled: true }));

  afterAll(async () => {
    await compositionRoot.close();
  });

  it('is the description that is committed', async () => {
    const response = await request(compositionRoot.app).get('/api/openapi.json');

    expect(response.status).toBe(200);
    expect(serializeOpenApiDocument(response.body as object)).toBe(
      serializeOpenApiDocument(await createOpenApiDocument()),
    );
  });
});
