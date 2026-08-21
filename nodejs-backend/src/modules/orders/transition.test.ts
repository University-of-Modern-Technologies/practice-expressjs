import { describe, expect, it } from '@jest/globals';

import {
  assertOrderEditable,
  assertOrderHasItems,
  assertOrderStatusTransition,
  canTransitionOrderStatus,
  isOrderEditable,
} from './transition.js';
import { orderStatuses, type OrderStatus } from './types.js';

const allowed: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  DRAFT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PAID', 'CANCELLED'],
  PAID: ['FULFILLED', 'CANCELLED'],
  FULFILLED: [],
  CANCELLED: [],
};

describe('order status matrix', () => {
  it.each(orderStatuses)('allows exactly the documented moves out of %s', (from) => {
    for (const to of orderStatuses) {
      expect(canTransitionOrderStatus(from, to)).toBe(allowed[from].includes(to));
    }
  });

  it('never lets an order return to a previous stage or repeat itself', () => {
    expect(canTransitionOrderStatus('CONFIRMED', 'DRAFT')).toBe(false);
    expect(canTransitionOrderStatus('PAID', 'CONFIRMED')).toBe(false);
    expect(canTransitionOrderStatus('FULFILLED', 'PAID')).toBe(false);
    expect(canTransitionOrderStatus('DRAFT', 'DRAFT')).toBe(false);
  });

  it('never cancels a fulfilled order and never revives a cancelled one', () => {
    expect(canTransitionOrderStatus('FULFILLED', 'CANCELLED')).toBe(false);
    expect(canTransitionOrderStatus('CANCELLED', 'CONFIRMED')).toBe(false);
  });

  it('skips no stage on the happy path', () => {
    expect(canTransitionOrderStatus('DRAFT', 'PAID')).toBe(false);
    expect(canTransitionOrderStatus('CONFIRMED', 'FULFILLED')).toBe(false);
  });

  it('reports a forbidden move as a conflict carrying the allowed moves', () => {
    expect(() => {
      assertOrderStatusTransition('FULFILLED', 'CANCELLED');
    }).toThrow(
      expect.objectContaining({ statusCode: 409, code: 'INVALID_ORDER_STATUS_TRANSITION' }),
    );
    expect(() => {
      assertOrderStatusTransition('DRAFT', 'CONFIRMED');
    }).not.toThrow();
  });
});

describe('order editability', () => {
  it('treats only a draft as editable', () => {
    expect(isOrderEditable('DRAFT')).toBe(true);
    for (const status of orderStatuses.filter((value) => value !== 'DRAFT')) {
      expect(isOrderEditable(status)).toBe(false);
      expect(() => {
        assertOrderEditable(status);
      }).toThrow(expect.objectContaining({ statusCode: 409, code: 'ORDER_NOT_EDITABLE' }));
    }
  });

  it('keeps an empty order in the draft stage', () => {
    expect(() => {
      assertOrderHasItems('DRAFT', 0);
    }).toThrow(expect.objectContaining({ statusCode: 409, code: 'ORDER_HAS_NO_ITEMS' }));
    expect(() => {
      assertOrderHasItems('DRAFT', 1);
    }).not.toThrow();
    // Once the order has left the draft stage the guard no longer applies.
    expect(() => {
      assertOrderHasItems('CONFIRMED', 0);
    }).not.toThrow();
  });
});
