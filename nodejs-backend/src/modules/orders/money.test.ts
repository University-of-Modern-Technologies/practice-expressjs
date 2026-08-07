import { describe, expect, it } from '@jest/globals';

import { AppError } from '../../common/errors/index.js';
import {
  ZERO_MONEY,
  calculateLineTotal,
  calculateOrderTotals,
  fromMinorUnits,
  normalizeMoney,
  toMinorUnits,
} from './money.js';

describe('money conversion', () => {
  it('parses and renders amounts without losing the scale', () => {
    expect(toMinorUnits('19.99')).toBe(1999n);
    expect(toMinorUnits('19.9')).toBe(1990n);
    expect(toMinorUnits('19')).toBe(1900n);
    expect(fromMinorUnits(1999n)).toBe('19.99');
    expect(fromMinorUnits(0n)).toBe(ZERO_MONEY);
    // Prisma renders Decimal(14,2) without trailing zeros, which must survive.
    expect(normalizeMoney('19.9')).toBe('19.90');
  });

  it('rejects anything that is not a non-negative decimal amount', () => {
    for (const value of ['-1.00', '1.005', 'abc', '', '1e3']) {
      expect(() => toMinorUnits(value)).toThrow(AppError);
    }
  });

  it('refuses a non-positive or fractional quantity', () => {
    expect(() => calculateLineTotal('19.99', 0)).toThrow(
      expect.objectContaining({ code: 'INVALID_ITEM_QUANTITY' }),
    );
    expect(() => calculateLineTotal('19.99', 1.5)).toThrow(
      expect.objectContaining({ code: 'INVALID_ITEM_QUANTITY' }),
    );
  });
});

describe('order total recomputation', () => {
  it('stays exact where binary floating point does not', () => {
    // The float path is demonstrably wrong for these very ordinary prices.
    expect(0.07 * 3).not.toBe(0.21);
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(19.99 * 7).not.toBe(139.93);

    expect(calculateLineTotal('0.07', 3)).toBe('0.21');
    expect(calculateLineTotal('19.99', 7)).toBe('139.93');
    expect(
      calculateOrderTotals({
        lineTotals: ['0.10', '0.20'],
        discountTotal: ZERO_MONEY,
        taxTotal: ZERO_MONEY,
      }).subtotal,
    ).toBe('0.30');
  });

  it('sums the lines and applies the discount before the tax', () => {
    expect(
      calculateOrderTotals({
        lineTotals: ['59.97', '10.03'],
        discountTotal: '5.00',
        taxTotal: '13.00',
      }),
    ).toEqual({
      subtotal: '70.00',
      discountTotal: '5.00',
      taxTotal: '13.00',
      total: '78.00',
    });
  });

  it('keeps large orders exact beyond the safe float range for cents', () => {
    const lineTotals = Array.from({ length: 1000 }, () => '9999999.99');
    expect(calculateOrderTotals({ lineTotals, discountTotal: '0', taxTotal: '0' }).subtotal).toBe(
      '9999999990.00',
    );
  });

  it('produces zero totals for an order without lines', () => {
    expect(calculateOrderTotals({ lineTotals: [], discountTotal: '0', taxTotal: '0' })).toEqual({
      subtotal: ZERO_MONEY,
      discountTotal: ZERO_MONEY,
      taxTotal: ZERO_MONEY,
      total: ZERO_MONEY,
    });
  });

  it('rejects a discount that pushes the total below zero', () => {
    expect(() =>
      calculateOrderTotals({ lineTotals: ['10.00'], discountTotal: '10.01', taxTotal: '0' }),
    ).toThrow(expect.objectContaining({ statusCode: 400, code: 'ORDER_TOTALS_INVALID' }));
  });
});
