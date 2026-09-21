import { describe, expect, it } from '@jest/globals';

import {
  MATCHABLE_ORDER_STATUSES,
  MATCH_AMOUNT_TOLERANCE,
  MATCH_WINDOW_DAYS,
  amountsAgree,
  bookedWithinWindow,
  candidatePlacementWindow,
  counterpartyMatchesContact,
  findMatchCandidates,
  isMatchCandidate,
  matchOutcomeFor,
  referenceMentionsOrder,
  type MatchableOrder,
  type MatchableTransaction,
} from './matching.js';

const DAY_MS = 86_400_000;

const orderPlacedAt = new Date('2026-01-02T09:00:00.000Z');

const order: MatchableOrder = {
  orderId: 'order-1',
  orderNumber: 'ORD-2026-0001',
  status: 'CONFIRMED',
  total: '1800.00',
  placedAt: orderPlacedAt,
  contactName: 'Alex North',
  contactCompany: 'Northwind Workshop',
};

const payment: MatchableTransaction = {
  amount: '1800.00',
  bookedAt: new Date('2026-01-05T10:00:00.000Z'),
  direction: 'CREDIT',
  counterpartyName: 'Northwind Workshop',
  reference: 'Payment for order ORD-2026-0001',
};

describe('reconciliation conditions', () => {
  it('reads an order number through any spelling of it', () => {
    expect(referenceMentionsOrder('Payment for order ORD-2026-0001', 'ORD-2026-0001')).toBe(true);
    expect(referenceMentionsOrder('paid ord-2026-0001 in full', 'ORD-2026-0001')).toBe(true);
    // Spacing is noise: a teller types the number the way a teller types it.
    expect(referenceMentionsOrder('ORD 2026 0001', 'ORD-2026-0001')).toBe(false);
    expect(referenceMentionsOrder('ORD-2026-0002', 'ORD-2026-0001')).toBe(false);
  });

  it('accepts the payer name as evidence only when it is the same name', () => {
    expect(counterpartyMatchesContact('alex north', 'Alex North')).toBe(true);
    expect(counterpartyMatchesContact('AlexNorth', 'Alex North')).toBe(true);
    expect(counterpartyMatchesContact('Alex Northwind', 'Alex North')).toBe(false);
    // An order with no contact cannot be identified by a name.
    expect(counterpartyMatchesContact('Alex North', null)).toBe(false);
  });

  it('allows exactly one cent of disagreement and no more', () => {
    expect(MATCH_AMOUNT_TOLERANCE).toBe('0.01');
    expect(amountsAgree('1800.00', '1800.00')).toBe(true);
    expect(amountsAgree('1799.99', '1800.00')).toBe(true);
    expect(amountsAgree('1800.01', '1800.00')).toBe(true);
    expect(amountsAgree('1799.98', '1800.00')).toBe(false);
    expect(amountsAgree('1800.02', '1800.00')).toBe(false);
  });

  it('opens the window at the order and shuts it ninety days later', () => {
    expect(MATCH_WINDOW_DAYS).toBe(90);
    expect(bookedWithinWindow(orderPlacedAt, orderPlacedAt)).toBe(true);
    expect(
      bookedWithinWindow(
        new Date(orderPlacedAt.getTime() + MATCH_WINDOW_DAYS * DAY_MS),
        orderPlacedAt,
      ),
    ).toBe(true);
    expect(
      bookedWithinWindow(
        new Date(orderPlacedAt.getTime() + (MATCH_WINDOW_DAYS + 1) * DAY_MS),
        orderPlacedAt,
      ),
    ).toBe(false);
    // Money cannot arrive for an order that does not exist yet.
    expect(bookedWithinWindow(new Date(orderPlacedAt.getTime() - 1), orderPlacedAt)).toBe(false);
  });

  it('requires an order that is actually waiting for money', () => {
    expect(MATCHABLE_ORDER_STATUSES).toEqual(['CONFIRMED', 'PAID']);
    for (const status of MATCHABLE_ORDER_STATUSES) {
      expect(isMatchCandidate(payment, { ...order, status })).toBe(true);
    }
    for (const status of ['DRAFT', 'FULFILLED', 'CANCELLED']) {
      expect(isMatchCandidate(payment, { ...order, status })).toBe(false);
    }
  });

  it('needs all four conditions, not three of them', () => {
    expect(isMatchCandidate(payment, order)).toBe(true);
    expect(isMatchCandidate({ ...payment, amount: '1700.00' }, order)).toBe(false);
    expect(
      // Both halves of condition 2 have to fail: no number in the reference
      // and a payer who is neither the person nor the company.
      isMatchCandidate(
        { ...payment, reference: 'General deposit', counterpartyName: 'Unknown Payer' },
        order,
      ),
    ).toBe(false);
    expect(
      isMatchCandidate({ ...payment, bookedAt: new Date('2026-06-01T00:00:00.000Z') }, order),
    ).toBe(false);
  });
});

describe('candidate search', () => {
  it('never considers money that is leaving the account', () => {
    // Rent, payroll and supplier invoices are real payments with real amounts;
    // leaving them out of reconciliation is the rule, not an oversight.
    expect(findMatchCandidates({ ...payment, direction: 'DEBIT' }, [order])).toEqual([]);
  });

  it('finds every order the evidence fits, not the first one', () => {
    const twin: MatchableOrder = { ...order, orderId: 'order-2', orderNumber: 'ORD-2026-0007' };
    const anonymous: MatchableTransaction = {
      ...payment,
      reference: 'Bank transfer',
      counterpartyName: 'Alex North',
    };

    expect(findMatchCandidates(anonymous, [order, twin])).toHaveLength(2);
  });
});

describe('match outcome', () => {
  it('turns one candidate into an answer and several into a question', () => {
    expect(matchOutcomeFor([order])).toEqual({
      matchStatus: 'MATCHED',
      matchedOrderId: 'order-1',
    });
    expect(matchOutcomeFor([order, { ...order, orderId: 'order-2' }])).toEqual({
      matchStatus: 'SUGGESTED',
      matchedOrderId: null,
    });
    expect(matchOutcomeFor([])).toEqual({ matchStatus: 'UNMATCHED', matchedOrderId: null });
  });

  it('records an order only on a matched outcome', () => {
    // The database holds the same rule as a check constraint, so any other
    // pairing produced here would fail the write rather than be stored.
    for (const candidates of [[], [order], [order, { ...order, orderId: 'order-2' }]]) {
      const outcome = matchOutcomeFor(candidates);
      expect(outcome.matchedOrderId !== null).toBe(outcome.matchStatus === 'MATCHED');
    }
  });
});

describe('candidate creation window', () => {
  it('spans from the window before the earliest payment to the latest one', () => {
    const early = new Date('2026-01-05T10:00:00.000Z');
    const late = new Date('2026-01-27T10:00:00.000Z');

    expect(candidatePlacementWindow([late, early])).toEqual({
      from: new Date(early.getTime() - MATCH_WINDOW_DAYS * DAY_MS),
      to: late,
    });
  });

  it('has nothing to span when there is nothing to reconcile', () => {
    expect(candidatePlacementWindow([])).toBeNull();
  });
});
