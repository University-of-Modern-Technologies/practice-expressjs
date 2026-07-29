import request from 'supertest';

import type { CompositionRoot } from '../../src/composition-root.js';
import { bearer, getCookiePair, login } from './helpers/auth.js';
import { seed } from './helpers/seed-data.js';
import { createIntegrationApp } from './helpers/test-app.js';

let root: CompositionRoot;

beforeAll(() => {
  root = createIntegrationApp();
});

afterAll(async () => {
  await root.close();
});

describe('canonical database-backed CRM flow', () => {
  it('completes the authenticated contact, deal, transition, audit, and logout journey', async () => {
    const manager = await login(root.app, seed.users.manager);
    const refreshCookie = getCookiePair(manager.refreshCookie);

    const contactResponse = await request(root.app)
      .post('/api/v1/contacts')
      .set('Authorization', bearer(manager.accessToken))
      .send({
        firstName: 'Canonical',
        lastName: 'Journey',
        email: 'CANONICAL.JOURNEY@EXAMPLE.TEST',
        company: 'Canonical Flow Co',
      });
    expect(contactResponse.status).toBe(201);
    expect(contactResponse.body.data).toMatchObject({
      ownerId: seed.users.manager.id,
      firstName: 'Canonical',
      lastName: 'Journey',
      email: 'canonical.journey@example.test',
      company: 'Canonical Flow Co',
    });

    const contactId = contactResponse.body.data.id as string;
    const dealResponse = await request(root.app)
      .post('/api/v1/deals')
      .set('Authorization', bearer(manager.accessToken))
      .send({
        contactId,
        title: 'Canonical journey deal',
        amount: '4200.00',
        currency: 'eur',
        expectedCloseDate: '2026-12-31',
      });
    expect(dealResponse.status).toBe(201);
    expect(dealResponse.body.data).toMatchObject({
      ownerId: seed.users.manager.id,
      contactId,
      title: 'Canonical journey deal',
      stage: 'LEAD',
      currency: 'EUR',
      probability: 10,
    });

    const dealId = dealResponse.body.data.id as string;
    const stages = ['QUALIFIED', 'PROPOSAL', 'WON'] as const;
    let version = dealResponse.body.data.version as number;

    for (const stage of stages) {
      const transitionResponse = await request(root.app)
        .post(`/api/v1/deals/${dealId}/transitions`)
        .set('Authorization', bearer(manager.accessToken))
        .send({ version, stage });
      expect(transitionResponse.status).toBe(200);
      expect(transitionResponse.body.data).toMatchObject({
        id: dealId,
        contactId,
        stage,
        probability: stage === 'WON' ? 100 : 10,
        version: version + 1,
      });
      version = transitionResponse.body.data.version as number;
    }

    const historyResponse = await request(root.app)
      .get(`/api/v1/audit/deal/${dealId}`)
      .query({ pageSize: 10 })
      .set('Authorization', bearer(manager.accessToken));
    expect(historyResponse.status).toBe(200);
    expect(historyResponse.body.data).toMatchObject({ page: 1, pageSize: 10, total: 4 });
    expect(historyResponse.body.data.items).toHaveLength(4);
    expect(historyResponse.body.data.items.map((item: { action: string }) => item.action)).toEqual([
      'deal.stage_transitioned',
      'deal.stage_transitioned',
      'deal.stage_transitioned',
      'deal.created',
    ]);
    expect(historyResponse.body.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: seed.users.manager.id,
          entityType: 'deal',
          entityId: dealId,
        }),
      ]),
    );

    const logoutResponse = await request(root.app)
      .post('/api/v1/auth/logout')
      .set('Cookie', refreshCookie);
    expect(logoutResponse.status).toBe(204);

    const revokedAccessResponse = await request(root.app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(manager.accessToken));
    expect(revokedAccessResponse.status).toBe(401);
    expect(revokedAccessResponse.body.error.code).toBe('UNAUTHORIZED');

    const revokedRefreshResponse = await request(root.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', refreshCookie);
    expect(revokedRefreshResponse.status).toBe(401);
    expect(revokedRefreshResponse.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });
});
