import { AppError } from '../../common/errors/index.js';
import { fromMinorUnits, toMinorUnits } from '../../common/money/index.js';

/**
 * Order arithmetic on top of the shared money primitives.
 *
 * What lives here is what only an order means: a line total, and the rule that
 * an order's own totals are recomputed rather than trusted. Parsing and
 * rendering an amount are not order concerns and live in `common/money`.
 */

export const lineTotalMinorUnits = (unitPrice: string, quantity: number): bigint => {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new AppError('Quantity must be a positive integer', 400, 'INVALID_ITEM_QUANTITY');
  }
  return toMinorUnits(unitPrice) * BigInt(quantity);
};

export const calculateLineTotal = (unitPrice: string, quantity: number): string =>
  fromMinorUnits(lineTotalMinorUnits(unitPrice, quantity));

export interface TotalsInput {
  readonly lineTotals: readonly string[];
  readonly discountTotal: string;
  readonly taxTotal: string;
}

export interface OrderTotals {
  readonly subtotal: string;
  readonly discountTotal: string;
  readonly taxTotal: string;
  readonly total: string;
}

/**
 * Recomputes every monetary field of an order from its lines. A client-supplied
 * total is never trusted, so this is the only place order totals originate.
 */
export const calculateOrderTotals = ({
  lineTotals,
  discountTotal,
  taxTotal,
}: TotalsInput): OrderTotals => {
  const subtotal = lineTotals.reduce((sum, value) => sum + toMinorUnits(value), 0n);
  const discount = toMinorUnits(discountTotal);
  const tax = toMinorUnits(taxTotal);
  const total = subtotal - discount + tax;
  if (total < 0n) {
    throw new AppError(
      'Order discount exceeds the order value',
      400,
      'ORDER_TOTALS_INVALID',
      // Reported in the same units the client sent, not in cents.
      { subtotal: fromMinorUnits(subtotal), discountTotal, taxTotal },
    );
  }
  return {
    subtotal: fromMinorUnits(subtotal),
    discountTotal: fromMinorUnits(discount),
    taxTotal: fromMinorUnits(tax),
    total: fromMinorUnits(total),
  };
};
