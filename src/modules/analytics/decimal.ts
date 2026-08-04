/**
 * Money never travels through a JS float in this module. Values arrive either
 * as a Prisma `Decimal` or as a string produced by Postgres, and every
 * conversion below is string or BigInt arithmetic, so no cent is ever lost to
 * binary rounding. Reports therefore always return money as decimal strings.
 */

export interface DecimalLike {
  toString(): string;
}

export type DecimalInput = DecimalLike | string | number | null | undefined;

/** Number of fractional digits used for every monetary value. */
export const MONEY_SCALE = 2;

const PLAIN_DECIMAL = /^-?\d+(?:\.\d+)?$/;
const DIGIT_FIVE = 53; // '5'

const rawText = (value: DecimalInput): string => {
  if (value === null || value === undefined) return '0';
  if (typeof value === 'string') return value.trim();
  return value.toString().trim();
};

/**
 * Converts a decimal value into an integer number of the smallest unit (cents
 * at the default scale), rounding half away from zero. Anything that is not a
 * plain decimal literal (an empty aggregate, an exponent form) counts as zero,
 * which keeps a single odd row from failing a whole report.
 */
export const toScaledInteger = (value: DecimalInput, scale: number = MONEY_SCALE): bigint => {
  const text = rawText(value);
  if (!PLAIN_DECIMAL.test(text)) return 0n;

  const negative = text.startsWith('-');
  const digits = negative ? text.slice(1) : text;
  const separator = digits.indexOf('.');
  const integerPart = separator === -1 ? digits : digits.slice(0, separator);
  const fractionPart = separator === -1 ? '' : digits.slice(separator + 1);

  const kept = fractionPart.slice(0, scale).padEnd(scale, '0');
  let scaled = BigInt(`${integerPart}${kept}`);
  if (fractionPart.length > scale && fractionPart.charCodeAt(scale) >= DIGIT_FIVE) scaled += 1n;

  return negative ? -scaled : scaled;
};

/** Renders an integer number of smallest units back as a fixed-scale string. */
export const fromScaledInteger = (value: bigint, scale: number = MONEY_SCALE): string => {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
  const cut = digits.length - scale;
  const text = scale === 0 ? digits : `${digits.slice(0, cut)}.${digits.slice(cut)}`;
  return negative ? `-${text}` : text;
};

/** Normalises any decimal input to a fixed-scale string, for example `1234.50`. */
export const formatDecimal = (value: DecimalInput, scale: number = MONEY_SCALE): string =>
  fromScaledInteger(toScaledInteger(value, scale), scale);

/**
 * Averages a decimal total over a count, rounding half away from zero. A zero
 * count yields a zero string rather than a division by zero.
 */
export const averageDecimal = (
  total: DecimalInput,
  count: number,
  scale: number = MONEY_SCALE,
): string => {
  if (!Number.isFinite(count) || count <= 0) return fromScaledInteger(0n, scale);
  const scaled = toScaledInteger(total, scale);
  const divisor = BigInt(Math.trunc(count));
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const rounded = (magnitude * 2n + divisor) / (divisor * 2n);
  return fromScaledInteger(negative ? -rounded : rounded, scale);
};

/** Sums decimal inputs without ever leaving exact integer arithmetic. */
export const sumDecimals = (values: readonly DecimalInput[], scale: number = MONEY_SCALE): string =>
  fromScaledInteger(
    values.reduce<bigint>((total, value) => total + toScaledInteger(value, scale), 0n),
    scale,
  );

/** Orders two decimal values without converting either to a float. */
export const compareDecimals = (
  left: DecimalInput,
  right: DecimalInput,
  scale: number = MONEY_SCALE,
): number => {
  const a = toScaledInteger(left, scale);
  const b = toScaledInteger(right, scale);
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

/**
 * Ratio between two counts, rounded to four decimal places. This is a rate, not
 * money, so a plain number is the right shape. A zero denominator yields 0
 * instead of NaN or Infinity.
 */
export const ratio = (numerator: number, denominator: number): number => {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
};
