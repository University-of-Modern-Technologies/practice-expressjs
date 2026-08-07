import { describe, expect, it } from '@jest/globals';

import {
  averageDecimal,
  compareDecimals,
  formatDecimal,
  fromScaledInteger,
  ratio,
  sumDecimals,
  toScaledInteger,
} from './decimal.js';

// Stand-in for a Prisma Decimal: the only contract used is `toString()`.
const decimal = (text: string): { toString(): string } => ({ toString: () => text });

describe('analytics decimal formatting', () => {
  it('renders money as a fixed-scale string', () => {
    expect(formatDecimal('1234.5')).toBe('1234.50');
    expect(formatDecimal('1234')).toBe('1234.00');
    expect(formatDecimal(decimal('0.1'))).toBe('0.10');
    expect(formatDecimal(decimal('19999999999.99'))).toBe('19999999999.99');
  });

  it('treats an empty aggregate as zero', () => {
    expect(formatDecimal(null)).toBe('0.00');
    expect(formatDecimal(undefined)).toBe('0.00');
    expect(formatDecimal('not a number')).toBe('0.00');
  });

  it('rounds half away from zero without a float in sight', () => {
    expect(formatDecimal('0.005')).toBe('0.01');
    expect(formatDecimal('0.004')).toBe('0.00');
    expect(formatDecimal('-0.005')).toBe('-0.01');
    // 0.1 + 0.2 in binary floats is 0.30000000000000004; string maths is exact.
    expect(sumDecimals(['0.1', '0.2'])).toBe('0.30');
  });

  it('keeps negative values signed', () => {
    expect(formatDecimal('-12.3')).toBe('-12.30');
    expect(fromScaledInteger(-5n)).toBe('-0.05');
    expect(toScaledInteger('-12.34')).toBe(-1234n);
  });

  it('sums many values exactly', () => {
    expect(sumDecimals([])).toBe('0.00');
    expect(sumDecimals(['10.10', decimal('20.20'), '0.7'])).toBe('31.00');
  });

  it('averages with a guard against a zero count', () => {
    expect(averageDecimal('100.00', 4)).toBe('25.00');
    expect(averageDecimal('10.00', 3)).toBe('3.33');
    expect(averageDecimal('100.00', 0)).toBe('0.00');
    expect(averageDecimal(null, 5)).toBe('0.00');
  });

  it('orders decimals without converting them to floats', () => {
    expect(compareDecimals('10.00', '9.99')).toBe(1);
    expect(compareDecimals('9.99', '10.00')).toBe(-1);
    expect(compareDecimals('10.00', '10.000')).toBe(0);
  });

  it('computes a rate and never divides by zero', () => {
    expect(ratio(5, 10)).toBe(0.5);
    expect(ratio(1, 3)).toBe(0.3333);
    expect(ratio(0, 0)).toBe(0);
    expect(ratio(7, 0)).toBe(0);
  });
});
