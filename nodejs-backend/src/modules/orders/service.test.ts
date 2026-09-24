import { describe, expect, it, jest } from '@jest/globals';

import { AppError } from '../../common/errors/index.js';
import type { DomainEventNotification, DomainEventPublisher } from '../../common/types/index.js';
import type { AuditService } from '../audit/service.js';
import { createOrdersService, type OrdersDatabase } from './service.js';
import type { OrderAccess, OrderStatus } from './types.js';

const access: OrderAccess = { actorId: 'actor-1', scope: 'OWN' };
const timestamp = new Date('2026-01-01T00:00:00Z');

const product = {
  id: 'product-1',
  sku: 'SKU-1',
  name: 'Widget',
  unitPrice: '19.99',
  currency: 'USD',
  isActive: true,
};

const item = {
  id: 'item-1',
  orderId: 'order-1',
  productId: product.id,
  sku: product.sku,
  name: product.name,
  quantity: 3,
  unitPrice: '19.99',
  lineTotal: '59.97',
  createdAt: timestamp,
  updatedAt: timestamp,
};

const draftOrder = {
  id: 'order-1',
  orderNumber: 'ORD-20260101-ABC123',
  ownerId: access.actorId,
  contactId: null,
  dealId: null,
  status: 'DRAFT' as OrderStatus,
  currency: 'USD',
  subtotal: '59.97',
  discountTotal: '0.00',
  taxTotal: '0.00',
  total: '59.97',
  notes: null,
  version: 1,
  placedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: null,
  items: [item],
};

const withStatus = (status: OrderStatus): typeof draftOrder => ({ ...draftOrder, status });

interface HarnessOptions {
  readonly order?: typeof draftOrder;
  readonly products?: readonly (typeof product)[];
  readonly orderUpdate?: (args: unknown) => Promise<unknown>;
  readonly orderCreate?: (args: unknown) => Promise<unknown>;
  readonly itemCreate?: (args: unknown) => Promise<unknown>;
}

const createHarness = (options: HarnessOptions = {}) => {
  const current = options.order ?? draftOrder;
  const findFirst = jest.fn(async (_args: unknown) => current);
  const updateOrder = jest.fn(
    options.orderUpdate ??
      (async (_args: unknown) => ({ ...current, version: current.version + 1 })),
  );
  const createOrder = jest.fn(options.orderCreate ?? (async (_args: unknown) => current));
  const findProducts = jest.fn(async (_args: unknown) => options.products ?? [product]);
  const createItem = jest.fn(options.itemCreate ?? (async (_args: unknown) => item));
  const updateItem = jest.fn(async (_args: unknown) => item);
  const deleteItems = jest.fn(async (_args: unknown) => ({ count: 1 }));
  const transaction = {
    order: { findFirst, update: updateOrder, create: createOrder },
    orderItem: { create: createItem, update: updateItem, deleteMany: deleteItems },
    product: { findMany: findProducts },
    contact: { findFirst: jest.fn(async (_args: unknown) => ({ id: 'contact-1' })) },
    deal: { findFirst: jest.fn(async (_args: unknown) => ({ id: 'deal-1' })) },
    auditLog: { create: jest.fn() },
  };
  const findMany = jest.fn(async (_args: unknown) => [current]);
  const count = jest.fn(async (_args: unknown) => 1);
  const db = {
    order: { findFirst, findMany, count },
    $transaction: jest.fn(async (callback: (value: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
    ),
  } as unknown as OrdersDatabase;
  const record = jest.fn(async () => undefined);
  const audit = { record } as unknown as AuditService;
  const publish = jest.fn((_event: DomainEventNotification): void => undefined);
  const events: DomainEventPublisher = { publish };

  return {
    service: createOrdersService(db, audit, events),
    db,
    findFirst,
    findMany,
    updateOrder,
    createOrder,
    createItem,
    updateItem,
    deleteItems,
    record,
    publish,
  };
};

describe('orders service totals', () => {
  it('derives every monetary field from the catalogue, ignoring client totals', async () => {
    const harness = createHarness();

    await harness.service.create(access, {
      discountTotal: '10.00',
      taxTotal: '5.00',
      items: [{ productId: product.id, quantity: 3 }],
      // A client-supplied total is not even part of the input type.
    });

    expect(harness.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DRAFT',
          subtotal: '59.97',
          discountTotal: '10.00',
          taxTotal: '5.00',
          total: '54.97',
          orderNumber: expect.stringMatching(/^ORD-\d{8}-[0-9A-Z]{6}$/) as unknown as string,
        }) as unknown,
      }),
    );
  });

  it('stays exact for prices that break floating point accumulation', async () => {
    const harness = createHarness({
      products: [{ ...product, unitPrice: '0.07' }],
    });

    await harness.service.create(access, { items: [{ productId: product.id, quantity: 3 }] });

    // 0.07 * 3 is 0.21000000000000002 in binary floating point.
    expect(harness.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subtotal: '0.21',
          total: '0.21',
          items: { create: [expect.objectContaining({ lineTotal: '0.21' })] },
        }) as unknown,
      }),
    );
  });

  it('snapshots the sku, name and price of the product onto the line', async () => {
    const harness = createHarness();

    await harness.service.create(access, { items: [{ productId: product.id, quantity: 2 }] });

    expect(harness.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          items: {
            create: [
              {
                productId: product.id,
                sku: 'SKU-1',
                name: 'Widget',
                quantity: 2,
                unitPrice: '19.99',
                lineTotal: '39.98',
              },
            ],
          },
        }) as unknown,
      }),
    );
  });

  it('recomputes the order totals when an item is removed', async () => {
    const harness = createHarness();

    await harness.service.removeItem(access, draftOrder.id, item.id, 1);

    expect(harness.deleteItems).toHaveBeenCalledWith({
      where: { id: item.id, orderId: draftOrder.id },
    });
    expect(harness.updateOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subtotal: '0.00',
          total: '0.00',
          version: { increment: 1 },
        }) as unknown,
      }),
    );
  });

  it('recomputes the totals from the stored lines on a plain update', async () => {
    const harness = createHarness();

    await harness.service.update(access, draftOrder.id, { version: 1, notes: 'rush' });

    expect(harness.updateOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ notes: 'rush', subtotal: '59.97', total: '59.97' }),
      }),
    );
  });
});

describe('orders service catalogue guards', () => {
  it('rejects a line that references a soft-deleted or unknown product', async () => {
    const harness = createHarness({ products: [] });

    await expect(
      harness.service.create(access, { items: [{ productId: product.id, quantity: 1 }] }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'PRODUCT_NOT_FOUND' });
    expect(harness.createOrder).not.toHaveBeenCalled();
  });

  it('rejects a line that references an inactive product', async () => {
    const harness = createHarness({ products: [{ ...product, isActive: false }] });

    await expect(
      harness.service.addItem(access, draftOrder.id, {
        version: 1,
        productId: product.id,
        quantity: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'PRODUCT_INACTIVE' });
    expect(harness.createItem).not.toHaveBeenCalled();
  });

  it('refuses to mix currencies on one order', async () => {
    const harness = createHarness({ products: [{ ...product, currency: 'EUR' }] });

    await expect(
      harness.service.addItem(access, draftOrder.id, {
        version: 1,
        productId: product.id,
        quantity: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ORDER_CURRENCY_MISMATCH' });
    expect(harness.record).not.toHaveBeenCalled();
  });

  it('refuses to change the currency of an order that already has lines', async () => {
    const harness = createHarness();

    await expect(
      harness.service.update(access, draftOrder.id, { version: 1, currency: 'EUR' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ORDER_CURRENCY_MISMATCH' });
  });

  it('reports a product that is already on the order as a conflict', async () => {
    const harness = createHarness({
      itemCreate: async () => {
        throw { code: 'P2002', meta: { target: ['order_id', 'product_id'] } };
      },
    });

    await expect(
      harness.service.addItem(access, draftOrder.id, {
        version: 1,
        productId: product.id,
        quantity: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ORDER_ITEM_DUPLICATE' });
  });
});

describe('orders service duplicate', () => {
  it('re-prices every line from the current catalogue rather than the source order', async () => {
    const harness = createHarness({ products: [{ ...product, unitPrice: '25.00' }] });

    await harness.service.duplicate(access, draftOrder.id);

    expect(harness.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DRAFT',
          items: {
            create: [expect.objectContaining({ unitPrice: '25.00', lineTotal: '75.00' })],
          },
        }) as unknown,
      }),
    );
  });

  it('copies the contact, owner and currency, but assigns a fresh order number', async () => {
    const harness = createHarness();

    await harness.service.duplicate(access, draftOrder.id);

    expect(harness.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ownerId: draftOrder.ownerId,
          contactId: draftOrder.contactId,
          currency: draftOrder.currency,
          status: 'DRAFT',
          orderNumber: expect.stringMatching(/^ORD-\d{8}-[0-9A-Z]{6}$/) as unknown as string,
        }) as unknown,
      }),
    );
  });

  it('duplicates a source order regardless of its status', async () => {
    const harness = createHarness({ order: withStatus('CANCELLED') });

    await harness.service.duplicate(access, draftOrder.id);

    expect(harness.createOrder).toHaveBeenCalled();
  });

  it('rejects when a line product has gone inactive since the source order was placed', async () => {
    const harness = createHarness({ products: [{ ...product, isActive: false }] });

    await expect(harness.service.duplicate(access, draftOrder.id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PRODUCT_INACTIVE',
    });
    expect(harness.createOrder).not.toHaveBeenCalled();
  });

  it('reports the same 404 as a plain read when the source is missing', async () => {
    const harness = createHarness();
    harness.findFirst.mockResolvedValueOnce(null as unknown as typeof draftOrder);

    await expect(harness.service.duplicate(access, 'missing')).rejects.toMatchObject({
      statusCode: 404,
      code: 'ORDER_NOT_FOUND',
    });
  });

  it('looks the source up under the same OWN-scope restriction as every other read', async () => {
    const harness = createHarness();

    await harness.service.duplicate(access, draftOrder.id);

    expect(harness.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ownerId: access.actorId }) as unknown,
      }),
    );
  });

  it('records and announces the duplicate exactly like a plain creation', async () => {
    const harness = createHarness();

    await harness.service.duplicate(access, draftOrder.id);

    expect(harness.record).toHaveBeenCalledTimes(1);
    expect(harness.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'order.created' }),
    );
  });
});

describe('orders service order numbers', () => {
  it('retries a colliding order number in a fresh transaction', async () => {
    let attempts = 0;
    const harness = createHarness({
      orderCreate: async () => {
        attempts += 1;
        if (attempts === 1) throw { code: 'P2002', meta: { target: ['order_number'] } };
        return draftOrder;
      },
    });

    await expect(harness.service.create(access, {})).resolves.toMatchObject({
      id: draftOrder.id,
    });
    expect(harness.createOrder).toHaveBeenCalledTimes(2);
    expect(harness.db.$transaction).toHaveBeenCalledTimes(2);
  });

  it('gives up after a bounded number of collisions', async () => {
    const harness = createHarness({
      orderCreate: async () => {
        throw { code: 'P2002', meta: { target: ['order_number'] } };
      },
    });

    await expect(harness.service.create(access, {})).rejects.toMatchObject({ code: 'P2002' });
    expect(harness.createOrder).toHaveBeenCalledTimes(5);
    expect(harness.publish).not.toHaveBeenCalled();
  });
});

describe('orders service item immutability', () => {
  it('refuses to add a line to a confirmed order', async () => {
    const harness = createHarness({ order: withStatus('CONFIRMED') });

    await expect(
      harness.service.addItem(access, draftOrder.id, {
        version: 1,
        productId: product.id,
        quantity: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ORDER_NOT_EDITABLE' });
    expect(harness.createItem).not.toHaveBeenCalled();
    expect(harness.updateOrder).not.toHaveBeenCalled();
  });

  it('refuses to change or remove a line once the order has left the draft stage', async () => {
    const harness = createHarness({ order: withStatus('CONFIRMED') });

    await expect(
      harness.service.updateItem(access, draftOrder.id, item.id, { version: 1, quantity: 5 }),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_EDITABLE' });
    await expect(
      harness.service.removeItem(access, draftOrder.id, item.id, 1),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_EDITABLE' });
    expect(harness.updateItem).not.toHaveBeenCalled();
    expect(harness.deleteItems).not.toHaveBeenCalled();
  });

  it('refuses to reprice a non-draft order while leaving notes editable', async () => {
    const harness = createHarness({ order: withStatus('CONFIRMED') });

    await expect(
      harness.service.update(access, draftOrder.id, { version: 1, discountTotal: '5.00' }),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_EDITABLE' });

    await expect(
      harness.service.update(access, draftOrder.id, { version: 1, notes: 'called the customer' }),
    ).resolves.toMatchObject({ id: draftOrder.id });
  });

  it('keeps the snapshot price when only the quantity changes', async () => {
    const harness = createHarness();

    await harness.service.updateItem(access, draftOrder.id, item.id, { version: 1, quantity: 2 });

    expect(harness.updateItem).toHaveBeenCalledWith({
      where: { id: item.id },
      data: { quantity: 2, lineTotal: '39.98' },
    });
    expect(harness.updateOrder).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ subtotal: '39.98' }) }),
    );
  });

  it('reports an unknown line as not found', async () => {
    const harness = createHarness();

    await expect(
      harness.service.removeItem(access, draftOrder.id, 'item-404', 1),
    ).rejects.toMatchObject({ statusCode: 404, code: 'ORDER_ITEM_NOT_FOUND' });
  });
});

describe('orders service status transitions', () => {
  it('places the order when it is confirmed and guards the write by version and status', async () => {
    const harness = createHarness();

    await harness.service.transition(access, draftOrder.id, { version: 1, status: 'CONFIRMED' });

    expect(harness.updateOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: draftOrder.id,
          version: 1,
          status: 'DRAFT',
          deletedAt: null,
          ownerId: access.actorId,
        },
        data: expect.objectContaining({
          status: 'CONFIRMED',
          placedAt: expect.any(Date) as unknown as Date,
          version: { increment: 1 },
        }) as unknown,
      }),
    );
  });

  it('does not stamp placedAt on any other transition', async () => {
    const harness = createHarness({ order: withStatus('CONFIRMED') });

    await harness.service.transition(access, draftOrder.id, { version: 1, status: 'PAID' });

    const call = harness.updateOrder.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(call.data).not.toHaveProperty('placedAt');
  });

  it('refuses to move an empty draft out of the draft stage', async () => {
    const harness = createHarness({ order: { ...draftOrder, items: [] } });

    await expect(
      harness.service.transition(access, draftOrder.id, { version: 1, status: 'CONFIRMED' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ORDER_HAS_NO_ITEMS' });
    expect(harness.updateOrder).not.toHaveBeenCalled();
  });

  it('refuses a forbidden move such as cancelling a fulfilled order', async () => {
    const harness = createHarness({ order: withStatus('FULFILLED') });

    await expect(
      harness.service.transition(access, draftOrder.id, { version: 1, status: 'CANCELLED' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'INVALID_ORDER_STATUS_TRANSITION' });
    expect(harness.record).not.toHaveBeenCalled();
  });
});

describe('orders service optimistic concurrency', () => {
  it('rejects a stale version before writing anything', async () => {
    const harness = createHarness();

    await expect(
      harness.service.update(access, draftOrder.id, { version: 2, notes: 'stale' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'ORDER_CONCURRENT_MODIFICATION',
    } satisfies Partial<AppError>);
    expect(harness.updateOrder).not.toHaveBeenCalled();
    expect(harness.record).not.toHaveBeenCalled();
  });

  it('turns a lost race inside the transaction into a conflict', async () => {
    const harness = createHarness({
      orderUpdate: async () => {
        throw { code: 'P2025' };
      },
    });

    await expect(
      harness.service.transition(access, draftOrder.id, { version: 1, status: 'CONFIRMED' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ORDER_CONCURRENT_MODIFICATION' });
    expect(harness.record).not.toHaveBeenCalled();
  });

  it('guards the soft delete by the same version predicate', async () => {
    const harness = createHarness();

    await harness.service.delete(access, draftOrder.id, 1);

    expect(harness.updateOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: draftOrder.id, version: 1, deletedAt: null, ownerId: access.actorId },
        data: expect.objectContaining({
          deletedAt: expect.any(Date) as unknown as Date,
          version: { increment: 1 },
        }) as unknown,
      }),
    );
  });
});

describe('orders service ownership scope', () => {
  it('restricts an OWN actor to its own orders', async () => {
    const harness = createHarness();

    await harness.service.list(access, {
      page: 1,
      pageSize: 20,
      ownerId: 'someone-else',
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });
    await harness.service.getById(access, draftOrder.id);

    expect(harness.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ownerId: access.actorId, deletedAt: null }) as unknown,
      }),
    );
    expect(harness.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ownerId: access.actorId }) as unknown,
      }),
    );
  });

  it('lets an ALL actor read every order and filter by owner explicitly', async () => {
    const harness = createHarness();

    await harness.service.list(
      { actorId: 'admin-1', scope: 'ALL' },
      {
        page: 1,
        pageSize: 20,
        ownerId: 'someone-else',
        sortBy: 'createdAt',
        sortOrder: 'desc',
      },
    );

    expect(harness.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ownerId: 'someone-else' }) as unknown,
      }),
    );
  });

  it('refuses to create an order for another owner under the OWN scope', async () => {
    const harness = createHarness();

    await expect(harness.service.create(access, { ownerId: 'someone-else' })).rejects.toMatchObject(
      { statusCode: 403, code: 'FORBIDDEN' },
    );
    expect(harness.db.$transaction).not.toHaveBeenCalled();
  });
});

describe('orders service domain event fan-out', () => {
  it('announces a committed transition exactly once', async () => {
    const harness = createHarness();

    await harness.service.transition(access, draftOrder.id, { version: 1, status: 'CONFIRMED' });

    expect(harness.publish).toHaveBeenCalledTimes(1);
    expect(harness.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'order.status_transitioned',
        entityType: 'order',
        entityId: draftOrder.id,
        actorId: access.actorId,
      }),
    );
  });

  it('announces item changes with their own event types', async () => {
    const added = createHarness();
    await added.service.addItem(access, draftOrder.id, {
      version: 1,
      productId: product.id,
      quantity: 1,
    });
    expect(added.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'order.item_added' }),
    );

    const removed = createHarness();
    await removed.service.removeItem(access, draftOrder.id, item.id, 1);
    expect(removed.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'order.item_removed' }),
    );
  });

  it('stays silent when the transaction is rejected', async () => {
    const harness = createHarness({
      orderUpdate: async () => {
        throw { code: 'P2025' };
      },
    });

    await expect(
      harness.service.transition(access, draftOrder.id, { version: 1, status: 'CONFIRMED' }),
    ).rejects.toBeInstanceOf(AppError);
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('keeps the business result when a secondary consumer fails', async () => {
    const harness = createHarness();
    harness.publish.mockImplementation(() => {
      throw new Error('event stream unreachable');
    });

    // The publisher owns its own failures; a broken stream must never turn a
    // committed transition into a failed request.
    await expect(
      harness.service.transition(access, draftOrder.id, { version: 1, status: 'CONFIRMED' }),
    ).resolves.toMatchObject({ id: draftOrder.id });
  });
});
