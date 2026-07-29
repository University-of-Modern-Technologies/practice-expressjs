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

describe('database-backed contacts and RBAC flow', () => {
  it('enforces OWN scope and completes the manager contact lifecycle', async () => {
    const manager = await login(root.app, seed.users.manager);
    const viewer = await login(root.app, seed.users.viewer);

    const viewerList = await request(root.app)
      .get('/api/v1/contacts?pageSize=100')
      .set('Authorization', bearer(viewer.accessToken));
    expect(viewerList.status).toBe(200);
    expect(viewerList.body.data.total).toBe(1);
    expect(viewerList.body.data.items.map((item: { id: string }) => item.id)).toEqual([
      seed.contacts.viewer,
    ]);

    const hiddenContact = await request(root.app)
      .get(`/api/v1/contacts/${seed.contacts.manager}`)
      .set('Authorization', bearer(viewer.accessToken));
    expect(hiddenContact.status).toBe(404);
    expect(hiddenContact.body.error.code).toBe('CONTACT_NOT_FOUND');

    const forbiddenCreate = await request(root.app)
      .post('/api/v1/contacts')
      .set('Authorization', bearer(viewer.accessToken))
      .send({ firstName: 'Read', lastName: 'Only', email: 'readonly@example.test' });
    expect(forbiddenCreate.status).toBe(403);
    expect(forbiddenCreate.body.error.code).toBe('FORBIDDEN');

    const createResponse = await request(root.app)
      .post('/api/v1/contacts')
      .set('Authorization', bearer(manager.accessToken))
      .send({
        firstName: 'Jamie',
        lastName: 'Integration',
        email: 'JAMIE.INTEGRATION@EXAMPLE.TEST',
        company: 'Integration Test Co',
      });
    expect(createResponse.status).toBe(201);
    expect(createResponse.body.data).toMatchObject({
      ownerId: seed.users.manager.id,
      firstName: 'Jamie',
      lastName: 'Integration',
      email: 'jamie.integration@example.test',
      company: 'Integration Test Co',
      phone: null,
      notes: null,
    });
    expect(Date.parse(createResponse.body.data.createdAt)).not.toBeNaN();

    const contactId = createResponse.body.data.id as string;
    const updateResponse = await request(root.app)
      .patch(`/api/v1/contacts/${contactId}`)
      .set('Authorization', bearer(manager.accessToken))
      .send({ phone: '+1-555-0199', notes: 'Updated by integration test' });
    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.data).toMatchObject({
      id: contactId,
      phone: '+1-555-0199',
      notes: 'Updated by integration test',
    });

    const deleteResponse = await request(root.app)
      .delete(`/api/v1/contacts/${contactId}`)
      .set('Authorization', bearer(manager.accessToken));
    expect(deleteResponse.status).toBe(204);

    const deletedResponse = await request(root.app)
      .get(`/api/v1/contacts/${contactId}`)
      .set('Authorization', bearer(manager.accessToken));
    expect(deletedResponse.status).toBe(404);
    expect(deletedResponse.body.error.code).toBe('CONTACT_NOT_FOUND');
  });
});
