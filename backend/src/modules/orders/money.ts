import { AppError } from '../../common/errors/index.js';
import { fromMinorUnits, toMinorUnits } from '../../common/money/index.js';

/**
 * Order arithmetic on top of the shared money primitives.
 *
 * What lives here is what only an order means: a line total, and the rule that
 * an order's own totals are recomputed rather than trusted. Parsing and
 * rendering an amount are not order concerns and live in `common/money`.
 */

/**
 * The largest amount a monetary column (`Decimal(14, 2)`) can hold, in minor
 * units. Anything derived above it is refused before it reaches the database,
 * which would otherwise fail the write with a numeric overflow.
 */
export const MAX_MONEY_MINOR_UNITS = 99_999_999_999_999n;

const assertWithinMoneyRange = (field: string, value: bigint): bigint => {
  if (value > MAX_MONEY_MINOR_UNITS) {
    throw new AppError(
      `Order ${field} exceeds the largest amount that can be stored`,
      400,
      'ORDER_AMOUNT_OUT_OF_RANGE',
      { field, max: fromMinorUnits(MAX_MONEY_MINOR_UNITS) },
    );
  }
  return value;
};

export const lineTotalMinorUnits = (unitPrice: string, quantity: number): bigint => {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new AppError('Quantity must be a positive integer', 400, 'INVALID_ITEM_QUANTITY');
  }
  return assertWithinMoneyRange('lineTotal', toMinorUnits(unitPrice) * BigInt(quantity));
};

export const calculateLineTotal = (unitPrice: string, quantity: number): string =>
  fromMinorUnits(lineTotalMinorUnits(unitPrice, quantity));

export interface TotalsInput {
  readonly lineTotals: readonly string[];
  readonly discountTotal: string;
  readonly taxTotal: string;
  /**
   * When set, a discount larger than the subtotal is lowered to the subtotal
   * instead of being refused. Used where the discount was not part of the
   * request — a line was removed or reduced — so the caller's edit succeeds and
   * the response shows the discount that now applies.
   */
  readonly capDiscount?: boolean;
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
 *
 * The discount is measured against the subtotal, not against the total: a tax
 * added on top must not make an oversized discount look acceptable.
 */
export const calculateOrderTotals = ({
  lineTotals,
  discountTotal,
  taxTotal,
  capDiscount = false,
}: TotalsInput): OrderTotals => {
  const subtotal = assertWithinMoneyRange(
    'subtotal',
    lineTotals.reduce((sum, value) => sum + toMinorUnits(value), 0n),
  );
  const requestedDiscount = toMinorUnits(discountTotal);
  const tax = toMinorUnits(taxTotal);
  if (requestedDiscount > subtotal && !capDiscount) {
    throw new AppError(
      'Order discount exceeds the order subtotal',
      400,
      'ORDER_TOTALS_INVALID',
      // Reported in the same units the client sent, not in cents.
      { subtotal: fromMinorUnits(subtotal), discountTotal, taxTotal },
    );
  }
  const discount = requestedDiscount > subtotal ? subtotal : requestedDiscount;
  const total = assertWithinMoneyRange('total', subtotal - discount + tax);
  return {
    subtotal: fromMinorUnits(subtotal),
    discountTotal: fromMinorUnits(discount),
    taxTotal: fromMinorUnits(tax),
    total: fromMinorUnits(total),
  };
};
