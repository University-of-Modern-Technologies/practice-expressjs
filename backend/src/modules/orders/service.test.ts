import { describe, expect, it, jest } from '@jest/globals';

import { AppError } from '../../common/errors/index.js';
import type { DomainEventNotification, DomainEventPublisher } from '../../common/types/index.js';
import type { AuditService } from '../audit/service.js';
import {
  TRANSITION_TRANSACTION_OPTIONS,
  createOrdersService,
  orderSelection,
  type OrdersDatabase,
} from './service.js';
import type { OrderDefaults, OrdersStockPort } from './stock.js';
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

/** A draft with no lines yet, so adding product-1 to it is not a duplicate. */
const emptyDraft: typeof draftOrder = { ...draftOrder, items: [] };

interface HarnessOptions {
  readonly order?: typeof draftOrder;
  readonly products?: readonly (typeof product)[];
  readonly orderUpdate?: (args: unknown) => Promise<unknown>;
  readonly orderCreate?: (args: unknown) => Promise<unknown>;
  readonly itemCreate?: (args: unknown) => Promise<unknown>;
  /** What the active-user lookup for an assigned owner finds; null means nobody. */
  readonly owner?: { readonly id: string } | null;
  /** The organisation settings; left out, the service falls back to USD and `ORD`. */
  readonly defaults?: OrderDefaults;
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
    user: {
      findFirst: jest.fn(async (_args: unknown) =>
        options.owner === undefined ? { id: 'owner-1' } : options.owner,
      ),
    },
    auditLog: { create: jest.fn() },
  };
  const findMany = jest.fn(async (_args: unknown) => [current]);
  const count = jest.fn(async (_args: unknown) => 1);
  const db = {
    order: { findFirst, findMany, count },
    $transaction: jest.fn(
      async (callback: (value: typeof transaction) => Promise<unknown>, _options?: unknown) =>
        callback(transaction),
    ),
  } as unknown as OrdersDatabase;
  const record = jest.fn(async () => undefined);
  const audit = { record } as unknown as AuditService;
  const publish = jest.fn((_event: DomainEventNotification): void => undefined);
  const events: DomainEventPublisher = { publish };

  const resolveOrderDefaults = jest.fn(async (_transaction: unknown) => options.defaults);
  const stock =
    options.defaults === undefined
      ? undefined
      : ({
          operations: { reserve: jest.fn(), release: jest.fn(), issue: jest.fn() },
          resolveWarehouseId: jest.fn(async () => 'warehouse-1'),
          resolveOrderDefaults,
        } as unknown as OrdersStockPort);

  return {
    service: createOrdersService(db, audit, events, stock),
    resolveOrderDefaults,
    db,
    findFirst,
    findMany,
    updateOrder,
    createOrder,
    createItem,
    updateItem,
    deleteItems,
    findProducts,
    findOwner: transaction.user.findFirst,
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
    const harness = createHarness({
      order: emptyDraft,
      products: [{ ...product, isActive: false }],
    });

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
    const harness = createHarness({
      order: emptyDraft,
      products: [{ ...product, currency: 'EUR' }],
    });

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
    // An order kept from before the organisation settled on EUR still has USD lines.
    const harness = createHarness({ defaults: { currency: 'EUR', numberPrefix: 'ORD' } });

    await expect(
      harness.service.update(access, draftOrder.id, { version: 1, currency: 'EUR' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ORDER_CURRENCY_MISMATCH' });
  });

  it('reports a product added concurrently by another request as a conflict', async () => {
    const harness = createHarness({
      order: emptyDraft,
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

  it('copies the contact and owner, but assigns a fresh order number', async () => {
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
    const added = createHarness({ order: emptyDraft });
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

describe('orders service owner assignment', () => {
  const allAccess: OrderAccess = { actorId: 'actor-1', scope: 'ALL' };

  it('refuses to create an order for an owner who is unknown or deactivated', async () => {
    const harness = createHarness({ owner: null });

    await expect(
      harness.service.create(allAccess, { ownerId: 'ghost-user' }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'ORDER_OWNER_NOT_FOUND' });
    expect(harness.findOwner).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ghost-user', isActive: true } }),
    );
    expect(harness.createOrder).not.toHaveBeenCalled();
  });

  it('does not look the caller up when the caller is the owner', async () => {
    const harness = createHarness({ owner: null });

    await harness.service.create(allAccess, {});

    expect(harness.findOwner).not.toHaveBeenCalled();
    expect(harness.createOrder).toHaveBeenCalledTimes(1);
  });

  it('refuses to hand an existing order to an unknown owner', async () => {
    const harness = createHarness({ owner: null });

    await expect(
      harness.service.update(allAccess, draftOrder.id, { version: 1, ownerId: 'ghost-user' }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'ORDER_OWNER_NOT_FOUND' });
    expect(harness.updateOrder).not.toHaveBeenCalled();
  });

  it('reports an owner removed between the check and the write as not found, not as a duplicate', async () => {
    const harness = createHarness({
      orderCreate: async () => {
        throw { code: 'P2003', meta: { field_name: 'orders_owner_id_fkey (index)' } };
      },
    });

    await expect(harness.service.create(allAccess, { ownerId: 'owner-1' })).rejects.toMatchObject({
      statusCode: 404,
      code: 'ORDER_OWNER_NOT_FOUND',
    });
  });
});

describe('orders service empty drafts', () => {
  it('lets an empty draft be cancelled', async () => {
    const harness = createHarness({ order: { ...draftOrder, items: [] } });

    await harness.service.transition(access, draftOrder.id, { version: 1, status: 'CANCELLED' });

    expect(harness.updateOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'CANCELLED' }) as unknown,
      }),
    );
  });
});

describe('orders service discount bounds', () => {
  const discounted = { ...draftOrder, discountTotal: '50.00', total: '9.97' };

  it('refuses a discount larger than the subtotal even when the tax would hide it', async () => {
    const harness = createHarness();

    await expect(
      harness.service.update(access, draftOrder.id, {
        version: 1,
        discountTotal: '70.00',
        taxTotal: '20.00',
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'ORDER_TOTALS_INVALID' });
    expect(harness.updateOrder).not.toHaveBeenCalled();
  });

  it('lowers the discount to the new subtotal when a line is removed', async () => {
    const harness = createHarness({ order: discounted });

    await harness.service.removeItem(access, draftOrder.id, item.id, 1);

    expect(harness.updateOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subtotal: '0.00',
          discountTotal: '0.00',
          total: '0.00',
        }) as unknown,
      }),
    );
  });

  it('lowers the discount when a quantity is reduced below it', async () => {
    const harness = createHarness({ order: discounted });

    await harness.service.updateItem(access, draftOrder.id, item.id, { version: 1, quantity: 1 });

    expect(harness.updateOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subtotal: '19.99',
          discountTotal: '19.99',
          total: '0.00',
        }) as unknown,
      }),
    );
  });
});

describe('orders service amount range', () => {
  it('refuses a line whose total would not fit the money column, before writing', async () => {
    const harness = createHarness({
      products: [{ ...product, unitPrice: '999999999999.99' }],
    });

    await expect(
      harness.service.create(access, { items: [{ productId: product.id, quantity: 2 }] }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'ORDER_AMOUNT_OUT_OF_RANGE',
      details: { field: 'lineTotal', max: '999999999999.99' },
    });
    expect(harness.createOrder).not.toHaveBeenCalled();
  });
});

describe('orders service line order', () => {
  it('reads the lines oldest first, with the id breaking a timestamp tie', () => {
    expect(orderSelection.items.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
  });
});

describe('orders service add-item check order', () => {
  it('reports a product already on the order as a duplicate before consulting the catalogue', async () => {
    const harness = createHarness({ products: [{ ...product, isActive: false }] });

    await expect(
      harness.service.addItem(access, draftOrder.id, {
        version: 1,
        productId: product.id,
        quantity: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ORDER_ITEM_DUPLICATE' });
    expect(harness.findProducts).not.toHaveBeenCalled();
    expect(harness.createItem).not.toHaveBeenCalled();
  });
});

describe('orders service transition transaction', () => {
  it('runs a status change with explicit transaction limits', async () => {
    const harness = createHarness();

    await harness.service.transition(access, draftOrder.id, { version: 1, status: 'CONFIRMED' });

    expect(harness.db.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      TRANSITION_TRANSACTION_OPTIONS,
    );
    expect(TRANSITION_TRANSACTION_OPTIONS.timeout).toBeGreaterThan(5_000);
    expect(TRANSITION_TRANSACTION_OPTIONS.maxWait).toBeGreaterThan(2_000);
  });
});

describe('orders service search', () => {
  it('matches the search term literally, escaping LIKE wildcards', async () => {
    const harness = createHarness();

    await harness.service.list(access, {
      page: 1,
      pageSize: 20,
      search: '10%_off\\',
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });

    expect(harness.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ orderNumber: { contains: '10\\%\\_off\\\\', mode: 'insensitive' } }],
        }) as unknown,
      }),
    );
  });
});

describe('orders service deletion', () => {
  it.each(['CONFIRMED', 'PAID', 'FULFILLED'] as const)(
    'refuses to delete a %s order, which holds or has used a reservation',
    async (status) => {
      const harness = createHarness({ order: withStatus(status) });

      await expect(harness.service.delete(access, draftOrder.id, 1)).rejects.toMatchObject({
        statusCode: 409,
        code: 'ORDER_NOT_DELETABLE',
        details: { status },
      });
      expect(harness.updateOrder).not.toHaveBeenCalled();
      expect(harness.record).not.toHaveBeenCalled();
      expect(harness.publish).not.toHaveBeenCalled();
    },
  );

  it('deletes a cancelled order', async () => {
    const harness = createHarness({ order: withStatus('CANCELLED') });

    await harness.service.delete(access, draftOrder.id, 1);

    expect(harness.updateOrder).toHaveBeenCalledTimes(1);
  });

  it('reports a stale version before the status', async () => {
    const harness = createHarness({ order: withStatus('CONFIRMED') });

    await expect(harness.service.delete(access, draftOrder.id, 2)).rejects.toMatchObject({
      code: 'ORDER_CONCURRENT_MODIFICATION',
    });
  });
});

describe('orders service organisation settings', () => {
  const euro: OrderDefaults = { currency: 'EUR', numberPrefix: 'SO' };

  it('numbers a new order with the organisation prefix', async () => {
    const harness = createHarness({ defaults: euro, products: [{ ...product, currency: 'EUR' }] });

    await harness.service.create(access, {});

    expect(harness.resolveOrderDefaults).toHaveBeenCalledTimes(1);
    expect(harness.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderNumber: expect.stringMatching(/^SO-\d{8}-[0-9A-Z]{6}$/) as unknown as string,
        }) as unknown,
      }),
    );
  });

  it('creates an order in the organisation currency when none is given', async () => {
    const harness = createHarness({ defaults: euro, products: [{ ...product, currency: 'EUR' }] });

    await harness.service.create(access, { items: [{ productId: product.id, quantity: 1 }] });

    expect(harness.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ currency: 'EUR' }) as unknown }),
    );
  });

  it('refuses to create an order in another currency', async () => {
    const harness = createHarness({ defaults: euro });

    await expect(harness.service.create(access, { currency: 'USD' })).rejects.toMatchObject({
      statusCode: 422,
      code: 'CURRENCY_NOT_SUPPORTED',
      details: { currency: 'USD', expected: 'EUR' },
    });
    expect(harness.createOrder).not.toHaveBeenCalled();
  });

  it('refuses to move an order to another currency', async () => {
    const harness = createHarness({ order: emptyDraft });

    await expect(
      harness.service.update(access, draftOrder.id, { version: 1, currency: 'EUR' }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'CURRENCY_NOT_SUPPORTED',
      details: { currency: 'EUR', expected: 'USD' },
    });
    expect(harness.updateOrder).not.toHaveBeenCalled();
  });

  it('accepts the organisation currency on update', async () => {
    const harness = createHarness({ order: emptyDraft });

    await harness.service.update(access, draftOrder.id, { version: 1, currency: 'USD' });

    expect(harness.updateOrder).toHaveBeenCalledTimes(1);
  });

  it('duplicates an order into the organisation currency', async () => {
    const harness = createHarness({ defaults: euro, products: [{ ...product, currency: 'EUR' }] });

    await harness.service.duplicate(access, draftOrder.id);

    expect(harness.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ currency: 'EUR' }) as unknown }),
    );
  });

  it('falls back to USD and the ORD prefix when no settings are wired', async () => {
    const harness = createHarness();

    await harness.service.create(access, {});

    expect(harness.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currency: 'USD',
          orderNumber: expect.stringMatching(/^ORD-/) as unknown as string,
        }) as unknown,
      }),
    );
  });
});

describe('orders service warehouse field', () => {
  it('returns the warehouse the order reserved in', async () => {
    const harness = createHarness({
      order: { ...withStatus('CONFIRMED'), warehouseId: 'warehouse-1' } as typeof draftOrder,
    });

    await expect(harness.service.getById(access, draftOrder.id)).resolves.toMatchObject({
      warehouseId: 'warehouse-1',
    });
  });

  it('reads the warehouse with every order', () => {
    expect(orderSelection).toMatchObject({ warehouseId: true });
  });
});
