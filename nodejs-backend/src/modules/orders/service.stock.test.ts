import { describe, expect, it, jest } from '@jest/globals';

import { AppError } from '../../common/errors/index.js';
import type { DomainEventNotification, DomainEventPublisher } from '../../common/types/index.js';
import type { AuditService } from '../audit/service.js';
import { createOrdersService, type OrdersDatabase } from './service.js';
import type { OrderStockChange, OrderStockInput, OrdersStockPort } from './stock.js';
import type { OrderAccess, OrderStatus } from './types.js';

const access: OrderAccess = { actorId: 'actor-1', scope: 'OWN' };
const timestamp = new Date('2026-01-01T00:00:00Z');
const warehouseId = 'warehouse-1';

const lineOf = (id: string, productId: string, quantity: number) => ({
  id,
  orderId: 'order-1',
  productId,
  sku: `SKU-${productId}`,
  name: `Product ${productId}`,
  quantity,
  unitPrice: '10.00',
  lineTotal: `${(quantity * 10).toFixed(2)}`,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const items = [lineOf('item-1', 'product-1', 3), lineOf('item-2', 'product-2', 2)];

const orderWith = (status: OrderStatus) => ({
  id: 'order-1',
  orderNumber: 'ORD-20260101-ABC123',
  ownerId: access.actorId,
  contactId: null,
  dealId: null,
  status,
  currency: 'USD',
  subtotal: '50.00',
  discountTotal: '0.00',
  taxTotal: '0.00',
  total: '50.00',
  notes: null,
  version: 1,
  placedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: null,
  items,
});

interface HarnessOptions {
  readonly status?: OrderStatus;
  /** `null` stands for a deployment where no default warehouse is configured. */
  readonly warehouseId?: string | null;
  readonly onReserve?: () => Promise<OrderStockChange>;
  /** Leaves the stock port out entirely, as a composition without a warehouse would. */
  readonly withoutStock?: boolean;
}

const createHarness = (options: HarnessOptions = {}) => {
  const current = orderWith(options.status ?? 'DRAFT');
  /** Records what happened in which order, so "after commit" can be asserted. */
  const timeline: string[] = [];

  const findFirst = jest.fn(async (_args: unknown) => current);
  const updateOrder = jest.fn(async (_args: unknown) => ({
    ...current,
    version: current.version + 1,
  }));
  const transaction = {
    order: { findFirst, update: updateOrder, create: jest.fn() },
    orderItem: { create: jest.fn(), update: jest.fn(), deleteMany: jest.fn() },
    product: { findMany: jest.fn(async (_args: unknown) => []) },
    contact: { findFirst: jest.fn() },
    deal: { findFirst: jest.fn() },
    auditLog: { create: jest.fn() },
  };

  let committed = false;
  const db = {
    order: { findFirst, findMany: jest.fn(), count: jest.fn() },
    $transaction: jest.fn(async (callback: (value: typeof transaction) => Promise<unknown>) => {
      try {
        const result = await callback(transaction);
        committed = true;
        timeline.push('commit');
        return result;
      } catch (error) {
        timeline.push('rollback');
        throw error;
      }
    }),
  } as unknown as OrdersDatabase;

  const change = (label: string): OrderStockChange => ({
    publishCommitted: () => timeline.push(`stock-event:${label}`),
  });

  const reserve = jest.fn(
    options.onReserve ??
      (async (_transaction: unknown, _access: unknown, _input: OrderStockInput) =>
        change('reserved')),
  );
  const release = jest.fn(
    async (_transaction: unknown, _access: unknown, _input: OrderStockInput) => change('released'),
  );
  const issue = jest.fn(async (_transaction: unknown, _access: unknown, _input: OrderStockInput) =>
    change('issued'),
  );
  const resolveWarehouseId = jest.fn(async (_transaction: unknown) =>
    options.warehouseId === undefined ? warehouseId : options.warehouseId,
  );
  const stock = {
    operations: { reserve, release, issue },
    resolveWarehouseId,
  } as unknown as OrdersStockPort;

  const record = jest.fn(async () => undefined);
  const audit = { record } as unknown as AuditService;
  const publish = jest.fn((_event: DomainEventNotification): void => {
    timeline.push('order-event');
  });
  const events: DomainEventPublisher = { publish };

  return {
    service: createOrdersService(
      db,
      audit,
      events,
      options.withoutStock === true ? undefined : stock,
    ),
    transaction,
    updateOrder,
    reserve,
    release,
    issue,
    resolveWarehouseId,
    publish,
    timeline,
    hasCommitted: () => committed,
  };
};

describe('order transitions that move stock', () => {
  it('reserves every line of the order when a draft is confirmed', async () => {
    const harness = createHarness();

    await harness.service.transition(access, 'order-1', { version: 1, status: 'CONFIRMED' });

    expect(harness.reserve).toHaveBeenCalledTimes(2);
    expect(harness.reserve).toHaveBeenNthCalledWith(
      1,
      harness.transaction,
      access,
      expect.objectContaining({ warehouseId, productId: 'product-1', quantity: 3 }),
    );
    expect(harness.reserve).toHaveBeenNthCalledWith(
      2,
      harness.transaction,
      access,
      expect.objectContaining({ warehouseId, productId: 'product-2', quantity: 2 }),
    );
  });

  it('reserves on the very transaction that carries the status change', async () => {
    const harness = createHarness();

    await harness.service.transition(access, 'order-1', { version: 1, status: 'CONFIRMED' });

    const [firstCall] = harness.reserve.mock.calls;
    expect(firstCall?.[0]).toBe(harness.transaction);
    expect(harness.updateOrder).toHaveBeenCalledTimes(1);
  });

  it('points every movement back at the order that caused it', async () => {
    const harness = createHarness();

    await harness.service.transition(access, 'order-1', { version: 1, status: 'CONFIRMED' });

    for (const call of harness.reserve.mock.calls) {
      expect(call[2]).toMatchObject({ referenceType: 'order', referenceId: 'order-1' });
    }
  });

  it('releases the reservation when a confirmed order is cancelled', async () => {
    const harness = createHarness({ status: 'CONFIRMED' });

    await harness.service.transition(access, 'order-1', { version: 1, status: 'CANCELLED' });

    expect(harness.release).toHaveBeenCalledTimes(2);
    expect(harness.reserve).not.toHaveBeenCalled();
    expect(harness.issue).not.toHaveBeenCalled();
  });

  it('releases the reservation when a paid order is cancelled', async () => {
    const harness = createHarness({ status: 'PAID' });

    await harness.service.transition(access, 'order-1', { version: 1, status: 'CANCELLED' });

    expect(harness.release).toHaveBeenCalledTimes(2);
    expect(harness.release).toHaveBeenCalledWith(
      harness.transaction,
      access,
      expect.objectContaining({ productId: 'product-1', quantity: 3 }),
    );
  });

  it('issues the goods against the reservation when a paid order is fulfilled', async () => {
    const harness = createHarness({ status: 'PAID' });

    await harness.service.transition(access, 'order-1', { version: 1, status: 'FULFILLED' });

    expect(harness.issue).toHaveBeenCalledTimes(2);
    expect(harness.issue).toHaveBeenCalledWith(
      harness.transaction,
      access,
      expect.objectContaining({ fromReservation: true, referenceId: 'order-1' }),
    );
  });

  it('leaves stock alone for a transition that only moves money', async () => {
    const harness = createHarness({ status: 'CONFIRMED' });

    await harness.service.transition(access, 'order-1', { version: 1, status: 'PAID' });

    expect(harness.resolveWarehouseId).not.toHaveBeenCalled();
    expect(harness.reserve).not.toHaveBeenCalled();
    expect(harness.release).not.toHaveBeenCalled();
    expect(harness.issue).not.toHaveBeenCalled();
  });

  it('leaves stock alone when a draft that never reserved anything is cancelled', async () => {
    const harness = createHarness();

    await harness.service.transition(access, 'order-1', { version: 1, status: 'CANCELLED' });

    expect(harness.resolveWarehouseId).not.toHaveBeenCalled();
    expect(harness.release).not.toHaveBeenCalled();
  });

  it('publishes the stock events only once the transaction has committed', async () => {
    const harness = createHarness();

    await harness.service.transition(access, 'order-1', { version: 1, status: 'CONFIRMED' });

    expect(harness.timeline).toEqual([
      'commit',
      'stock-event:reserved',
      'stock-event:reserved',
      'order-event',
    ]);
  });
});

describe('order transitions that cannot move stock', () => {
  it('keeps the order in draft when the reservation cannot be met', async () => {
    const harness = createHarness({
      onReserve: async () => {
        throw new AppError(
          'Not enough stock available for this operation',
          409,
          'INSUFFICIENT_STOCK',
        );
      },
    });

    await expect(
      harness.service.transition(access, 'order-1', { version: 1, status: 'CONFIRMED' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'INSUFFICIENT_STOCK' });

    // The status change and the reservation share one transaction, so the
    // rejected reservation takes the confirmation down with it.
    expect(harness.hasCommitted()).toBe(false);
    expect(harness.timeline).toEqual(['rollback']);
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('names the line that blocked the confirmation', async () => {
    const harness = createHarness({
      onReserve: async () => {
        throw new AppError(
          'Not enough stock available for this operation',
          409,
          'INSUFFICIENT_STOCK',
        );
      },
    });

    await expect(
      harness.service.transition(access, 'order-1', { version: 1, status: 'CONFIRMED' }),
    ).rejects.toMatchObject({
      details: { orderId: 'order-1', productId: 'product-1', quantity: 3 },
    });
  });

  it('refuses the transition when no warehouse is configured', async () => {
    const harness = createHarness({ warehouseId: null });

    await expect(
      harness.service.transition(access, 'order-1', { version: 1, status: 'CONFIRMED' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'WAREHOUSE_NOT_CONFIGURED' });
    expect(harness.reserve).not.toHaveBeenCalled();
    expect(harness.hasCommitted()).toBe(false);
  });
});

describe('orders service without a stock port', () => {
  it('confirms an order and touches no stock at all', async () => {
    const harness = createHarness({ withoutStock: true });

    const result = await harness.service.transition(access, 'order-1', {
      version: 1,
      status: 'CONFIRMED',
    });

    expect(result.id).toBe('order-1');
    expect(harness.resolveWarehouseId).not.toHaveBeenCalled();
    expect(harness.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'order.status_transitioned' }),
    );
  });
});
