import { AppError } from '../../common/errors/index.js';
import { filter } from '../../common/query/filter-builder.js';
import { createListReader, type ListReaderModel } from '../../common/query/list-reader.js';
import {
  noopDomainEventPublisher,
  type DomainEventNotification,
  type DomainEventPublisher,
} from '../../common/types/domain-event-publisher.js';
import type { Prisma, PrismaDatabase, PrismaTransaction } from '../../db/prisma.js';
import type { AuditService } from '../audit/service.js';
import { ZERO_MONEY, normalizeMoney } from '../../common/money/index.js';
import { calculateLineTotal, calculateOrderTotals, type OrderTotals } from './money.js';
import {
  ORDER_STOCK_REFERENCE_TYPE,
  stockEffectForTransition,
  type OrderStockEffect,
  type OrdersStockPort,
} from './stock.js';
import {
  assertOrderEditable,
  assertOrderHasItems,
  assertOrderStatusTransition,
} from './transition.js';
import type {
  AddOrderItemData,
  CreateOrderData,
  CreateOrderItemData,
  OrderAccess,
  OrderDto,
  OrderItemDto,
  OrderListQuery,
  OrderListResult,
  OrderStatus,
  TransitionOrderData,
  UpdateOrderData,
  UpdateOrderItemData,
} from './types.js';

type DecimalLike = { toString(): string } | string | number;

interface OrderItemRecord extends Omit<OrderItemDto, 'unitPrice' | 'lineTotal'> {
  readonly unitPrice: DecimalLike;
  readonly lineTotal: DecimalLike;
}

interface OrderRecord extends Omit<
  OrderDto,
  'subtotal' | 'discountTotal' | 'taxTotal' | 'total' | 'items'
> {
  readonly subtotal: DecimalLike;
  readonly discountTotal: DecimalLike;
  readonly taxTotal: DecimalLike;
  readonly total: DecimalLike;
  readonly items: readonly OrderItemRecord[];
  readonly deletedAt: Date | null;
}

type OrdersTransaction = Pick<
  PrismaTransaction,
  'auditLog' | 'contact' | 'deal' | 'order' | 'orderItem' | 'product'
>;
export type OrdersDatabase = Pick<PrismaDatabase, '$transaction' | 'order'>;

export interface OrdersService {
  list(access: OrderAccess, query: OrderListQuery): Promise<OrderListResult>;
  getById(access: OrderAccess, id: string): Promise<OrderDto>;
  create(access: OrderAccess, data: CreateOrderData): Promise<OrderDto>;
  duplicate(access: OrderAccess, id: string): Promise<OrderDto>;
  update(access: OrderAccess, id: string, data: UpdateOrderData): Promise<OrderDto>;
  addItem(access: OrderAccess, id: string, data: AddOrderItemData): Promise<OrderDto>;
  updateItem(
    access: OrderAccess,
    id: string,
    itemId: string,
    data: UpdateOrderItemData,
  ): Promise<OrderDto>;
  removeItem(access: OrderAccess, id: string, itemId: string, version: number): Promise<OrderDto>;
  transition(access: OrderAccess, id: string, data: TransitionOrderData): Promise<OrderDto>;
  delete(access: OrderAccess, id: string, version: number): Promise<void>;
}

const DEFAULT_CURRENCY = 'USD';
/** Bounded so a pathological collision streak fails fast instead of looping. */
const ORDER_NUMBER_ATTEMPTS = 5;

const orderItemSelection = {
  id: true,
  orderId: true,
  productId: true,
  sku: true,
  name: true,
  quantity: true,
  unitPrice: true,
  lineTotal: true,
  createdAt: true,
  updatedAt: true,
};

export const orderSelection = {
  id: true,
  orderNumber: true,
  ownerId: true,
  contactId: true,
  dealId: true,
  status: true,
  currency: true,
  subtotal: true,
  discountTotal: true,
  taxTotal: true,
  total: true,
  notes: true,
  version: true,
  placedAt: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  items: { select: orderItemSelection, orderBy: { createdAt: 'asc' as const } },
};

const toItemDto = (item: OrderItemRecord): OrderItemDto => ({
  ...item,
  unitPrice: item.unitPrice.toString(),
  lineTotal: item.lineTotal.toString(),
});

const toDto = ({
  subtotal,
  discountTotal,
  taxTotal,
  total,
  items,
  deletedAt: _deletedAt,
  ...order
}: OrderRecord): OrderDto => ({
  ...order,
  subtotal: subtotal.toString(),
  discountTotal: discountTotal.toString(),
  taxTotal: taxTotal.toString(),
  total: total.toString(),
  items: items.map(toItemDto),
});

const isRecordNotFoundError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2025';

const isUniqueConstraintError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';

const conflictingFields = (error: unknown): readonly string[] => {
  const target = (error as { meta?: { target?: unknown } } | null)?.meta?.target;
  if (Array.isArray(target)) return target.map(String);
  return typeof target === 'string' ? [target] : [];
};

/**
 * A collision on the generated order number is expected under concurrency and
 * is retried; any other uniqueness violation belongs to the caller's payload.
 */
const isOrderNumberConflict = (error: unknown): boolean => {
  if (!isUniqueConstraintError(error)) return false;
  const fields = conflictingFields(error);
  return fields.length === 0 || fields.some((field) => /order_?number/i.test(field));
};

const mapItemPersistenceError = (error: unknown): never => {
  if (isUniqueConstraintError(error)) {
    throw new AppError('This product is already on the order', 409, 'ORDER_ITEM_DUPLICATE');
  }
  throw error;
};

const concurrentModification = (): AppError =>
  new AppError('Order was modified by another request', 409, 'ORDER_CONCURRENT_MODIFICATION');

const assertCurrentVersion = (actual: number, expected: number): void => {
  if (actual !== expected) throw concurrentModification();
};

const ensureOwnerAccess = (access: OrderAccess, ownerId: string): void => {
  if (access.scope === 'OWN' && ownerId !== access.actorId) {
    throw new AppError('Forbidden', 403, 'FORBIDDEN');
  }
};

/**
 * Human-readable and collision-resistant: a date prefix keeps the sequence
 * browsable while the random suffix keeps concurrent writers apart.
 */
const generateOrderNumber = (): string => {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = Math.floor(Math.random() * 36 ** 6)
    .toString(36)
    .toUpperCase()
    .padStart(6, '0');
  return `ORD-${date}-${suffix}`;
};

const findActive = async (
  store: OrdersTransaction['order'],
  access: OrderAccess,
  id: string,
): Promise<OrderRecord> => {
  const order = await store.findFirst({
    where: { id, deletedAt: null, ...(access.scope === 'OWN' ? { ownerId: access.actorId } : {}) },
    select: orderSelection,
  });
  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
  return order;
};

const assertContactAccess = async (
  transaction: OrdersTransaction,
  access: OrderAccess,
  contactId: string | null | undefined,
): Promise<void> => {
  if (!contactId) return;
  const contact = await transaction.contact.findFirst({
    where: {
      id: contactId,
      deletedAt: null,
      ...(access.scope === 'OWN' ? { ownerId: access.actorId } : {}),
    },
    select: { id: true },
  });
  if (!contact) throw new AppError('Contact not found', 404, 'CONTACT_NOT_FOUND');
};

const assertDealAccess = async (
  transaction: OrdersTransaction,
  access: OrderAccess,
  dealId: string | null | undefined,
): Promise<void> => {
  if (!dealId) return;
  const deal = await transaction.deal.findFirst({
    where: {
      id: dealId,
      deletedAt: null,
      ...(access.scope === 'OWN' ? { ownerId: access.actorId } : {}),
    },
    select: { id: true },
  });
  if (!deal) throw new AppError('Deal not found', 404, 'DEAL_NOT_FOUND');
};

interface OrderLine {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPrice: string;
  readonly lineTotal: string;
}

/**
 * Turns product references into order lines, snapshotting sku, name and the
 * price that is current *now*: a later catalogue change must not rewrite the
 * history of an order that has already been placed.
 */
const resolveLines = async (
  transaction: OrdersTransaction,
  currency: string,
  requests: readonly CreateOrderItemData[],
): Promise<readonly OrderLine[]> => {
  if (requests.length === 0) return [];
  const ids = [...new Set(requests.map((request) => request.productId))];
  const products = await transaction.product.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true, sku: true, name: true, unitPrice: true, currency: true, isActive: true },
  });
  const byId = new Map(products.map((product) => [product.id, product]));

  return requests.map((request) => {
    const product = byId.get(request.productId);
    if (!product) {
      throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND', {
        productId: request.productId,
      });
    }
    if (!product.isActive) {
      throw new AppError('Product is not available for ordering', 409, 'PRODUCT_INACTIVE', {
        productId: product.id,
      });
    }
    if (product.currency !== currency) {
      throw new AppError('Order and product currencies differ', 409, 'ORDER_CURRENCY_MISMATCH', {
        productId: product.id,
        productCurrency: product.currency,
        orderCurrency: currency,
      });
    }
    const unitPrice = normalizeMoney(product.unitPrice.toString());
    return {
      productId: product.id,
      sku: product.sku,
      name: product.name,
      quantity: request.quantity,
      unitPrice,
      lineTotal: calculateLineTotal(unitPrice, request.quantity),
    };
  });
};

const totalsFor = (
  lineTotals: readonly string[],
  discountTotal: DecimalLike,
  taxTotal: DecimalLike,
): OrderTotals =>
  calculateOrderTotals({
    lineTotals,
    discountTotal: discountTotal.toString(),
    taxTotal: taxTotal.toString(),
  });

/**
 * Re-labels a stock failure with the order line that caused it, so a rejected
 * confirmation tells the caller *which* product blocked it rather than merely
 * that something was short.
 */
const attributeToLine = (
  error: unknown,
  orderId: string,
  line: { readonly productId: string; readonly quantity: number },
): unknown => {
  if (!(error instanceof AppError)) return error;
  const details =
    typeof error.details === 'object' && error.details !== null ? error.details : undefined;
  return new AppError(error.message, error.statusCode, error.code, {
    ...details,
    orderId,
    productId: line.productId,
    quantity: line.quantity,
  });
};

export const createOrdersService = (
  db: OrdersDatabase,
  audit: AuditService,
  // Secondary consumers (event stream, realtime channel) are notified only once
  // the transaction has committed, so they can never affect its outcome.
  events: DomainEventPublisher = noopDomainEventPublisher,
  /**
   * The stock side of a status change. It is optional on purpose: without it
   * the service behaves exactly as it did before stock existed — a transition
   * moves the order and nothing else — so a composition that has no warehouse
   * (and every test that does not care about stock) still works. When it is
   * supplied, the stock movements run on the very same transaction as the
   * status change, so the two commit or roll back together.
   */
  stock?: OrdersStockPort | undefined,
): OrdersService => {
  /**
   * The publisher contract forbids throwing, but the primary path is guarded
   * anyway: a change that is already committed must be reported as a success
   * even if a secondary consumer is misbehaving.
   */
  const announce = (event: DomainEventNotification): void => {
    try {
      events.publish(event);
    } catch {
      // Intentionally ignored; see above.
    }
  };

  /**
   * Retries the whole transaction, not just the insert: a unique violation
   * aborts the surrounding Postgres transaction, so a fresh number has to be
   * drawn in a fresh transaction.
   */
  const withOrderNumber = async <T>(run: (orderNumber: string) => Promise<T>): Promise<T> => {
    for (let attempt = 1; attempt <= ORDER_NUMBER_ATTEMPTS; attempt += 1) {
      try {
        return await run(generateOrderNumber());
      } catch (error) {
        if (!isOrderNumberConflict(error) || attempt === ORDER_NUMBER_ATTEMPTS) throw error;
      }
    }
    /* c8 ignore next */
    throw new AppError('Could not allocate an order number', 409, 'ORDER_NUMBER_UNAVAILABLE');
  };

  const applyOrderUpdate = async (
    transaction: OrdersTransaction,
    access: OrderAccess,
    id: string,
    expected: { readonly version: number; readonly status: OrderStatus },
    data: Prisma.OrderUncheckedUpdateInput,
  ): Promise<OrderRecord> => {
    try {
      return await transaction.order.update({
        // The previously read version *and* status are part of the predicate,
        // so a racing writer that already moved the order loses this write.
        where: {
          id,
          version: expected.version,
          status: expected.status,
          deletedAt: null,
          ...(access.scope === 'OWN' ? { ownerId: access.actorId } : {}),
        },
        data: { ...data, version: { increment: 1 } },
        select: orderSelection,
      });
    } catch (error) {
      if (isRecordNotFoundError(error)) throw concurrentModification();
      throw error;
    }
  };

  /** Shared tail of every item mutation: recompute totals and bump the order. */
  const rewriteTotals = async (
    transaction: OrdersTransaction,
    access: OrderAccess,
    existing: OrderRecord,
    lineTotals: readonly string[],
  ): Promise<OrderRecord> =>
    applyOrderUpdate(
      transaction,
      access,
      existing.id,
      { version: existing.version, status: existing.status },
      totalsFor(lineTotals, existing.discountTotal, existing.taxTotal),
    );

  /**
   * Moves stock for every line of the order on the transaction that is already
   * carrying the status change. Nothing is published here: the returned
   * callbacks are invoked by the caller once the transaction has committed.
   *
   * The lines are walked one after another rather than in parallel, because
   * they all share a single transaction and a database transaction serves one
   * statement at a time.
   */
  const applyStockEffect = async (
    transaction: PrismaTransaction,
    access: OrderAccess,
    order: OrderRecord,
    effect: OrderStockEffect,
  ): Promise<readonly (() => void)[]> => {
    if (!stock) return [];
    const warehouseId = await stock.resolveWarehouseId(transaction);
    if (!warehouseId) {
      throw new AppError(
        'No warehouse is configured to hold stock for orders',
        409,
        'WAREHOUSE_NOT_CONFIGURED',
      );
    }
    const publishers: (() => void)[] = [];
    for (const line of order.items) {
      const input = {
        warehouseId,
        productId: line.productId,
        quantity: line.quantity,
        referenceType: ORDER_STOCK_REFERENCE_TYPE,
        referenceId: order.id,
        // Fulfilment hands over goods the order already holds a reservation
        // for, so the reservation is consumed by the same movement.
        ...(effect === 'issue' ? { fromReservation: true } : {}),
      };
      try {
        const change = await stock.operations[effect](transaction, access, input);
        publishers.push(change.publishCommitted);
      } catch (error) {
        throw attributeToLine(error, order.id, line);
      }
    }
    return publishers;
  };

  // Prisma's generic `findMany` overload can't be structurally verified against
  // a plain interface once the select includes a nested relation (`items`), so
  // the delegate is narrowed once here to the exact shape the reader needs.
  const readPage = createListReader({
    model: db.order as unknown as ListReaderModel<
      Prisma.OrderWhereInput,
      unknown,
      typeof orderSelection,
      OrderRecord
    >,
    select: orderSelection,
    toDto,
  });

  const create = async (access: OrderAccess, data: CreateOrderData): Promise<OrderDto> => {
    const ownerId = data.ownerId ?? access.actorId;
    ensureOwnerAccess(access, ownerId);
    const currency = data.currency ?? DEFAULT_CURRENCY;
    const discountTotal = data.discountTotal ?? ZERO_MONEY;
    const taxTotal = data.taxTotal ?? ZERO_MONEY;

    const created = await withOrderNumber(async (orderNumber) =>
      db.$transaction(async (transaction) => {
        await assertContactAccess(transaction, access, data.contactId);
        await assertDealAccess(transaction, access, data.dealId);
        const lines = await resolveLines(transaction, currency, data.items ?? []);
        const totals = totalsFor(
          lines.map((line) => line.lineTotal),
          discountTotal,
          taxTotal,
        );
        let order: OrderRecord;
        try {
          order = await transaction.order.create({
            data: {
              orderNumber,
              ownerId,
              contactId: data.contactId ?? null,
              dealId: data.dealId ?? null,
              status: 'DRAFT',
              currency,
              ...totals,
              notes: data.notes ?? null,
              ...(lines.length > 0
                ? { items: { create: lines.map((line) => ({ ...line })) } }
                : {}),
            },
            select: orderSelection,
          });
        } catch (error) {
          if (isOrderNumberConflict(error)) throw error;
          return mapItemPersistenceError(error);
        }
        const dto = toDto(order);
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'order.created',
          entityType: 'order',
          entityId: order.id,
          changes: { after: dto },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
        return dto;
      }),
    );

    announce({
      eventType: 'order.created',
      entityType: 'order',
      entityId: created.id,
      actorId: access.actorId,
      payload: { after: created },
    });

    return created;
  };

  return {
    async list(access, query) {
      const ownerId = access.scope === 'OWN' ? access.actorId : query.ownerId;
      const where = filter<Prisma.OrderWhereInput>({ deletedAt: null })
        .equals('ownerId', ownerId)
        .equals('contactId', query.contactId)
        .equals('dealId', query.dealId)
        .equals('status', query.status)
        .search(query.search, ['orderNumber'])
        .range('total', query.minTotal, query.maxTotal)
        .build();
      return readPage({
        where,
        page: query.page,
        pageSize: query.pageSize,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
      });
    },

    async getById(access, id) {
      return toDto(await findActive(db.order, access, id));
    },

    create,

    // The source may be in any status: duplicating is not a transition, it is a
    // fresh order that happens to start from the same lines. Prices are never
    // copied — the create path re-prices every line from the catalogue as it
    // stands now, so a duplicate never sells at a stale price.
    async duplicate(access, id) {
      const source = await findActive(db.order, access, id);
      return create(access, {
        ownerId: source.ownerId,
        contactId: source.contactId ?? undefined,
        currency: source.currency,
        items: source.items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
      });
    },

    async update(access, id, data) {
      const result = await db.$transaction(async (transaction) => {
        const existing = await findActive(transaction.order, access, id);
        assertCurrentVersion(existing.version, data.version);
        const ownerId = data.ownerId ?? existing.ownerId;
        ensureOwnerAccess(access, ownerId);
        // Money and currency reshape the order itself, so they follow the same
        // draft-only rule as the lines; descriptive fields stay editable until
        // the order reaches a terminal status.
        const touchesMoney =
          data.discountTotal !== undefined ||
          data.taxTotal !== undefined ||
          data.currency !== undefined;
        if (touchesMoney || existing.status === 'FULFILLED' || existing.status === 'CANCELLED') {
          assertOrderEditable(existing.status);
        }
        if (data.currency !== undefined && data.currency !== existing.currency) {
          if (existing.items.length > 0) {
            throw new AppError(
              'Currency cannot change while the order has items',
              409,
              'ORDER_CURRENCY_MISMATCH',
              { orderCurrency: existing.currency, requestedCurrency: data.currency },
            );
          }
        }
        await assertContactAccess(transaction, access, data.contactId);
        await assertDealAccess(transaction, access, data.dealId);
        // Totals are always derived, never taken from the request body.
        const totals = totalsFor(
          existing.items.map((item) => item.lineTotal.toString()),
          data.discountTotal ?? existing.discountTotal,
          data.taxTotal ?? existing.taxTotal,
        );
        const updated = await applyOrderUpdate(
          transaction,
          access,
          id,
          { version: existing.version, status: existing.status },
          {
            ...(data.ownerId !== undefined ? { ownerId: data.ownerId } : {}),
            ...(data.contactId !== undefined ? { contactId: data.contactId } : {}),
            ...(data.dealId !== undefined ? { dealId: data.dealId } : {}),
            ...(data.currency !== undefined ? { currency: data.currency } : {}),
            ...(data.notes !== undefined ? { notes: data.notes } : {}),
            ...totals,
          },
        );
        const before = toDto(existing);
        const after = toDto(updated);
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'order.updated',
          entityType: 'order',
          entityId: id,
          changes: { before, after },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
        return { before, after };
      });

      announce({
        eventType: 'order.updated',
        entityType: 'order',
        entityId: id,
        actorId: access.actorId,
        payload: result,
      });

      return result.after;
    },

    async addItem(access, id, data) {
      const result = await db.$transaction(async (transaction) => {
        const existing = await findActive(transaction.order, access, id);
        assertCurrentVersion(existing.version, data.version);
        assertOrderEditable(existing.status);
        const lines = await resolveLines(transaction, existing.currency, [
          { productId: data.productId, quantity: data.quantity },
        ]);
        const [line] = lines;
        if (!line) throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');
        try {
          await transaction.orderItem.create({ data: { orderId: id, ...line } });
        } catch (error) {
          mapItemPersistenceError(error);
        }
        const updated = await rewriteTotals(transaction, access, existing, [
          ...existing.items.map((item) => item.lineTotal.toString()),
          line.lineTotal,
        ]);
        const before = toDto(existing);
        const after = toDto(updated);
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'order.item_added',
          entityType: 'order',
          entityId: id,
          changes: { before, after },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
        return { before, after, productId: line.productId };
      });

      announce({
        eventType: 'order.item_added',
        entityType: 'order',
        entityId: id,
        actorId: access.actorId,
        payload: { productId: result.productId, before: result.before, after: result.after },
      });

      return result.after;
    },

    async updateItem(access, id, itemId, data) {
      const result = await db.$transaction(async (transaction) => {
        const existing = await findActive(transaction.order, access, id);
        assertCurrentVersion(existing.version, data.version);
        assertOrderEditable(existing.status);
        const item = existing.items.find((candidate) => candidate.id === itemId);
        if (!item) throw new AppError('Order item not found', 404, 'ORDER_ITEM_NOT_FOUND');
        // The snapshot price stays untouched: only the quantity is negotiable.
        const unitPrice = normalizeMoney(item.unitPrice.toString());
        const lineTotal = calculateLineTotal(unitPrice, data.quantity);
        await transaction.orderItem.update({
          where: { id: itemId },
          data: { quantity: data.quantity, lineTotal },
        });
        const updated = await rewriteTotals(
          transaction,
          access,
          existing,
          existing.items.map((candidate) =>
            candidate.id === itemId ? lineTotal : candidate.lineTotal.toString(),
          ),
        );
        const before = toDto(existing);
        const after = toDto(updated);
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'order.item_updated',
          entityType: 'order',
          entityId: id,
          changes: { before, after },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
        return { before, after };
      });

      // Reusing `order.updated`: a quantity change is an order-level change and
      // the payload carries the full before/after line-up anyway.
      announce({
        eventType: 'order.updated',
        entityType: 'order',
        entityId: id,
        actorId: access.actorId,
        payload: { itemId, before: result.before, after: result.after },
      });

      return result.after;
    },

    async removeItem(access, id, itemId, version) {
      const result = await db.$transaction(async (transaction) => {
        const existing = await findActive(transaction.order, access, id);
        assertCurrentVersion(existing.version, version);
        assertOrderEditable(existing.status);
        const item = existing.items.find((candidate) => candidate.id === itemId);
        if (!item) throw new AppError('Order item not found', 404, 'ORDER_ITEM_NOT_FOUND');
        await transaction.orderItem.deleteMany({ where: { id: itemId, orderId: id } });
        const updated = await rewriteTotals(
          transaction,
          access,
          existing,
          existing.items
            .filter((candidate) => candidate.id !== itemId)
            .map((candidate) => candidate.lineTotal.toString()),
        );
        const before = toDto(existing);
        const after = toDto(updated);
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'order.item_removed',
          entityType: 'order',
          entityId: id,
          changes: { before, after },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
        return { before, after };
      });

      announce({
        eventType: 'order.item_removed',
        entityType: 'order',
        entityId: id,
        actorId: access.actorId,
        payload: { itemId, before: result.before, after: result.after },
      });

      return result.after;
    },

    async transition(access, id, data) {
      const result = await db.$transaction(async (transaction) => {
        const existing = await findActive(transaction.order, access, id);
        assertCurrentVersion(existing.version, data.version);
        assertOrderStatusTransition(existing.status, data.status);
        assertOrderHasItems(existing.status, existing.items.length);
        const transitioned = await applyOrderUpdate(
          transaction,
          access,
          id,
          { version: existing.version, status: existing.status },
          {
            status: data.status,
            // Confirmation is the moment the order is actually placed.
            ...(data.status === 'CONFIRMED' ? { placedAt: new Date() } : {}),
          },
        );
        // Stock moves on the same transaction as the status change: a
        // reservation that cannot be met throws here, which rolls the status
        // change back and leaves the order where it was. The order write goes
        // first so that a stale version is rejected before any stock is touched.
        const effect = stockEffectForTransition(existing.status, data.status);
        const stockPublishers = effect
          ? await applyStockEffect(transaction, access, existing, effect)
          : [];
        const before = toDto(existing);
        const after = toDto(transitioned);
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'order.status_transitioned',
          entityType: 'order',
          entityId: id,
          changes: { before, after },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
        return { before, after, stockPublishers };
      });

      // The stock events belong to the warehouse module, which decides what
      // they say; the order only decides when they are safe to publish.
      for (const publish of result.stockPublishers) publish();

      announce({
        eventType: 'order.status_transitioned',
        entityType: 'order',
        entityId: id,
        actorId: access.actorId,
        payload: { from: result.before.status, to: result.after.status, after: result.after },
      });

      return result.after;
    },

    async delete(access, id, version) {
      await db.$transaction(async (transaction) => {
        const existing = await findActive(transaction.order, access, id);
        assertCurrentVersion(existing.version, version);
        const deletedAt = new Date();
        try {
          await transaction.order.update({
            where: {
              id,
              version,
              deletedAt: null,
              ...(access.scope === 'OWN' ? { ownerId: access.actorId } : {}),
            },
            data: { deletedAt, version: { increment: 1 } },
            select: orderSelection,
          });
        } catch (error) {
          if (isRecordNotFoundError(error)) throw concurrentModification();
          throw error;
        }
        await audit.record(transaction, {
          actorId: access.actorId,
          action: 'order.deleted',
          entityType: 'order',
          entityId: id,
          changes: { before: toDto(existing), after: { deletedAt, version: version + 1 } },
          ...(access.ipAddress ? { ipAddress: access.ipAddress } : {}),
        });
      });

      announce({
        eventType: 'order.deleted',
        entityType: 'order',
        entityId: id,
        actorId: access.actorId,
        payload: { id },
      });
    },
  };
};
