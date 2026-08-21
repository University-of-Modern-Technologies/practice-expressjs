import { describe, expect, it, jest } from '@jest/globals';

import type { DomainEventNotification, DomainEventPublisher } from '../../common/types/index.js';
import type { AuditService } from '../audit/service.js';
import { createWarehouseService, type WarehouseDatabase } from './service.js';
import type { AdjustStockInput, WarehouseAccess } from './types.js';

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

/** Ten units on the shelf, four of them already promised elsewhere. */
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

interface HarnessOptions {
  readonly warehouse?: typeof activeWarehouse | null;
  readonly level?: typeof stockLevel | null;
  readonly onUpdate?: (args: unknown) => Promise<unknown>;
  readonly onCreateLevel?: (args: unknown) => Promise<unknown>;
  readonly onCreateMovement?: (args: unknown) => Promise<unknown>;
  readonly onCreateWarehouse?: (args: unknown) => Promise<unknown>;
  readonly onAudit?: () => Promise<unknown>;
}

const createHarness = (options: HarnessOptions = {}) => {
  const nextLevel = { ...stockLevel, version: stockLevel.version + 1 };
  const findWarehouse = jest.fn(async (_args: unknown) =>
    options.warehouse === undefined ? activeWarehouse : options.warehouse,
  );
  const findLevel = jest.fn(async (_args: unknown) =>
    options.level === undefined ? stockLevel : options.level,
  );
  const updateLevel = jest.fn(options.onUpdate ?? (async (_args: unknown) => nextLevel));
  const createLevel = jest.fn(options.onCreateLevel ?? (async (_args: unknown) => nextLevel));
  const createMovement = jest.fn(
    options.onCreateMovement ?? (async (_args: unknown) => movementRow),
  );
  const createWarehouse = jest.fn(
    options.onCreateWarehouse ?? (async (_args: unknown) => activeWarehouse),
  );
  const updateWarehouse = jest.fn(async (_args: unknown) => activeWarehouse);

  const transaction = {
    warehouse: { findUnique: findWarehouse, create: createWarehouse, update: updateWarehouse },
    stockLevel: { findUnique: findLevel, update: updateLevel, create: createLevel },
    stockMovement: { create: createMovement },
    auditLog: { create: jest.fn() },
  };

  const db = {
    warehouse: { findUnique: findWarehouse, findMany: jest.fn(), count: jest.fn() },
    stockLevel: { findUnique: findLevel, findMany: jest.fn(), count: jest.fn() },
    stockMovement: { findMany: jest.fn(), count: jest.fn() },
    $transaction: jest.fn(async (callback: (value: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
    ),
  } as unknown as WarehouseDatabase;

  const record = jest.fn(options.onAudit ?? (async () => undefined));
  const audit = { record } as unknown as AuditService;
  const publish = jest.fn((_event: DomainEventNotification): void => undefined);
  const events: DomainEventPublisher = { publish };

  return {
    service: createWarehouseService(db, audit, events),
    db,
    findWarehouse,
    findLevel,
    updateLevel,
    createLevel,
    createMovement,
    createWarehouse,
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

describe('warehouse stock arithmetic', () => {
  it('derives the available quantity instead of storing it', async () => {
    const harness = createHarness();

    const level = await harness.service.getStock(access, warehouseId, productId);

    expect(level).toMatchObject({
      quantityOnHand: 10,
      quantityReserved: 4,
      quantityAvailable: 6,
    });
  });

  it('reports zero available stock once everything on hand is reserved', async () => {
    const harness = createHarness({ level: { ...stockLevel, quantityReserved: 10 } });

    const level = await harness.service.getStock(access, warehouseId, productId);

    expect(level.quantityAvailable).toBe(0);
  });

  it('reserves against available stock and pins the write to the version it read', async () => {
    const harness = createHarness();

    const level = await harness.service.reserve(access, reserveInput);

    expect(level.version).toBe(stockLevel.version + 1);
    expect(harness.updateLevel).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: stockLevel.id, version: stockLevel.version },
        data: {
          quantityOnHand: 10,
          quantityReserved: 6,
          version: { increment: 1 },
        },
      }),
    );
    expect(harness.createMovement).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'RESERVATION', quantity: 2 }),
      }),
    );
    expect(harness.record).toHaveBeenCalledTimes(1);
    expect(harness.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'stock.reserved', entityType: 'stock' }),
    );
  });

  it('creates the first stock level for a pair when receiving into it', async () => {
    const harness = createHarness({ level: null });

    await harness.service.receive(access, { warehouseId, productId, quantity: 7 });

    expect(harness.createLevel).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ quantityOnHand: 7, quantityReserved: 0 }),
      }),
    );
    expect(harness.updateLevel).not.toHaveBeenCalled();
  });

  it('releases the reservation in the same statement as a reservation-backed issue', async () => {
    const harness = createHarness();

    await harness.service.issue(access, {
      warehouseId,
      productId,
      quantity: 4,
      fromReservation: true,
      referenceType: 'order',
      referenceId: orderId,
    });

    expect(harness.updateLevel).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ quantityOnHand: 6, quantityReserved: 0 }),
      }),
    );
  });
});

describe('warehouse oversell guards', () => {
  const expectNoWrite = (harness: ReturnType<typeof createHarness>): void => {
    expect(harness.updateLevel).not.toHaveBeenCalled();
    expect(harness.createLevel).not.toHaveBeenCalled();
    expect(harness.createMovement).not.toHaveBeenCalled();
    expect(harness.record).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
  };

  it('refuses to reserve more than the available quantity', async () => {
    const harness = createHarness();

    await expect(
      harness.service.reserve(access, { ...reserveInput, quantity: 7 }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'INSUFFICIENT_STOCK' });
    expectNoWrite(harness);
  });

  it('refuses to issue units that are reserved for someone else', async () => {
    const harness = createHarness();

    await expect(
      harness.service.issue(access, { warehouseId, productId, quantity: 7 }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'INSUFFICIENT_STOCK' });
    expectNoWrite(harness);
  });

  it('refuses to issue more than the quantity on hand', async () => {
    const harness = createHarness();

    await expect(
      harness.service.issue(access, { warehouseId, productId, quantity: 11 }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'INSUFFICIENT_STOCK' });
    expectNoWrite(harness);
  });

  it('refuses to release more than is reserved', async () => {
    const harness = createHarness();

    await expect(
      harness.service.release(access, { ...reserveInput, quantity: 5 }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'INSUFFICIENT_RESERVATION' });
    expectNoWrite(harness);
  });

  it('refuses a reservation-backed issue larger than the reservation', async () => {
    const harness = createHarness();

    await expect(
      harness.service.issue(access, {
        warehouseId,
        productId,
        quantity: 5,
        fromReservation: true,
        referenceType: 'order',
        referenceId: orderId,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'INSUFFICIENT_RESERVATION' });
    expectNoWrite(harness);
  });

  it('refuses to reserve against a pair that has never been stocked', async () => {
    const harness = createHarness({ level: null });

    await expect(harness.service.reserve(access, reserveInput)).rejects.toMatchObject({
      statusCode: 409,
      code: 'INSUFFICIENT_STOCK',
    });
    expectNoWrite(harness);
  });

  it('refuses a downward adjustment that would strand reserved units', async () => {
    const harness = createHarness();

    await expect(
      harness.service.adjust(access, { warehouseId, productId, delta: -8, note: 'stocktake' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'INSUFFICIENT_STOCK' });
    expectNoWrite(harness);
  });

  it('refuses any movement into a deactivated warehouse', async () => {
    const harness = createHarness({ warehouse: { ...activeWarehouse, isActive: false } });

    await expect(
      harness.service.receive(access, { warehouseId, productId, quantity: 1 }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'WAREHOUSE_INACTIVE' });
    expectNoWrite(harness);
  });
});

describe('warehouse adjustments', () => {
  it('requires a note even when request validation is bypassed', async () => {
    const harness = createHarness();

    await expect(
      harness.service.adjust(access, {
        warehouseId,
        productId,
        delta: 3,
      } as unknown as AdjustStockInput),
    ).rejects.toThrow();
    expect(harness.updateLevel).not.toHaveBeenCalled();
  });

  it('rejects a blank note', async () => {
    const harness = createHarness();

    await expect(
      harness.service.adjust(access, { warehouseId, productId, delta: 3, note: '   ' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'STOCK_ADJUSTMENT_NOTE_REQUIRED' });
    expect(harness.db.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a zero delta because it would record nothing', async () => {
    const harness = createHarness();

    await expect(
      harness.service.adjust(access, { warehouseId, productId, delta: 0, note: 'noop' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_STOCK_ADJUSTMENT' });
    expect(harness.db.$transaction).not.toHaveBeenCalled();
  });

  it('records a negative correction as a positive movement quantity', async () => {
    const harness = createHarness();

    await harness.service.adjust(access, {
      warehouseId,
      productId,
      delta: -2,
      note: 'damaged in transit',
    });

    expect(harness.createMovement).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'ADJUSTMENT',
          quantity: 2,
          note: 'damaged in transit',
        }),
      }),
    );
    expect(harness.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'stock.adjusted' }),
    );
  });
});

describe('warehouse concurrency handling', () => {
  it('turns a lost update into a retryable conflict and publishes nothing', async () => {
    const harness = createHarness({
      onUpdate: async () => {
        throw { code: 'P2025' };
      },
    });

    await expect(harness.service.reserve(access, reserveInput)).rejects.toMatchObject({
      statusCode: 409,
      code: 'STOCK_CONCURRENT_MODIFICATION',
    });
    expect(harness.record).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('turns a race on the first insert for a pair into the same conflict', async () => {
    const harness = createHarness({
      level: null,
      onCreateLevel: async () => {
        throw { code: 'P2002' };
      },
    });

    await expect(
      harness.service.receive(access, { warehouseId, productId, quantity: 5 }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'STOCK_CONCURRENT_MODIFICATION' });
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('reports a database CHECK violation as a conflict rather than a server fault', async () => {
    const harness = createHarness({
      onUpdate: async () => {
        throw {
          code: 'P2010',
          message:
            'db error: ERROR: new row violates check constraint "stock_levels_reserved_within_on_hand_check" (23514)',
        };
      },
    });

    await expect(harness.service.reserve(access, reserveInput)).rejects.toMatchObject({
      statusCode: 409,
      code: 'INSUFFICIENT_STOCK',
    });
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('maps a negative reserved quantity from the database to a reservation conflict', async () => {
    const harness = createHarness({
      onUpdate: async () => {
        throw {
          code: 'P2010',
          message:
            'violates check constraint "stock_levels_quantities_non_negative_check": quantity_reserved >= 0',
        };
      },
    });

    await expect(harness.service.release(access, reserveInput)).rejects.toMatchObject({
      statusCode: 409,
      code: 'INSUFFICIENT_RESERVATION',
    });
  });

  it('reports a missing product from the foreign key as a 404', async () => {
    const harness = createHarness({
      onCreateMovement: async () => {
        throw { code: 'P2003' };
      },
    });

    await expect(harness.service.reserve(access, reserveInput)).rejects.toMatchObject({
      statusCode: 404,
      code: 'PRODUCT_NOT_FOUND',
    });
  });

  it('publishes nothing when the transaction fails after the stock row was written', async () => {
    const harness = createHarness({
      onAudit: async () => {
        throw new Error('audit write failed');
      },
    });

    await expect(harness.service.reserve(access, reserveInput)).rejects.toThrow(
      'audit write failed',
    );
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('leaves an unexpected database failure untranslated', async () => {
    const harness = createHarness({
      onUpdate: async () => {
        throw new Error('connection reset');
      },
    });

    await expect(harness.service.reserve(access, reserveInput)).rejects.toThrow('connection reset');
  });
});

describe('warehouse administration', () => {
  it('reports a duplicate code as a conflict', async () => {
    const harness = createHarness({
      onCreateWarehouse: async () => {
        throw { code: 'P2002' };
      },
    });

    await expect(
      harness.service.createWarehouse(access, { code: 'MAIN', name: 'Main' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'WAREHOUSE_CODE_TAKEN' });
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('refuses to change the code of an existing warehouse', async () => {
    const harness = createHarness();

    await expect(
      harness.service.updateWarehouse(access, warehouseId, { code: 'SPARE' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'WAREHOUSE_CODE_IMMUTABLE' });
  });

  it('accepts a deactivation and audits it', async () => {
    const harness = createHarness();

    await harness.service.updateWarehouse(access, warehouseId, { isActive: false });

    expect(harness.record).toHaveBeenCalledTimes(1);
    expect(harness.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'warehouse.updated' }),
    );
  });

  it('reports a missing warehouse as a 404', async () => {
    const harness = createHarness({ warehouse: null });

    await expect(harness.service.getWarehouse(access, warehouseId)).rejects.toMatchObject({
      statusCode: 404,
      code: 'WAREHOUSE_NOT_FOUND',
    });
  });
});
