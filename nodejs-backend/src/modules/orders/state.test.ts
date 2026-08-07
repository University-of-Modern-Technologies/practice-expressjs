import { describe, expect, it } from '@jest/globals';

import { orderState } from './state.js';
import { stockEffectForTransition } from './stock.js';
import { allowedOrderStatusTransitions, isOrderEditable } from './transition.js';
import { orderStatuses } from './types.js';

// The historical tables, kept here only as a fixed point to compare the
// single-source-of-truth states against. If a status is ever added without
// updating `state.ts`, one of these comparisons catches it.
const historicalTransitions: Readonly<Record<string, readonly string[]>> = {
  DRAFT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PAID', 'CANCELLED'],
  PAID: ['FULFILLED', 'CANCELLED'],
  FULFILLED: [],
  CANCELLED: [],
};

const historicalStockEffect = (
  from: string,
  to: string,
): 'reserve' | 'release' | 'issue' | null => {
  if (from === 'DRAFT' && to === 'CONFIRMED') return 'reserve';
  if (to === 'CANCELLED' && (from === 'CONFIRMED' || from === 'PAID')) return 'release';
  if (from === 'PAID' && to === 'FULFILLED') return 'issue';
  return null;
};

describe('order state registry', () => {
  it('has exactly one state per status', () => {
    for (const status of orderStatuses) {
      expect(orderState(status).status).toBe(status);
    }
  });

  it('carries the same transitions as the historical table, for every status', () => {
    for (const status of orderStatuses) {
      expect(orderState(status).allowedTransitions).toEqual(historicalTransitions[status]);
      expect(allowedOrderStatusTransitions[status]).toEqual(historicalTransitions[status]);
    }
  });

  it('carries the same stock effect as the historical function, for every pair', () => {
    for (const from of orderStatuses) {
      for (const to of orderStatuses) {
        expect(orderState(from).stockEffect(to)).toBe(historicalStockEffect(from, to));
        expect(stockEffectForTransition(from, to)).toBe(historicalStockEffect(from, to));
      }
    }
  });

  it('marks only DRAFT editable and only DRAFT as requiring items', () => {
    for (const status of orderStatuses) {
      const expected = status === 'DRAFT';
      expect(orderState(status).isEditable).toBe(expected);
      expect(isOrderEditable(status)).toBe(expected);
      expect(orderState(status).requiresItems).toBe(expected);
    }
  });
});
