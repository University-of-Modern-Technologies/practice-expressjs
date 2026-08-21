import request from 'supertest';

import type { CompositionRoot } from '../../src/composition-root.js';
import { bearer, login } from './helpers/auth.js';
import { seed } from './helpers/seed-data.js';
import { createIntegrationApp } from './helpers/test-app.js';

let root: CompositionRoot;

beforeAll(() => {
  root = createIntegrationApp();
});

afterAll(async () => {
  await root.close();
});

describe('database-backed audit flow', () => {
  it('records canonical mutations and restricts audit history by RBAC', async () => {
    const manager = await login(root.app, seed.users.manager);
    const viewer = await login(root.app, seed.users.viewer);

    const createResponse = await request(root.app)
      .post('/api/v1/contacts')
      .set('Authorization', bearer(manager.accessToken))
      .send({
        firstName: 'Audit',
        lastName: 'Integration',
        email: 'AUDIT.INTEGRATION@EXAMPLE.TEST',
      });
    expect(createResponse.status).toBe(201);

    const contactId = createResponse.body.data.id as string;
    const auditList = await request(root.app)
      .get('/api/v1/audit')
      .query({ action: 'contact.created', entityType: 'contact', entityId: contactId })
      .set('Authorization', bearer(manager.accessToken));
    expect(auditList.status).toBe(200);
    expect(auditList.body.data.total).toBe(1);
    expect(auditList.body.data.items).toHaveLength(1);
    expect(auditList.body.data.items[0]).toMatchObject({
      actorId: seed.users.manager.id,
      action: 'contact.created',
      entityType: 'contact',
      entityId: contactId,
      changes: {
        after: {
          firstName: 'Audit',
          lastName: 'Integration',
          email: 'audit.integration@example.test',
        },
      },
      metadata: null,
    });
    expect(Date.parse(auditList.body.data.items[0].createdAt)).not.toBeNaN();

    const auditId = auditList.body.data.items[0].id as string;
    const auditRecord = await request(root.app)
      .get(`/api/v1/audit/${auditId}`)
      .set('Authorization', bearer(manager.accessToken));
    expect(auditRecord.status).toBe(200);
    expect(auditRecord.body.data).toMatchObject({ id: auditId, entityId: contactId });

    const forbiddenAudit = await request(root.app)
      .get('/api/v1/audit')
      .set('Authorization', bearer(viewer.accessToken));
    expect(forbiddenAudit.status).toBe(403);
    expect(forbiddenAudit.body.error.code).toBe('FORBIDDEN');
  });
});
