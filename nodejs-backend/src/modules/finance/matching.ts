import { toMinorUnits } from '../../common/money/index.js';
import type { PaymentMatchStatus, TransactionDirection } from './types.js';

/**
 * The reconciliation rule, on its own, with no database and no Prisma in
 * sight. Everything the rule is allowed to depend on is a parameter, so the
 * rule can be read, tested and argued about as a rule.
 *
 * The four numbers below are the rule's dials. They are constants of this
 * module and are deliberately gathered here rather than spelled out at the
 * places that use them: changing what "the same amount" or "in time" means has
 * to be a one-line change in one file, and has to be visible as such in a
 * diff.
 */

/** How far two amounts may differ and still count as the same payment. */
export const MATCH_AMOUNT_TOLERANCE = '0.01';

/** The same tolerance in whole minor units, which is how it is compared. */
export const MATCH_AMOUNT_TOLERANCE_MINOR_UNITS = toMinorUnits(MATCH_AMOUNT_TOLERANCE);

/** How long after an order was created a payment for it may still arrive. */
export const MATCH_WINDOW_DAYS = 90;

/** Orders in any other status are not awaiting money and are never candidates. */
export const MATCHABLE_ORDER_STATUSES = ['CONFIRMED', 'PAID'] as const;

/**
 * Only money coming in can settle an order. Rent, payroll and invoices from
 * suppliers are real transactions with real amounts, and leaving them out of
 * reconciliation is the point rather than an omission.
 */
export const RECONCILABLE_DIRECTION: TransactionDirection = 'CREDIT';

const DAY_MS = 86_400_000;

/** What the rule needs to know about the transaction being reconciled. */
export interface MatchableTransaction {
  readonly amount: string;
  readonly bookedAt: Date;
  readonly direction: TransactionDirection;
  readonly counterpartyName: string;
  readonly reference: string;
}

/** What the rule needs to know about an order it is considering. */
export interface MatchableOrder {
  readonly orderId: string;
  /** The human-readable number a payment reference is expected to quote. */
  readonly orderNumber: string;
  readonly status: string;
  readonly total: string;
  readonly createdAt: Date;
  /** Name of the contact the order belongs to, or null when it has none. */
  readonly contactName: string | null;
}

/**
 * Case and spacing are noise here: a teller types `ORD 2026 0001`, an online
 * form sends `ord-2026-0001`, and both mean the same order. Folding both away
 * is what lets one comparison serve every spelling.
 */
const normalize = (value: string): string => value.toLowerCase().replace(/\s+/g, '');

export const isMatchableOrderStatus = (status: string): boolean =>
  (MATCHABLE_ORDER_STATUSES as readonly string[]).includes(status);

export const isReconcilableDirection = (direction: TransactionDirection): boolean =>
  direction === RECONCILABLE_DIRECTION;

/** Condition 2, first half: the reference quotes the order number. */
export const referenceMentionsOrder = (reference: string, orderNumber: string): boolean =>
  normalize(reference).includes(normalize(orderNumber));

/** Condition 2, second half: the payer is named like the order's contact. */
export const counterpartyMatchesContact = (
  counterpartyName: string,
  contactName: string | null,
): boolean => contactName !== null && normalize(counterpartyName) === normalize(contactName);

/** Condition 3: the amounts agree to within the tolerance, in whole cents. */
export const amountsAgree = (left: string, right: string): boolean => {
  const difference = toMinorUnits(left) - toMinorUnits(right);
  const distance = difference < 0n ? -difference : difference;
  return distance <= MATCH_AMOUNT_TOLERANCE_MINOR_UNITS;
};

/**
 * Condition 4: money for an order cannot arrive before the order exists, and
 * a payment that turns up months later is more likely a different payment than
 * a very late one.
 */
export const bookedWithinWindow = (bookedAt: Date, orderCreatedAt: Date): boolean => {
  const booked = bookedAt.getTime();
  const created = orderCreatedAt.getTime();
  return booked >= created && booked <= created + MATCH_WINDOW_DAYS * DAY_MS;
};

/** All four conditions, in the order the specification states them. */
export const isMatchCandidate = (
  transaction: MatchableTransaction,
  order: MatchableOrder,
): boolean =>
  isMatchableOrderStatus(order.status) &&
  (referenceMentionsOrder(transaction.reference, order.orderNumber) ||
    counterpartyMatchesContact(transaction.counterpartyName, order.contactName)) &&
  amountsAgree(transaction.amount, order.total) &&
  bookedWithinWindow(transaction.bookedAt, order.createdAt);

export const findMatchCandidates = <TOrder extends MatchableOrder>(
  transaction: MatchableTransaction,
  orders: readonly TOrder[],
): readonly TOrder[] => {
  if (!isReconcilableDirection(transaction.direction)) return [];
  return orders.filter((order) => isMatchCandidate(transaction, order));
};

export interface MatchOutcome {
  readonly matchStatus: PaymentMatchStatus;
  /** The order to record, and only ever when the outcome is `MATCHED`. */
  readonly matchedOrderId: string | null;
}

/**
 * Exactly one candidate is an answer; several are a question for a human; none
 * is the ordinary state of a bank statement and not a failure.
 *
 * The pairing of `matchStatus` and `matchedOrderId` is decided here and only
 * here, which is what keeps the database's consistency check from ever having
 * to fire.
 */
export const matchOutcomeFor = (candidates: readonly MatchableOrder[]): MatchOutcome => {
  const [first] = candidates;
  if (candidates.length === 1 && first) {
    return { matchStatus: 'MATCHED', matchedOrderId: first.orderId };
  }
  return {
    matchStatus: candidates.length > 1 ? 'SUGGESTED' : 'UNMATCHED',
    matchedOrderId: null,
  };
};

/**
 * The widest span of order creation dates that could possibly match any of the
 * given transactions: a candidate must have been created no later than the
 * payment and no more than the window before it. Used to bound the order query
 * instead of reading the whole table.
 */
export const candidateCreationWindow = (
  bookedAt: readonly Date[],
): { readonly from: Date; readonly to: Date } | null => {
  const times = bookedAt.map((value) => value.getTime());
  if (times.length === 0) return null;
  const earliest = Math.min(...times);
  const latest = Math.max(...times);
  return { from: new Date(earliest - MATCH_WINDOW_DAYS * DAY_MS), to: new Date(latest) };
};
