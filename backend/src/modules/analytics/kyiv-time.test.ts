import { describe, expect, it } from '@jest/globals';

import {
  DEFAULT_KYIV_WINDOW_FROM,
  defaultKyivWindowTo,
  kyivMidnight,
  kyivWallClockToInstant,
  nextKyivMidnight,
} from './kyiv-time.js';

const at = (wallClock: string): string =>
  new Date(kyivWallClockToInstant(Date.parse(`${wallClock}Z`))).toISOString();

describe('the Kyiv calendar of the reports', () => {
  it('starts a winter day at 22:00 UTC and a summer day at 21:00 UTC', () => {
    expect(kyivMidnight(2026, 2, 11).toISOString()).toBe('2026-03-10T22:00:00.000Z');
    expect(kyivMidnight(2026, 6, 11).toISOString()).toBe('2026-07-10T21:00:00.000Z');
  });

  it('starts the default window at Kyiv midnight of 1 January 2026', () => {
    expect(DEFAULT_KYIV_WINDOW_FROM).toBe('2025-12-31T22:00:00.000Z');
  });

  // The order placed at 00:30 in Kyiv is already "today" there, although UTC
  // is still on the day before: today ends at the next Kyiv midnight.
  it('ends today at the next Kyiv midnight, not at the next UTC one', () => {
    const halfPastMidnight = Date.parse('2026-03-10T22:30:00.000Z');
    expect(nextKyivMidnight(halfPastMidnight)).toBe('2026-03-11T22:00:00.000Z');
    expect(nextKyivMidnight(Date.parse('2026-03-10T21:59:59.999Z'))).toBe(
      '2026-03-10T22:00:00.000Z',
    );
    expect(defaultKyivWindowTo(Date.parse('2026-07-10T21:00:00.000Z'))).toBe(
      '2026-07-11T21:00:00.000Z',
    );
  });

  it('spans the days of a clock change at their real length', () => {
    expect(nextKyivMidnight(Date.parse('2026-03-29T12:00:00.000Z'))).toBe(
      '2026-03-29T21:00:00.000Z',
    );
    expect(nextKyivMidnight(Date.parse('2026-10-25T12:00:00.000Z'))).toBe(
      '2026-10-25T22:00:00.000Z',
    );
  });

  // The sibling backend reads Kyiv through `zoneinfo` with `fold=0`; these
  // are the two readings that rule decides, and both backends decide them the
  // same way: the offset in force before the clocks moved.
  it('reads a skipped or repeated hour with the offset before the change', () => {
    // 03:30 on 29 March never happens in Kyiv: the clocks jump 03:00 → 04:00.
    expect(at('2026-03-29T03:30:00.000')).toBe('2026-03-29T01:30:00.000Z');
    // 03:30 on 25 October happens twice; the first time is still summer time.
    expect(at('2026-10-25T03:30:00.000')).toBe('2026-10-25T00:30:00.000Z');
    // Clear of the change on either side, the offset of the moment applies.
    expect(at('2026-03-29T05:00:00.000')).toBe('2026-03-29T02:00:00.000Z');
    expect(at('2026-10-25T05:00:00.000')).toBe('2026-10-25T03:00:00.000Z');
    expect(at('2026-03-28T23:00:00.000')).toBe('2026-03-28T21:00:00.000Z');
  });
});
