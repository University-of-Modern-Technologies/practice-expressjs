import { AppError } from '../errors/index.js';

/**
 * Money arithmetic is done in integer minor units (cents) held in `bigint`,
 * never in JavaScript floating point.
 *
 * The reason is exactness: `0.1 + 0.2` is `0.30000000000000004` in binary
 * floating point, and `19.99 * 3` is `59.970000000000006`. Both would be
 * persisted into `Decimal(14,2)` columns after a lossy rounding step and would
 * drift away from the sum a human gets on paper. Working with whole cents makes
 * every intermediate value exact, and the single conversion back to a decimal
 * string is a pure formatting step.
 *
 * All money crossing a module boundary is a string such as `"19.99"`, so no
 * value ever passes through a `number`.
 *
 * These primitives live outside any one domain because more than one needs
 * them, and because a second copy would be a second answer to the question of
 * what `"19.99"` means. Arithmetic that belongs to a single domain — order
 * totals, for one — stays with that domain.
 */

/** Number of decimal places of the monetary columns (`Decimal(14, 2)`). */
export const MONEY_SCALE = 2;

const MINOR_UNITS_PER_UNIT = 100n;
const MONEY_PATTERN = /^\d{1,12}(?:\.\d{1,2})?$/;

export const ZERO_MONEY = '0.00';

/** Parses a non-negative decimal string into whole minor units. */
export const toMinorUnits = (value: string): bigint => {
  const trimmed = value.trim();
  if (!MONEY_PATTERN.test(trimmed)) {
    throw new AppError(`Invalid monetary amount: ${value}`, 400, 'INVALID_MONETARY_AMOUNT');
  }
  const [whole = '0', fraction = ''] = trimmed.split('.');
  return BigInt(whole) * MINOR_UNITS_PER_UNIT + BigInt(fraction.padEnd(MONEY_SCALE, '0'));
};

/** Renders minor units back as a fixed-scale decimal string. */
export const fromMinorUnits = (value: bigint): string => {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / MINOR_UNITS_PER_UNIT;
  const fraction = absolute % MINOR_UNITS_PER_UNIT;
  return `${negative ? '-' : ''}${whole.toString()}.${fraction.toString().padStart(MONEY_SCALE, '0')}`;
};

/** Normalises any accepted representation to the canonical `0.00` shape. */
export const normalizeMoney = (value: string): string => fromMinorUnits(toMinorUnits(value));
