import { afterAll, describe, expect, it } from '@jest/globals';
import request from 'supertest';

import { createCompositionRoot } from './composition-root.js';
import { createTestConfig } from './test/config.js';

const config = createTestConfig();

const compositionRoot = createCompositionRoot(config);

afterAll(async () => {
  await compositionRoot.close();
});

describe('composition root', () => {
  it('mounts the auth module under the versioned API prefix', async () => {
    const response = await request(compositionRoot.app).post('/api/v1/auth/login').send({});

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it.each([
    '/users',
    '/rbac/check/contacts/read',
    '/contacts',
    '/deals',
    '/audit',
    '/products',
    '/orders',
    '/warehouse/warehouses',
    '/warehouse/stock',
    '/warehouse/movements',
    '/settings',
    '/analytics/sales-summary',
    '/analytics/deal-funnel',
    '/analytics/top-products',
    '/analytics/owner-performance',
    '/analytics/stock-health',
    '/integrations/health',
  ])('mounts and protects /api/v1%s', async (path) => {
    const response = await request(compositionRoot.app).get(`/api/v1${path}`);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });
});
