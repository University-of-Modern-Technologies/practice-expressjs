import type { OrderStatus, OrderStockEffect } from './types.js';

/**
 * Everything the rest of the module needs to know about one status, gathered
 * in one place so that adding a status means adding one object here instead
 * of remembering every file that has an opinion about it.
 */
export interface OrderState {
  readonly status: OrderStatus;
  /** Statuses reachable from here. */
  readonly allowedTransitions: readonly OrderStatus[];
  /** Lines and monetary fields may only be reshaped in this state. */
  readonly isEditable: boolean;
  /** Leaving this state requires at least one line. */
  readonly requiresItems: boolean;
  /** Stock consequence of moving to `to`, or null when stock is untouched. */
  stockEffect(to: OrderStatus): OrderStockEffect | null;
}

/**
 * A draft is the only status that is still being assembled: it may be
 * reshaped freely, but it must not leave empty-handed. Confirming it is the
 * moment the goods are promised, so that is the one move that reserves stock.
 */
const draft: OrderState = {
  status: 'DRAFT',
  allowedTransitions: ['CONFIRMED', 'CANCELLED'],
  isEditable: true,
  requiresItems: true,
  stockEffect: (to) => (to === 'CONFIRMED' ? 'reserve' : null),
};

/** A confirmed order is fixed in shape; cancelling it gives the promise back. */
const confirmed: OrderState = {
  status: 'CONFIRMED',
  allowedTransitions: ['PAID', 'CANCELLED'],
  isEditable: false,
  requiresItems: false,
  stockEffect: (to) => (to === 'CANCELLED' ? 'release' : null),
};

/**
 * A paid order either hands the goods over (fulfilment) or gives the
 * reservation back (cancellation) — the only two moves it has left.
 */
const paid: OrderState = {
  status: 'PAID',
  allowedTransitions: ['FULFILLED', 'CANCELLED'],
  isEditable: false,
  requiresItems: false,
  stockEffect: (to) => {
    if (to === 'FULFILLED') return 'issue';
    if (to === 'CANCELLED') return 'release';
    return null;
  },
};

/** Final: the goods have already left the warehouse, so nothing follows. */
const fulfilled: OrderState = {
  status: 'FULFILLED',
  allowedTransitions: [],
  isEditable: false,
  requiresItems: false,
  stockEffect: () => null,
};

/** Final: whatever stock this order held has already been released. */
const cancelled: OrderState = {
  status: 'CANCELLED',
  allowedTransitions: [],
  isEditable: false,
  requiresItems: false,
  stockEffect: () => null,
};

const states: Readonly<Record<OrderStatus, OrderState>> = {
  DRAFT: draft,
  CONFIRMED: confirmed,
  PAID: paid,
  FULFILLED: fulfilled,
  CANCELLED: cancelled,
};

export const orderState = (status: OrderStatus): OrderState => states[status];
