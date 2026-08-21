import { describe, expect, it } from '@jest/globals';

import {
  adjustStockSchema,
  createWarehouseSchema,
  issueStockSchema,
  listMovementsSchema,
  reserveStockSchema,
} from './validation.js';

const warehouseId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const orderId = '33333333-3333-4333-8333-333333333333';

describe('warehouse validation', () => {
  it('normalises a warehouse code to upper case', () => {
    const parsed = createWarehouseSchema.parse({ body: { code: ' main-01 ', name: 'Main' } });

    expect(parsed.body.code).toBe('MAIN-01');
  });

  it('rejects a non-positive movement quantity', () => {
    const result = reserveStockSchema.safeParse({
      body: { warehouseId, productId, quantity: 0, referenceType: 'order', referenceId: orderId },
    });

    expect(result.success).toBe(false);
  });

  it('requires a reference for a reservation', () => {
    const result = reserveStockSchema.safeParse({
      body: { warehouseId, productId, quantity: 3 },
    });

    expect(result.success).toBe(false);
  });

  it('requires a reference when an issue consumes a reservation', () => {
    const result = issueStockSchema.safeParse({
      body: { warehouseId, productId, quantity: 3, fromReservation: true },
    });

    expect(result.success).toBe(false);
  });

  it('accepts a plain issue without a reference', () => {
    const result = issueStockSchema.safeParse({ body: { warehouseId, productId, quantity: 3 } });

    expect(result.success).toBe(true);
  });

  it('rejects an adjustment of zero and one without a note', () => {
    expect(
      adjustStockSchema.safeParse({ body: { warehouseId, productId, delta: 0, note: 'x' } })
        .success,
    ).toBe(false);
    expect(
      adjustStockSchema.safeParse({ body: { warehouseId, productId, delta: -2 } }).success,
    ).toBe(false);
    expect(
      adjustStockSchema.safeParse({ body: { warehouseId, productId, delta: -2, note: 'lost' } })
        .success,
    ).toBe(true);
  });

  it('rejects a movement date range that ends before it starts', () => {
    const result = listMovementsSchema.safeParse({
      query: { createdFrom: '2026-02-01T00:00:00Z', createdTo: '2026-01-01T00:00:00Z' },
    });

    expect(result.success).toBe(false);
  });

  it('applies pagination defaults to the movement history', () => {
    const parsed = listMovementsSchema.parse({ query: {} });

    expect(parsed.query).toMatchObject({ page: 1, pageSize: 20 });
  });
});
