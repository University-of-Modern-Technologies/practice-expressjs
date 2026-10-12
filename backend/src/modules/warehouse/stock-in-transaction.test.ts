import { describe, expect, it, jest } from '@jest/globals';

import type { DomainEventNotification, DomainEventPublisher } from '../../common/types/index.js';
import type { AuditService } from '../audit/service.js';
import type { OrderStockOperations } from '../orders/stock.js';
import { createStockOperationsInTransaction, type WarehouseTransaction } from './service.js';
import type { WarehouseAccess } from './types.js';

const access: WarehouseAccess = { actorId: 'actor-1', scope: 'ALL' };
const warehouseId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const orderId = '33333333-3333-4333-8333-333333333333';

const activeWarehouse = {
  id: warehouseId,
  code: 'MAIN',
  name: 'Main warehouse',
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const stockLevel = {
  id: 'stock-1',
  warehouseId,
  productId,
  quantityOnHand: 10,
  quantityReserved: 4,
  version: 3,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const movementRow = {
  id: 'movement-1',
  warehouseId,
  productId,
  type: 'RESERVATION' as const,
  quantity: 2,
  referenceType: 'order',
  referenceId: orderId,
  actorId: access.actorId,
  note: null,
  createdAt: new Date('2026-01-02T00:00:00Z'),
};

interface LedgerRow {
  readonly warehouseId: string;
  readonly type: string;
  readonly quantity: number;
}

const createHarness = (movements: readonly LedgerRow[] = []) => {
  const updateLevel = jest.fn(async (_args: unknown) => ({
    ...stockLevel,
    quantityReserved: 6,
    version: stockLevel.version + 1,
  }));
  const createMovement = jest.fn(async (_args: unknown) => movementRow);
  const transaction = {
    warehouse: { findUnique: jest.fn(async (_args: unknown) => activeWarehouse) },
    stockLevel: {
      findUnique: jest.fn(async (_args: unknown) => stockLevel),
      update: updateLevel,
      create: jest.fn(),
    },
    stockMovement: { create: createMovement, findMany: jest.fn(async () => movements) },
    auditLog: { create: jest.fn() },
  } as unknown as WarehouseTransaction;

  const record = jest.fn(async () => undefined);
  const audit = { record } as unknown as AuditService;
  const publish = jest.fn((_event: DomainEventNotification): void => undefined);
  const events: DomainEventPublisher = { publish };

  return {
    operations: createStockOperationsInTransaction(audit, events),
    transaction,
    updateLevel,
    createMovement,
    record,
    publish,
  };
};

const reserveInput = {
  warehouseId,
  productId,
  quantity: 2,
  referenceType: 'order',
  referenceId: orderId,
};

describe('stock operations on a caller-supplied transaction', () => {
  it('writes through the transaction it is handed', async () => {
    const harness = createHarness();

    const change = await harness.operations.reserve(harness.transaction, access, reserveInput);

    expect(change.level.quantityReserved).toBe(6);
    expect(harness.updateLevel).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: stockLevel.id, version: stockLevel.version },
        data: { quantityOnHand: 10, quantityReserved: 6, version: { increment: 1 } },
      }),
    );
    expect(harness.record).toHaveBeenCalledTimes(1);
  });

  it('carries the caller reference onto the movement row', async () => {
    const harness = createHarness();

    await harness.operations.reserve(harness.transaction, access, reserveInput);

    expect(harness.createMovement).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'RESERVATION',
          quantity: 2,
          referenceType: 'order',
          referenceId: orderId,
        }) as unknown,
      }),
    );
  });

  it('leaves the event unpublished until the caller says the transaction committed', async () => {
    const harness = createHarness();

    const change = await harness.operations.reserve(harness.transaction, access, reserveInput);
    expect(harness.publish).not.toHaveBeenCalled();

    change.publishCommitted();

    expect(harness.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'stock.reserved', entityType: 'stock' }),
    );
  });

  it('applies the same oversell guard as the standalone operation', async () => {
    const harness = createHarness();

    await expect(
      harness.operations.reserve(harness.transaction, access, { ...reserveInput, quantity: 7 }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'INSUFFICIENT_STOCK' });
    expect(harness.updateLevel).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('treats a repeated reservation of an order line as a no-op', async () => {
    const harness = createHarness([{ warehouseId, type: 'RESERVATION', quantity: 2 }]);

    const change = await harness.operations.reserve(harness.transaction, access, reserveInput);
    change.publishCommitted();

    expect(change.movement).toBeNull();
    expect(change.level.quantityReserved).toBe(stockLevel.quantityReserved);
    expect(harness.updateLevel).not.toHaveBeenCalled();
    expect(harness.createMovement).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('reserves an order line again once the earlier reservation was given back', async () => {
    const harness = createHarness([
      { warehouseId, type: 'RESERVATION', quantity: 2 },
      { warehouseId, type: 'RELEASE', quantity: 2 },
    ]);

    const change = await harness.operations.reserve(harness.transaction, access, reserveInput);

    expect(change.movement).not.toBeNull();
    expect(harness.updateLevel).toHaveBeenCalledTimes(1);
  });

  it('lets the order reserve under its own reference on the order transaction', async () => {
    const harness = createHarness();

    await harness.operations.reserve(harness.transaction, access, reserveInput);

    expect(harness.createMovement).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'RESERVATION', referenceType: 'order' }) as unknown,
      }),
    );
  });

  it('lets the order release its own reservation on the order transaction', async () => {
    const harness = createHarness();

    await harness.operations.release(harness.transaction, access, reserveInput);

    expect(harness.createMovement).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'RELEASE', referenceType: 'order' }) as unknown,
      }),
    );
  });

  it('releases reserved units back without touching the quantity on hand', async () => {
    const harness = createHarness();

    await harness.operations.release(harness.transaction, access, reserveInput);

    expect(harness.updateLevel).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ quantityOnHand: 10, quantityReserved: 2 }) as unknown,
      }),
    );
  });

  it('consumes the reservation when issuing against it', async () => {
    const harness = createHarness();

    await harness.operations.issue(harness.transaction, access, {
      ...reserveInput,
      quantity: 4,
      fromReservation: true,
    });

    // Released first, then issued: the ledger records both halves.
    expect(harness.updateLevel).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({ quantityOnHand: 10, quantityReserved: 0 }) as unknown,
      }),
    );
    expect(harness.createMovement.mock.calls.map(([args]) => args)).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ type: 'RELEASE', quantity: 4 }) }),
      expect.objectContaining({ data: expect.objectContaining({ type: 'ISSUE', quantity: 4 }) }),
    ]);
  });

  it('publishes the release and the issue only when the caller says it committed', async () => {
    const harness = createHarness();

    const change = await harness.operations.issue(harness.transaction, access, {
      ...reserveInput,
      quantity: 4,
      fromReservation: true,
    });
    expect(harness.publish).not.toHaveBeenCalled();
    change.publishCommitted();

    expect(harness.publish.mock.calls.map(([event]) => event.eventType)).toEqual([
      'stock.released',
      'stock.issued',
    ]);
  });

  it('satisfies the stock port that the orders module declares', () => {
    const harness = createHarness();

    // A compile-time guarantee that the composition root can hand this port to
    // the orders service directly, with no adapter in between.
    const port: OrderStockOperations = harness.operations;

    expect(typeof port.reserve).toBe('function');
    expect(typeof port.release).toBe('function');
    expect(typeof port.issue).toBe('function');
  });
});
