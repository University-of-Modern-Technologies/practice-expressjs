import { AppError } from '../../common/errors/index.js';
import { orderState } from './state.js';
import { orderStatuses, type OrderStatus } from './types.js';

/**
 * The order lifecycle. `CANCELLED` is reachable from every stage that has not
 * been fulfilled yet; a fulfilled order is final, because the goods have
 * already left the warehouse.
 *
 * Derived from `orderState` rather than written out again, so this table and
 * the one baked into each state can never drift apart.
 */
export const allowedOrderStatusTransitions: Readonly<Record<OrderStatus, readonly OrderStatus[]>> =
  Object.fromEntries(
    orderStatuses.map((status) => [status, orderState(status).allowedTransitions]),
  ) as Readonly<Record<OrderStatus, readonly OrderStatus[]>>;

export const canTransitionOrderStatus = (from: OrderStatus, to: OrderStatus): boolean =>
  orderState(from).allowedTransitions.includes(to);

export const assertOrderStatusTransition = (from: OrderStatus, to: OrderStatus): void => {
  if (!canTransitionOrderStatus(from, to)) {
    throw new AppError(
      `Order status cannot transition from ${from} to ${to}`,
      409,
      'INVALID_ORDER_STATUS_TRANSITION',
      { from, to, allowed: orderState(from).allowedTransitions },
    );
  }
};

/** Lines and monetary fields may only be reshaped while the order is a draft. */
export const isOrderEditable = (status: OrderStatus): boolean => orderState(status).isEditable;

export const assertOrderEditable = (status: OrderStatus): void => {
  if (!isOrderEditable(status)) {
    throw new AppError(
      `Order items can only be changed while the order is a draft (current status: ${status})`,
      409,
      'ORDER_NOT_EDITABLE',
      { status },
    );
  }
};

/** An empty order carries no value, so it may never leave the draft stage. */
export const assertOrderHasItems = (status: OrderStatus, itemCount: number): void => {
  if (orderState(status).requiresItems && itemCount === 0) {
    throw new AppError(
      'An order without items cannot leave the draft stage',
      409,
      'ORDER_HAS_NO_ITEMS',
    );
  }
};
