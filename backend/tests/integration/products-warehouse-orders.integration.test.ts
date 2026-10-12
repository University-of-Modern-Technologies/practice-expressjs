import request from 'supertest';

import type { CompositionRoot } from '../../src/composition-root.js';
import { bearer, login } from './helpers/auth.js';
import { seed } from './helpers/seed-data.js';
import { createIntegrationApp } from './helpers/test-app.js';

/**
 * The one integration suite that crosses products, warehouse and orders —
 * the three modules the product-archiving task bank entry touches. Nothing
 * here tests archiving itself (it does not exist yet); it is a style sample
 * for the change that adds it, showing how a real product, a real stock
 * level and a real order are wired together against the live database.
 */

let root: CompositionRoot;

beforeAll(() => {
  root = createIntegrationApp();
});

afterAll(async () => {
  await root.close();
});

describe('products, warehouse and orders against the live database', () => {
  it('receives stock, reserves it through an order, and blocks an inactive product', async () => {
    const manager = await login(root.app, seed.users.manager);
    const auth = bearer(manager.accessToken);

    const productResponse = await request(root.app)
      .post('/api/v1/products')
      .set('Authorization', auth)
      .send({
        sku: `INT-TEST-${Date.now()}`,
        name: 'Integration probe product',
        category: 'Licences',
        unitPrice: '42.00',
      });
    expect(productResponse.status).toBe(201);
    const productId = productResponse.body.data.id as string;

    const receiveResponse = await request(root.app)
      .post('/api/v1/warehouse/stock/receive')
      .set('Authorization', auth)
      .send({
        warehouseId: seed.warehouses.central,
        productId,
        quantity: 10,
        referenceType: 'integration-test',
        referenceId: seed.warehouses.central,
      });
    expect(receiveResponse.status).toBe(200);
    expect(receiveResponse.body.data).toMatchObject({ quantityOnHand: 10, quantityReserved: 0 });

    const orderResponse = await request(root.app)
      .post('/api/v1/orders')
      .set('Authorization', auth)
      .send({
        contactId: seed.contacts.manager,
        currency: 'USD',
        items: [{ productId, quantity: 3, unitPrice: '42.00' }],
      });
    expect(orderResponse.status).toBe(201);
    const orderId = orderResponse.body.data.id as string;

    // Confirming the draft is the transition that reserves stock — the same
    // move exercised in canonical-flow.integration.test.ts for deals.
    const confirmResponse = await request(root.app)
      .post(`/api/v1/orders/${orderId}/transitions`)
      .set('Authorization', auth)
      .send({ status: 'CONFIRMED', version: 1 });
    expect(confirmResponse.status).toBe(200);

    const stockAfterConfirm = await request(root.app)
      .get(`/api/v1/warehouse/stock/${seed.warehouses.central}/${productId}`)
      .set('Authorization', auth);
    expect(stockAfterConfirm.body.data).toMatchObject({
      quantityOnHand: 10,
      quantityReserved: 3,
    });

    // Deactivating the product is the existing guard the task bank names as
    // the style sample: a new order for it must fail, an old one does not.
    await request(root.app)
      .patch(`/api/v1/products/${productId}`)
      .set('Authorization', auth)
      .send({ version: 1, isActive: false });

    const blockedOrder = await request(root.app)
      .post('/api/v1/orders')
      .set('Authorization', auth)
      .send({
        contactId: seed.contacts.manager,
        currency: 'USD',
        items: [{ productId, quantity: 1, unitPrice: '42.00' }],
      });
    expect(blockedOrder.status).toBe(409);
    expect(blockedOrder.body.error.code).toBe('PRODUCT_INACTIVE');

    // Warehouse movements do not look at the product at all — the exact gap
    // the task bank entry asks the change to close.
    const receiveOnInactive = await request(root.app)
      .post('/api/v1/warehouse/stock/receive')
      .set('Authorization', auth)
      .send({
        warehouseId: seed.warehouses.central,
        productId,
        quantity: 5,
        referenceType: 'integration-test',
        referenceId: seed.warehouses.central,
      });
    expect(receiveOnInactive.status).toBe(200);
  });

  it('keeps an order reservation owned by the order', async () => {
    const manager = await login(root.app, seed.users.manager);
    const auth = bearer(manager.accessToken);

    const productResponse = await request(root.app)
      .post('/api/v1/products')
      .set('Authorization', auth)
      .send({
        sku: `INT-RES-${Date.now()}`,
        name: 'Reservation probe product',
        category: 'Licences',
        unitPrice: '10.00',
      });
    expect(productResponse.status).toBe(201);
    const productId = productResponse.body.data.id as string;

    await request(root.app)
      .post('/api/v1/warehouse/stock/receive')
      .set('Authorization', auth)
      .send({ warehouseId: seed.warehouses.central, productId, quantity: 10 });

    const orderResponse = await request(root.app)
      .post('/api/v1/orders')
      .set('Authorization', auth)
      .send({ contactId: seed.contacts.manager, items: [{ productId, quantity: 3 }] });
    expect(orderResponse.status).toBe(201);
    expect(orderResponse.body.data.warehouseId).toBeNull();
    const orderId = orderResponse.body.data.id as string;

    const confirmResponse = await request(root.app)
      .post(`/api/v1/orders/${orderId}/transitions`)
      .set('Authorization', auth)
      .send({ status: 'CONFIRMED', version: 1 });
    expect(confirmResponse.status).toBe(200);
    // The warehouse the order reserved in is part of the order from now on.
    expect(confirmResponse.body.data.warehouseId).toBe(seed.warehouses.central);

    const reservation = {
      warehouseId: seed.warehouses.central,
      productId,
      quantity: 3,
      referenceType: 'order',
      referenceId: orderId,
    };

    // Only the order's own transitions move stock under its reference.
    const manualReserve = await request(root.app)
      .post('/api/v1/warehouse/stock/reserve')
      .set('Authorization', auth)
      .send(reservation);
    expect(manualReserve.status).toBe(409);
    expect(manualReserve.body.error.code).toBe('STOCK_ORDER_REFERENCE_FORBIDDEN');

    const manualRelease = await request(root.app)
      .post('/api/v1/warehouse/stock/release')
      .set('Authorization', auth)
      .send(reservation);
    expect(manualRelease.status).toBe(409);
    expect(manualRelease.body.error.code).toBe('STOCK_ORDER_REFERENCE_FORBIDDEN');

    // An order that holds a reservation may not disappear.
    const deleteOrder = await request(root.app)
      .delete(`/api/v1/orders/${orderId}`)
      .query({ version: 2 })
      .set('Authorization', auth);
    expect(deleteOrder.status).toBe(409);
    expect(deleteOrder.body.error.code).toBe('ORDER_NOT_DELETABLE');

    const cancelResponse = await request(root.app)
      .post(`/api/v1/orders/${orderId}/transitions`)
      .set('Authorization', auth)
      .send({ status: 'CANCELLED', version: 2 });
    expect(cancelResponse.status).toBe(200);

    const stockAfterCancel = await request(root.app)
      .get(`/api/v1/warehouse/stock/${seed.warehouses.central}/${productId}`)
      .set('Authorization', auth);
    expect(stockAfterCancel.body.data).toMatchObject({ quantityOnHand: 10, quantityReserved: 0 });
  });
});
