import type { PrismaTransaction } from '../../db/prisma.js';
import { orderState } from './state.js';
import type { OrderAccess, OrderStatus } from './types.js';

// Re-exported for callers that used to import the type from this module; it
// now lives in `types.ts` so `state.ts` can describe a status without
// importing the stock module, which would otherwise import the state back.
export type { OrderStockEffect } from './types.js';

/**
 * Every movement an order transition produces is tagged with this reference
 * type and the order's id, so the stock ledger can always be read back to the
 * order that moved the goods.
 */
export const ORDER_STOCK_REFERENCE_TYPE = 'order';

/**
 * The stock consequence of a status change:
 *
 * - `DRAFT → CONFIRMED` promises the goods, so every line is reserved;
 * - `CONFIRMED → CANCELLED` and `PAID → CANCELLED` give the promise back;
 * - `PAID → FULFILLED` hands the goods over against that reservation.
 *
 * Every other transition leaves stock untouched: a draft that is cancelled
 * never reserved anything, and payment moves money rather than goods.
 */
export const stockEffectForTransition = (from: OrderStatus, to: OrderStatus) =>
  orderState(from).stockEffect(to);

/** One stock request, describing a single order line against one warehouse. */
export interface OrderStockInput {
  readonly warehouseId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly referenceType: string;
  readonly referenceId: string;
  /** Set when the movement consumes a reservation the order already holds. */
  readonly fromReservation?: boolean | undefined;
}

/**
 * What a stock operation hands back. The order service treats it as opaque
 * except for the callback, which it invokes once its own transaction has
 * committed so that stock events keep following the after-commit rule.
 */
export interface OrderStockChange {
  readonly publishCommitted: () => void;
}

/**
 * The stock operations an order needs, each running on the transaction the
 * order service supplies. Declaring the port here — rather than importing the
 * warehouse service — is what keeps the dependency one-way: orders states what
 * it needs, and the composition root decides who provides it.
 */
export interface OrderStockOperations {
  reserve(
    transaction: PrismaTransaction,
    access: OrderAccess,
    input: OrderStockInput,
  ): Promise<OrderStockChange>;
  release(
    transaction: PrismaTransaction,
    access: OrderAccess,
    input: OrderStockInput,
  ): Promise<OrderStockChange>;
  issue(
    transaction: PrismaTransaction,
    access: OrderAccess,
    input: OrderStockInput,
  ): Promise<OrderStockChange>;
}

/**
 * Resolves the warehouse an order draws on. An order carries no warehouse of
 * its own, so the choice is a deployment decision: the callback runs on the
 * order's transaction and returns the target warehouse id, or nothing at all
 * when none is configured.
 */
export type OrderWarehouseResolver = (
  transaction: PrismaTransaction,
) => Promise<string | null | undefined>;

/** Everything the orders service needs to move stock, injected as one unit. */
export interface OrdersStockPort {
  readonly operations: OrderStockOperations;
  readonly resolveWarehouseId: OrderWarehouseResolver;
}
