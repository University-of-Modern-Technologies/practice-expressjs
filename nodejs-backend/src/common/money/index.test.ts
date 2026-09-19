import { describe, expect, it } from '@jest/globals';

import { AppError } from '../errors/index.js';
import { ZERO_MONEY, fromMinorUnits, normalizeMoney, toMinorUnits } from './index.js';

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
});
