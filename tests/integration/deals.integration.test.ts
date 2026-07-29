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

describe('database-backed deals, transitions, and RBAC flow', () => {
  it('enforces OWN scope and completes the manager deal lifecycle', async () => {
    const manager = await login(root.app, seed.users.manager);
    const viewer = await login(root.app, seed.users.viewer);

    const viewerList = await request(root.app)
      .get('/api/v1/deals?pageSize=100')
      .set('Authorization', bearer(viewer.accessToken));
    expect(viewerList.status).toBe(200);
    expect(viewerList.body.data.total).toBe(1);
    expect(viewerList.body.data.items.map((item: { id: string }) => item.id)).toEqual([
      seed.deals.viewer,
    ]);

    const hiddenDeal = await request(root.app)
      .get(`/api/v1/deals/${seed.deals.managerProposal}`)
      .set('Authorization', bearer(viewer.accessToken));
    expect(hiddenDeal.status).toBe(404);
    expect(hiddenDeal.body.error.code).toBe('DEAL_NOT_FOUND');

    const forbiddenCreate = await request(root.app)
      .post('/api/v1/deals')
      .set('Authorization', bearer(viewer.accessToken))
      .send({ title: 'Forbidden deal', amount: '100.00' });
    expect(forbiddenCreate.status).toBe(403);
    expect(forbiddenCreate.body.error.code).toBe('FORBIDDEN');

    const createResponse = await request(root.app)
      .post('/api/v1/deals')
      .set('Authorization', bearer(manager.accessToken))
      .send({
        contactId: seed.contacts.manager,
        title: 'Integration test deal',
        amount: '1500.00',
        currency: 'usd',
        expectedCloseDate: '2026-12-31',
      });
    expect(createResponse.status).toBe(201);
    expect(createResponse.body.data).toMatchObject({
      ownerId: seed.users.manager.id,
      contactId: seed.contacts.manager,
      title: 'Integration test deal',
      stage: 'LEAD',
      currency: 'USD',
      probability: 10,
    });
    expect(Number(createResponse.body.data.amount)).toBe(1500);
    expect(createResponse.body.data.expectedCloseDate).toBe('2026-12-31T00:00:00.000Z');

    const dealId = createResponse.body.data.id as string;
    const createdVersion = createResponse.body.data.version as number;
    const updateResponse = await request(root.app)
      .patch(`/api/v1/deals/${dealId}`)
      .set('Authorization', bearer(manager.accessToken))
      .send({ version: createdVersion, title: 'Updated integration deal', contactId: null });
    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.data).toMatchObject({
      id: dealId,
      title: 'Updated integration deal',
      contactId: null,
      version: createdVersion + 1,
    });

    const updatedVersion = updateResponse.body.data.version as number;
    const transitionResponse = await request(root.app)
      .post(`/api/v1/deals/${dealId}/transitions`)
      .set('Authorization', bearer(manager.accessToken))
      .send({ version: updatedVersion, stage: 'QUALIFIED' });
    expect(transitionResponse.status).toBe(200);
    expect(transitionResponse.body.data).toMatchObject({
      id: dealId,
      stage: 'QUALIFIED',
      probability: 10,
      version: updatedVersion + 1,
    });

    const transitionedVersion = transitionResponse.body.data.version as number;
    const invalidTransition = await request(root.app)
      .post(`/api/v1/deals/${seed.deals.managerProposal}/transitions`)
      .set('Authorization', bearer(manager.accessToken))
      .send({ version: 1, stage: 'QUALIFIED' });
    expect(invalidTransition.status).toBe(409);
    expect(invalidTransition.body.error.code).toBe('INVALID_DEAL_STAGE_TRANSITION');
    expect(invalidTransition.body.error.details).toMatchObject({
      from: 'PROPOSAL',
      to: 'QUALIFIED',
    });
    expect(invalidTransition.body.error.details.allowed).toEqual(['WON', 'LOST']);

    const deleteResponse = await request(root.app)
      .delete(`/api/v1/deals/${dealId}`)
      .query({ version: transitionedVersion })
      .set('Authorization', bearer(manager.accessToken));
    expect(deleteResponse.status).toBe(204);

    const deletedResponse = await request(root.app)
      .get(`/api/v1/deals/${dealId}`)
      .set('Authorization', bearer(manager.accessToken));
    expect(deletedResponse.status).toBe(404);
    expect(deletedResponse.body.error.code).toBe('DEAL_NOT_FOUND');
  });
});
